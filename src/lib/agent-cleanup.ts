/**
 * PLATFORM-017 — Planning-agent cleanup (polutan agent).
 *
 * Two-phase auto-cleanup for agents created by a planning cycle but never
 * actually dispatched:
 *
 *  PHASE 1 — Marking (planning completion / dispatch time):
 *    `markPlanningAgents()` stamps every resolved planning-agent spec with
 *    `status: 'dispatched'` (the agent the pipeline picked) or
 *    `status: 'skipped'` + `skipped_reason` (the rest). The enriched specs are
 *    persisted in the task's `planning_agents` JSON column.
 *
 *  PHASE 2 — Cleanup (task done hook):
 *    `runPlanningAgentCleanup(taskId)` reads the task's planning_agents, and
 *    deletes every agent whose spec is marked `skipped` — unless a guard
 *    protects it:
 *      (a) canonical role (builder/tester/reviewer/verifier/learner),
 *      (b) tagged with a planning_cycle_task_id of a DIFFERENT cycle,
 *      (c) ever assigned to another task (tasks.assigned_agent_id or
 *          task_roles of a different task).
 *    Deletion is idempotent (agent already gone → warn, no error) and gated by
 *    config `cleanup_on_done` (env CLEANUP_ON_DONE, default true).
 *
 * Scope: current planning cycle only. Historical orphan cleanup is a separate
 * follow-up task.
 */

import { queryOne, run } from '@/lib/db';
import { CANONICAL_ROLES } from '@/lib/canonical-agents';
import type { Agent, PlanningAgentSpec } from '@/lib/types';

/** Reason stamped on every non-dispatched planning agent spec. */
export const SKIPPED_REASON = 'not_dispatched_in_cycle';

/** Role values treated as canonical — never auto-deleted. */
export const CANONICAL_ROLE_SET = new Set<string>(CANONICAL_ROLES);

export interface CleanupResult {
  /** Agent ids actually deleted by this run. */
  deleted: string[];
  /** Agent ids evaluated but protected by a guard (canonical/other-cycle/assigned elsewhere). */
  protected: Array<{ agentId: string; reason: string }>;
  /** Agent ids skipped because the agent row no longer exists (idempotent no-op). */
  alreadyGone: string[];
  /** True when the cleanup_on_done config gate disabled deletion entirely. */
  configDisabled: boolean;
  /** True when the task had no planning_agents to inspect. */
  noSpecs: boolean;
}

/**
 * Config gate for the deletion phase. `cleanup_on_done` defaults to TRUE.
 * Set env CLEANUP_ON_DONE=false to keep agents around for debugging — marking
 * in planning_agents still happens, only the deletion is skipped.
 */
export function cleanupOnDoneEnabled(): boolean {
  return process.env.CLEANUP_ON_DONE !== 'false';
}

/**
 * PHASE 1 — Mark every resolved planning-agent spec with its dispatch fate.
 *
 * Pure function (no DB access) so it is trivially unit-testable. The spec
 * whose `agent_id` equals the dispatched agent id is marked `dispatched`;
 * every other spec that has a resolved agent id is marked `skipped` with
 * `skipped_reason = 'not_dispatched_in_cycle'`. Specs without an agent_id
 * (unresolvable/deduped) are left untouched — there is no agent to clean up.
 */
export function markPlanningAgents(
  agents: PlanningAgentSpec[],
  dispatchedAgentId: string | null
): PlanningAgentSpec[] {
  return (agents || []).map((spec) => {
    if (!spec.agent_id) return { ...spec };
    if (dispatchedAgentId && spec.agent_id === dispatchedAgentId) {
      return { ...spec, status: 'dispatched', skipped_reason: undefined };
    }
    return { ...spec, status: 'skipped', skipped_reason: SKIPPED_REASON };
  });
}

/**
 * Delete an agent and its dependent rows — the same cascade the
 * DELETE /api/agents/[id] route performs, plus task_roles rows for the
 * current task (required by the FK `task_roles.agent_id → agents.id` when the
 * cleanup removes a custom agent the workflow had populated into roles).
 *
 * `currentTaskId` scopes the task_roles cleanup: rows referencing the agent
 * for OTHER tasks are never touched here — those tasks are protected by the
 * cleanup guards instead.
 */
export function deleteAgentCascade(agentId: string, currentTaskId?: string): void {
  run('DELETE FROM openclaw_sessions WHERE agent_id = ?', [agentId]);
  run('DELETE FROM events WHERE agent_id = ?', [agentId]);
  run('DELETE FROM messages WHERE sender_agent_id = ?', [agentId]);
  run('DELETE FROM conversation_participants WHERE agent_id = ?', [agentId]);
  run('UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?', [agentId]);
  run('UPDATE tasks SET created_by_agent_id = NULL WHERE created_by_agent_id = ?', [agentId]);
  run('UPDATE task_activities SET agent_id = NULL WHERE agent_id = ?', [agentId]);

  // FK safety: the current task's role slots referencing this agent belong to
  // a task that is already done — safe to release. Other tasks' rows are left
  // untouched (guards in runPlanningAgentCleanup prevent deleting agents that
  // appear in other tasks' roles).
  if (currentTaskId) {
    run('DELETE FROM task_roles WHERE agent_id = ? AND task_id = ?', [agentId, currentTaskId]);
  }

  run('DELETE FROM agents WHERE id = ?', [agentId]);
}

interface GuardContext {
  agent: Agent;
  agentId: string;
  taskId: string;
}

