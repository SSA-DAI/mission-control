import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { extractJSON, isTruncatedContent } from '@/lib/planning-utils';
import { resolveAgentSessionPrefix } from '@/lib/agent-prefix';
import { mapRoleToCanonical, ensureCanonicalAgent, type CanonicalRole } from '@/lib/canonical-agents';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { v4 as uuidv4 } from 'uuid';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/tasks/[id]/planning/force-complete
 * 
 * Force-completes a stuck planning session by scanning stored messages
 * for the completion JSON and triggering dispatch. Used when the normal
 * poll loop fails to detect completion (race condition).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: taskId } = await params;

    const task = queryOne<{
      id: string;
      title: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_session_key?: string;
      workspace_id: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (task.planning_complete) {
      return NextResponse.json({ error: 'Planning is already complete' }, { status: 400 });
    }

    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    
    // Scan messages from the end looking for the completion JSON
    let completionParsed: any = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        const parsed = extractJSON(messages[i].content);
        if (parsed && (parsed as any).status === 'complete') {
          completionParsed = parsed;
          break;
        }
      }
    }

    if (!completionParsed) {
      // PLATFORM-001: never complete without a spec — keep state intact and explain loudly.
      const lastMsg = [...messages].reverse().find((m: any) => m.role === 'assistant');
      const truncated = lastMsg ? isTruncatedContent(lastMsg.content) : false;
      const reason = truncated
        ? 'Completion message is truncated/invalid JSON — state preserved. Ask the planning agent to resend a compact completion, or cancel planning (DELETE /planning) and restart.'
        : 'No completion spec found in stored messages — state preserved. Review the planning conversation, or cancel (DELETE /planning) and restart.';
      console.warn(`[Force Complete] ${reason} (task ${taskId})`);
      return NextResponse.json({
        error: reason,
        truncated,
        planningComplete: false,
        preserved: true,
      }, { status: 409 });
    }

    // Found completion JSON — create agents, save spec, dispatch
    console.log(`[Force Complete] Found completion JSON for task ${taskId} — processing`);

    // PLATFORM-005: ALLOW_DYNAMIC_AGENTS defaults to false.
    // When true (opt-in for backward compat), per-spec agents are created.
    // When false (default), planning spec is mapped to canonical roles and
    // existing canonical agents are reused (create-once per workspace).
    const allowDynamicAgents = process.env.ALLOW_DYNAMIC_AGENTS === 'true';
    let firstAgentId: string | null = null;
    const unresolvedAgents: string[] = [];
    const createdCanonicalRoles = new Set<string>();

    if (completionParsed.agents?.length > 0) {
      if (allowDynamicAgents) {
        // Legacy dynamic mode: create a new agent per spec entry
        for (const agent of completionParsed.agents) {
          const agentId = crypto.randomUUID();
          if (!firstAgentId) firstAgentId = agentId;

          const prefix = resolveAgentSessionPrefix(task.workspace_id, agent.name);
          if (!prefix) {
            unresolvedAgents.push(`${agent.name} (${agent.role})`);
            console.warn(`[Force Complete] No gateway session prefix for planning agent "${agent.name}"`);
          }

          run(
            `INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, soul_md, session_key_prefix, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'standby', ?, ?, datetime('now'), datetime('now'))`,
            [agentId, task.workspace_id, agent.name, agent.role, agent.instructions || '', agent.avatar_emoji || '🤖', agent.soul_md || '', prefix]
          );
        }
      } else {
        // PLATFORM-005 canonical mode: map each planning agent to a canonical role
        // and ensure the canonical agent exists in this workspace (create-once).
        const seenRoles = new Set<CanonicalRole>();
        for (const agent of completionParsed.agents) {
          const canonicalRole = mapRoleToCanonical(agent.role || agent.name || '');
          if (!canonicalRole) continue;
          if (seenRoles.has(canonicalRole)) continue; // dedupe same role
          seenRoles.add(canonicalRole);

          try {
            const canonicalId = ensureCanonicalAgent(task.workspace_id, canonicalRole);
            if (!firstAgentId) firstAgentId = canonicalId;
            createdCanonicalRoles.add(canonicalRole);
            console.log(`[Force Complete] Using canonical ${canonicalRole} agent ${canonicalId} for task ${taskId}`);
          } catch (err) {
            console.error(`[Force Complete] Failed to ensure canonical ${canonicalRole} agent:`, err);
          }
        }
      }
    }

    // Update task — PLATFORM-014: auto_restart_count resets on successful completion.
    run(
      `UPDATE tasks SET 
         planning_complete = 1,
         planning_spec = ?,
         planning_agents = ?,
         assigned_agent_id = ?,
         status = 'assigned',
         planning_dispatch_error = NULL,
         auto_restart_count = 0,
         status_reason = 'Force-completed by user',
         updated_at = datetime('now')
       WHERE id = ?`,
      [
        JSON.stringify(completionParsed.spec || {}),
        JSON.stringify(completionParsed.agents || []),
        firstAgentId,
        taskId,
      ]
    );

    // Log the force-complete
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, 'status_changed', 'Planning force-completed by user — dispatching', datetime('now'))`,
      [uuidv4(), taskId, firstAgentId]
    );

    // Dispatch
    let dispatched = false;
    let dispatchError: string | null = null;

    // PLATFORM-002: fail loudly when a planning agent has no resolvable prefix
    if (unresolvedAgents.length > 0) {
      dispatchError = `Cannot resolve gateway session prefix for planning agent(s): ${unresolvedAgents.join('; ')} — workspace has no master agent and no canonical gateway agent matches. Assign a canonical agent (manager/builder/tester/reviewer/learner) manually, then retry dispatch.`;
      console.error(`[Force Complete] ${dispatchError}`);
      run(
        `UPDATE tasks SET planning_dispatch_error = ?, updated_at = datetime('now') WHERE id = ?`,
        [dispatchError, taskId]
      );
    }

    if (firstAgentId && !dispatchError) {
      const missionControlUrl = getMissionControlUrl();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (process.env.MC_API_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
      }

      try {
        const res = await fetch(`${missionControlUrl}/api/tasks/${taskId}/dispatch`, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(30_000),
        });

        if (res.ok) {
          dispatched = true;
          console.log(`[Force Complete] Dispatch successful for task ${taskId}`);
        } else {
          dispatchError = await res.text();
          console.error(`[Force Complete] Dispatch failed: ${dispatchError}`);
          run(
            `UPDATE tasks SET planning_dispatch_error = ?, updated_at = datetime('now') WHERE id = ?`,
            [`Force-complete dispatch failed: ${dispatchError.substring(0, 200)}`, taskId]
          );
        }
      } catch (err) {
        dispatchError = (err as Error).message;
        console.error(`[Force Complete] Dispatch error: ${dispatchError}`);
      }
    }

    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

    const canonicalRolesList = Array.from(createdCanonicalRoles);
    const canonicalInfo = !allowDynamicAgents && canonicalRolesList.length > 0
      ? ` (canonical roles: ${canonicalRolesList.join(', ')})`
      : '';

    return NextResponse.json({
      success: true,
      message: dispatched
        ? `Planning force-completed and task dispatched.${canonicalInfo}`
        : dispatchError
          ? `Planning force-completed but dispatch failed: ${dispatchError}${canonicalInfo}`
          : `Planning force-completed. Task moved to assigned.${canonicalInfo}`,
      dispatched,
      dispatchError,
      canonical_roles: canonicalRolesList,
      dynamic_mode: allowDynamicAgents,
    });
  } catch (error) {
    console.error('[Force Complete] Error:', error);
    return NextResponse.json({ error: 'Failed to force-complete planning' }, { status: 500 });
  }
}
