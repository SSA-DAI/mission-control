/**
 * PLATFORM-010 (BUG-2) — Planning completion handler.
 *
 * Extracted from the poll route so it can be (a) reused by the route without
 * breaking Next.js Route export validation (route files only allow HTTP-method
 * exports) and (b) regression-tested against a scratch DB.
 *
 * Behavior (BUG-2 fix): the completion transaction clears any stale
 * `planning_dispatch_error` (planning_dispatch_error = NULL) and sets
 * `planning_complete = 1` BEFORE any new dispatch error is reported — a stale
 * auto-answer error never blocks a newly-arrived completion.
 */

import { queryOne, run, getDb, queryAll } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { getSessionKeyPrefix, resolveAgentSessionPrefix } from '@/lib/agent-prefix';
import { Task } from '@/lib/types';

// Helper to handle planning completion with proper error handling
export async function handlePlanningCompletion(taskId: string, parsed: any, messages: any[]) {
  const db = getDb();
  let dispatchError: string | null = null;
  let firstAgentId: string | null = null;
  const unresolvedAgents: string[] = [];

  // Transaction 1: Save planning data, create agents, AND assign agent to task
  // (Assigning before dispatch fixes the chicken-and-egg bug where dispatch
  // checks assigned_agent_id and fails because it wasn't set yet)
  const transaction = db.transaction(() => {
    const allowDynamicAgents = process.env.ALLOW_DYNAMIC_AGENTS !== 'false';

    if (allowDynamicAgents && parsed.agents && parsed.agents.length > 0) {
      // PLATFORM-002 + PLATFORM-007: resolve each spec agent's gateway session
      // prefix individually. Workspace-aware canonical resolution first (002),
      // then role-based prefix mapping (007 finding #4) so dynamic agents get
      // their own role namespace instead of mixing into the master's directory.
      const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(taskId) as { workspace_id: string } | undefined;

      const insertAgent = db.prepare(`
        INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, soul_md, session_key_prefix, created_at, updated_at)
        VALUES (?, (SELECT workspace_id FROM tasks WHERE id = ?), ?, ?, ?, ?, 'standby', ?, ?, datetime('now'), datetime('now'))
      `);

      for (const agent of parsed.agents) {
        const agentId = crypto.randomUUID();
        if (!firstAgentId) firstAgentId = agentId;

        const prefix = resolveAgentSessionPrefix(task?.workspace_id, agent.name) || getSessionKeyPrefix(agent.role);
        if (!prefix) {
          unresolvedAgents.push(`${agent.name} (${agent.role})`);
          console.warn(`[Planning Poll] No gateway session prefix for planning agent "${agent.name}" (workspace ${task?.workspace_id ?? 'unknown'} has no master agent and no canonical gateway agent matches)`);
        }

        insertAgent.run(
          agentId,
          taskId,
          agent.name,
          agent.role,
          agent.instructions || '',
          agent.avatar_emoji || '🤖',
          agent.soul_md || '',
          prefix
        );
      }
    } else if (!allowDynamicAgents && parsed.agents && parsed.agents.length > 0) {
      console.log(`[Planning Poll] Dynamic agent generation disabled (ALLOW_DYNAMIC_AGENTS=false), skipping creation of ${parsed.agents.length} agent(s)`);
    }

    // Save planning data + assign the first agent + mark complete in one atomic step.
    // planning_dispatch_error is cleared here (BUG-2): a stale error from a
    // previous failed auto-answer must not survive a successful completion.
    db.prepare(`
      UPDATE tasks
      SET planning_messages = ?,
          planning_spec = ?,
          planning_agents = ?,
          planning_complete = 1,
          assigned_agent_id = ?,
          status = 'assigned',
          planning_dispatch_error = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(messages),
      JSON.stringify(parsed.spec),
      JSON.stringify(parsed.agents),
      firstAgentId,
      taskId
    );

    return firstAgentId;
  });

  firstAgentId = transaction();

  // PLATFORM-002: if any planning agent has no resolvable gateway prefix, fail
  // loudly instead of dispatching to the non-existent 'agent:main:' agent.
  if (unresolvedAgents.length > 0) {
    dispatchError = `Cannot resolve gateway session prefix for planning agent(s): ${unresolvedAgents.join('; ')} — workspace has no master agent and no canonical gateway agent matches. Assign a canonical agent (manager/builder/tester/reviewer/learner) manually, then retry dispatch.`;
    console.error(`[Planning Poll] ${dispatchError}`);
  }

  // Re-check for other orchestrators before dispatching
  if (firstAgentId) {
    const task = queryOne<{ workspace_id: string }>('SELECT workspace_id FROM tasks WHERE id = ?', [taskId]);
    if (task) {
      const defaultMaster = queryOne<{ id: string }>(
        `SELECT id FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
        [task.workspace_id]
      );
      const otherOrchestrators = queryAll<{ id: string; name: string }>(
        `SELECT id, name FROM agents WHERE is_master = 1 AND id != ? AND workspace_id = ? AND status != 'offline'`,
        [defaultMaster?.id ?? '', task.workspace_id]
      );

      if (otherOrchestrators.length > 0) {
        dispatchError = `Cannot auto-dispatch: ${otherOrchestrators.length} other orchestrator(s) available in workspace`;
        console.warn(`[Planning Poll] ${dispatchError}:`, otherOrchestrators.map(o => o.name).join(', '));
        firstAgentId = null;
      }
    }
  }

  // Idempotency check — only skip dispatch if the agent has actually started working.
  // A task stuck in 'in_progress' with no recent activity means a prior dispatch was
  // silently lost (e.g. broken WebSocket) and MUST be retried.
  let skipDispatch = false;
  if (firstAgentId) {
    const currentTask = queryOne<{ status: string; updated_at: string }>('SELECT status, updated_at FROM tasks WHERE id = ?', [taskId]);
    if (currentTask?.status === 'in_progress') {
      // Check for any agent activity since dispatch — if none, allow re-dispatch
      const recentActivity = queryOne<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM task_activities WHERE task_id = ? AND created_at > datetime('now', '-2 minutes')`,
        [taskId]
      );
      if (recentActivity && recentActivity.cnt > 0) {
        console.log('[Planning Poll] Task in progress with recent agent activity, skipping dispatch');
        skipDispatch = true;
      } else {
        console.log('[Planning Poll] Task in_progress but no recent agent activity — retrying dispatch (likely lost message)');
        // Reset to assigned so dispatch can proceed cleanly
        run('UPDATE tasks SET status = ?, updated_at = datetime(\'now\') WHERE id = ?', ['assigned', taskId]);
      }
    }
  }

  // Trigger dispatch using proper URL resolution
  if (firstAgentId && !skipDispatch && !dispatchError) {
    const missionControlUrl = getMissionControlUrl();
    const dispatchUrl = `${missionControlUrl}/api/tasks/${taskId}/dispatch`;
    console.log(`[Planning Poll] Triggering dispatch: ${dispatchUrl}`);

    try {
      const dispatchHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (process.env.MC_API_TOKEN) {
        dispatchHeaders['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
      }

      const dispatchRes = await fetch(dispatchUrl, {
        method: 'POST',
        headers: dispatchHeaders,
        signal: AbortSignal.timeout(30_000),
      });

      if (dispatchRes.ok) {
        console.log(`[Planning Poll] Dispatch successful`);
      } else {
        const errorText = await dispatchRes.text();
        dispatchError = `Dispatch failed (${dispatchRes.status}): ${errorText}`;
        console.error(`[Planning Poll] ${dispatchError}`);
      }
    } catch (err) {
      dispatchError = `Dispatch error: ${(err as Error).message}`;
      console.error(`[Planning Poll] ${dispatchError}`);
    }
  }

  // On dispatch failure: keep planning data intact, just record the error.
  // Task stays in 'assigned' so user can retry dispatch without re-planning.
  if (dispatchError) {
    run(
      `UPDATE tasks SET planning_dispatch_error = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?`,
      [dispatchError, 'Dispatch failed: ' + dispatchError, taskId]
    );
    console.log(`[Planning Poll] Dispatch failed for task ${taskId}, planning data preserved: ${dispatchError}`);
  } else if (!firstAgentId) {
    // No agent created — move to inbox for manual assignment
    run(
      `UPDATE tasks SET status = 'inbox', planning_dispatch_error = NULL, updated_at = datetime('now') WHERE id = ?`,
      [taskId]
    );
  }

  // Broadcast task update
  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }

  return { firstAgentId, parsed, dispatchError };
}