/**
 * Guard check — may this agent be deleted by the current task's cleanup?
 * Returns a reason string when the agent is protected, null when deletable.
 */
export function guardReasonForAgent(ctx: GuardContext): string | null {
  // (a) Canonical role → protected. Canonical agents are reused across cycles;
  // a skipped marking in one cycle must never remove the shared agent.
  if (CANONICAL_ROLE_SET.has((ctx.agent.role || '').trim().toLowerCase())) {
    return `canonical_role:${ctx.agent.role}`;
  }

  // (b) Metadata tag pointing at a different planning cycle → protected.
  // Belt-and-suspenders: cleanup only looks at THIS task's planning_agents, so
  // cross-cycle agents can only appear here if the tag disagrees with the task.
  if (ctx.agent.planning_cycle_task_id && ctx.agent.planning_cycle_task_id !== ctx.taskId) {
    return `other_cycle:${ctx.agent.planning_cycle_task_id}`;
  }

  // (b2) Currently assigned to THIS task → protected. The dispatch marking is
  // written at planning completion; a later manual reassignment can make a
  // marked-skipped agent the task's actual assignee. Deleting it would remove
  // the very agent the task ran on.
  const assignedHere = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM tasks WHERE assigned_agent_id = ? AND id = ?`,
    [ctx.agentId, ctx.taskId]
  );
  if (assignedHere && assignedHere.cnt > 0) {
    return 'assigned_to_current_task';
  }

  // (b3) Referenced by a role of THIS task (workflow stage) → protected.
  const roleHere = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM task_roles WHERE agent_id = ? AND task_id = ?`,
    [ctx.agentId, ctx.taskId]
  );
  if (roleHere && roleHere.cnt > 0) {
    return 'role_in_current_task';
  }

  // (c) Ever assigned to another task → protected. Covers both the task
  // assignee column and workflow stage roles (task_roles).
  const assignedElsewhere = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM tasks WHERE assigned_agent_id = ? AND id != ?`,
    [ctx.agentId, ctx.taskId]
  );
  if (assignedElsewhere && assignedElsewhere.cnt > 0) {
    return 'assigned_to_other_task';
  }

  const roleElsewhere = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM task_roles WHERE agent_id = ? AND task_id != ?`,
    [ctx.agentId, ctx.taskId]
  );
  if (roleElsewhere && roleElsewhere.cnt > 0) {
    return 'role_in_other_task';
  }

  return null;
}

/**
 * PHASE 2 — Cleanup hook for the task-done transition.
 *
 * Deletes planning-cycle agents marked `skipped` that pass all guards.
 * Idempotent: an agent that is already gone logs a warning and is skipped
 * without throwing. When `cleanup_on_done` is disabled (CLEANUP_ON_DONE=false)
 * deletion is skipped entirely — marking remains intact for debugging.
 *
 * `opts.deleteAgent` is injectable for tests that mock the deletion (defaults
 * to the real cascade delete). The injectable signature matches
 * `deleteAgentCascade(agentId, currentTaskId?)`.
 */
export function runPlanningAgentCleanup(
  taskId: string,
  opts?: { deleteAgent?: (agentId: string, taskId?: string) => void }
): CleanupResult {
  const result: CleanupResult = {
    deleted: [],
    protected: [],
    alreadyGone: [],
    configDisabled: false,
    noSpecs: false,
  };

  const task = queryOne<{ planning_agents?: string | null }>(
    'SELECT planning_agents FROM tasks WHERE id = ?',
    [taskId]
  );
  if (!task || !task.planning_agents) {
    result.noSpecs = true;
    return result;
  }

  let specs: PlanningAgentSpec[] = [];
  try {
    specs = JSON.parse(task.planning_agents) as PlanningAgentSpec[];
  } catch (err) {
    console.warn(`[Agent Cleanup] Task ${taskId}: planning_agents is not valid JSON — skipping cleanup`, (err as Error).message);
    result.noSpecs = true;
    return result;
  }

  const skipped = specs.filter((s) => s.agent_id && s.status === 'skipped');
  if (skipped.length === 0) return result;

  if (!cleanupOnDoneEnabled()) {
    result.configDisabled = true;
    console.log(
      `[Agent Cleanup] Task ${taskId}: cleanup_on_done=false — ${skipped.length} skipped agent(s) kept (marking preserved): ${skipped.map((s) => s.agent_id).join(', ')}`
    );
    return result;
  }

  const deleteAgent = opts?.deleteAgent ?? deleteAgentCascade;

  for (const spec of skipped) {
    const agentId = spec.agent_id!;
    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);

    // Idempotency: already deleted (e.g. manual cleanup or a previous hook run).
    if (!agent) {
      console.warn(`[Agent Cleanup] Task ${taskId}: agent ${agentId} ("${spec.name ?? 'unknown'}") already deleted — no-op`);
      result.alreadyGone.push(agentId);
      continue;
    }

    const guardReason = guardReasonForAgent({ agent, agentId, taskId });
    if (guardReason) {
      console.log(`[Agent Cleanup] Task ${taskId}: protecting agent ${agentId} ("${agent.name}", ${agent.role}) — ${guardReason}`);
      result.protected.push({ agentId, reason: guardReason });
      continue;
    }

    deleteAgent(agentId, taskId);
    result.deleted.push(agentId);
    console.log(`[Agent Cleanup] Task ${taskId}: deleted unused planning agent ${agentId} ("${agent.name}")`);
  }

  return result;
}
