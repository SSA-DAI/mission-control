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
import { resolvePlanningAgent, type CanonicalRole } from '@/lib/canonical-agents';
import { populateTaskRolesFromAgents } from '@/lib/workflow-engine';
import { markPlanningAgents } from '@/lib/agent-cleanup';
import { Task, type PlanningAgentSpec } from '@/lib/types';

// Helper to handle planning completion with proper error handling
export async function handlePlanningCompletion(
  taskId: string,
  parsed: any,
  messages: any[],
  opts?: { sessionKey?: string }
) {
  const db = getDb();
  let dispatchError: string | null = null;
  let firstAgentId: string | null = null;
  const unresolvedAgents: string[] = [];

  // Transaction 1: Save planning data, create agents, AND assign agent to task
  // (Assigning before dispatch fixes the chicken-and-egg bug where dispatch
  // checks assigned_agent_id and fails because it wasn't set yet)
  const transaction = db.transaction((): { skipped: boolean; firstAgentId: string | null } => {
    // PLATFORM-014 race guard: refuse to complete a session that was
    // cancelled/restarted while the completion was in flight. The watchdog
    // claims the task (clears the session key, bumps the restart counter) in
    // its own transaction, so re-checking here makes completion atomic with
    // respect to stall handling:
    //  - planning_complete=1 already → idempotent, skip
    //  - status='menunggu_keputusan_manusia' → cancelled after repeated stalls, skip
    //  - session key missing or different → the session was cancelled/restarted, skip
    const current = db.prepare(
      'SELECT status, planning_complete, planning_session_key FROM tasks WHERE id = ?'
    ).get(taskId) as { status?: string; planning_complete?: number; planning_session_key?: string | null } | undefined;

    if (!current || current.planning_complete === 1) {
      console.log(`[Planning Completion] Task ${taskId} already complete — skipping (idempotent)`);
      return { skipped: true, firstAgentId: null };
    }
    if (current.status === 'menunggu_keputusan_manusia' || !current.planning_session_key) {
      console.warn(`[Planning Completion] Task ${taskId} was cancelled/restarted by the watchdog — stale completion ignored`);
      return { skipped: true, firstAgentId: null };
    }
    if (opts?.sessionKey && current.planning_session_key !== opts.sessionKey) {
      console.warn(`[Planning Completion] Task ${taskId} session changed (${current.planning_session_key} != ${opts.sessionKey}) — stale completion ignored`);
      return { skipped: true, firstAgentId: null };
    }

    const allowDynamicAgents = process.env.ALLOW_DYNAMIC_AGENTS !== 'false';

    // PLATFORM-017: per-spec resolved agent ids (enriched before persisting
    // planning_agents) — the dispatch marking needs every spec's agent_id, not
    // just the first one. Specs that fail to resolve keep their raw fields
    // without agent_id (nothing to clean up for them).
    const resolvedSpecs: PlanningAgentSpec[] = ((parsed.agents as PlanningAgentSpec[] | undefined) ?? []).map((a) => ({ ...a }));

    if (allowDynamicAgents && parsed.agents && parsed.agents.length > 0) {
      // PLATFORM-012: canonical-first agent resolution via shared
      // resolvePlanningAgent(). Canonical roles (builder/tester/reviewer/
      // verifier/learner) reuse existing agents; only non-canonical roles
      // create new custom agents (ALLOW_DYNAMIC_AGENTS guard). Dedup prevents
      // duplicate canonical lookups within a single planning cycle.
      const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(taskId) as { workspace_id: string } | undefined;
      const seenRoles = new Set<CanonicalRole>();

      const insertAgent = db.prepare(`
        INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, soul_md, session_key_prefix, planning_cycle_task_id, created_at, updated_at)
        VALUES (?, (SELECT workspace_id FROM tasks WHERE id = ?), ?, ?, ?, ?, 'standby', ?, ?, ?, datetime('now'), datetime('now'))
      `);

      for (let i = 0; i < parsed.agents.length; i++) {
        const agent = parsed.agents[i];
        const resolved = resolvePlanningAgent(
          task?.workspace_id ?? null,
          agent,
          true, // allowDynamic already gated above
          seenRoles
        );

        if (!resolved) continue; // dedup or unresolvable
        resolvedSpecs[i].agent_id = resolved.agentId;

        if (resolved.isCanonical) {
          // Canonical agent already exists in DB — reuse its ID, no INSERT
          if (!firstAgentId) firstAgentId = resolved.agentId;
          console.log(`[Planning Poll] Reusing canonical agent ${resolved.agentId} for role "${agent.role}"`);
        } else {
          // Custom non-canonical agent — must INSERT
          if (!firstAgentId) firstAgentId = resolved.agentId;

          if (!resolved.prefix) {
            unresolvedAgents.push(`${agent.name} (${agent.role})`);
            console.warn(`[Planning Poll] No gateway session prefix for custom agent "${agent.name}" (workspace ${task?.workspace_id ?? 'unknown'})`);
          }

          insertAgent.run(
            resolved.agentId,
            taskId,
            agent.name,
            agent.role,
            agent.instructions || '',
            agent.avatar_emoji || '🤖',
            agent.soul_md || '',
            resolved.prefix,
            taskId // PLATFORM-017: planning_cycle_task_id metadata tag
          );
        }
      }
    } else if (!allowDynamicAgents && parsed.agents && parsed.agents.length > 0) {
      console.log(`[Planning Poll] Dynamic agent generation disabled (ALLOW_DYNAMIC_AGENTS=false), skipping creation of ${parsed.agents.length} agent(s)`);
    }

    // PLATFORM-017: persist the ENRICHED planning_agents — every spec carries
    // its resolved agent_id plus dispatch marking (dispatched/skipped). Tasks
    // created before this change keep their raw specs (no agent_id/status) and
    // are simply ignored by the cleanup hook.
    const enrichedPlanningAgents = markPlanningAgents(resolvedSpecs, firstAgentId);

    // Save planning data + assign the first agent + mark complete in one atomic step.
    // planning_dispatch_error is cleared here (BUG-2): a stale error from a
    // previous failed auto-answer must not survive a successful completion.
    // PLATFORM-014: auto_restart_count resets on successful completion.
    db.prepare(`
      UPDATE tasks
      SET planning_messages = ?,
          planning_spec = ?,
          planning_agents = ?,
          planning_complete = 1,
          assigned_agent_id = ?,
          status = 'assigned',
          planning_dispatch_error = NULL,
          auto_restart_count = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(messages),
      JSON.stringify(parsed.spec),
      JSON.stringify(enrichedPlanningAgents),
      firstAgentId,
      taskId
    );

    return { skipped: false, firstAgentId };
  });

  const txResult = transaction();
  if (txResult.skipped) {
    return { firstAgentId: null, parsed, dispatchError: null, skipped: true };
  }
  firstAgentId = txResult.firstAgentId;

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

  // PLATFORM-015: populate task_roles for ALL workflow template stages with the
  // workspace's canonical agents (build/test/review/verify/learn, create-once).
  // This is the root-cause fix: previously task_roles stayed empty after planning
  // complete, so stage transitions fell back to the previous stage's assigned
  // agent (verify ran under the tester). Idempotent — only fills missing roles.
  try {
    const wsTask = queryOne<{ workspace_id: string }>('SELECT workspace_id FROM tasks WHERE id = ?', [taskId]);
    if (wsTask) {
      populateTaskRolesFromAgents(taskId, wsTask.workspace_id);
    }
  } catch (err) {
    console.error('[Planning Completion] populateTaskRolesFromAgents failed:', (err as Error).message);
  }

  return { firstAgentId, parsed, dispatchError, skipped: false };
}
