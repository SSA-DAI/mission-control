/**
 * PLATFORM-017 — Planning-agent cleanup (polutan agent) tests.
 *
 * Covers:
 *  1. markPlanningAgents pure marking (dispatched/skipped + reason)
 *  2. Happy path: planning 2 agents → 1 dispatched (canonical reuse) + 1
 *     skipped (custom) → task done → skipped agent deleted, agent count back
 *     to baseline, dispatched + canonical agents untouched
 *  3. Idempotency: skipped agent already deleted → no-op, warning, no error
 *  4. Config toggle: cleanup_on_done=false → marking preserved, deletion skipped
 *  5. Guards: canonical role / assigned to other task / role in other task /
 *     different planning cycle → agent protected, never deleted
 *  6. Dispatched + legacy (unmarked) specs never deleted
 *  7. deleteAgentCascade removes dependents
 *
 * Runs against the scratch test DB (NODE_ENV=test DATABASE_PATH=.tmp/...)
 * via the `npm test` runner — never against the production DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { run, queryOne, queryAll } from './db';
import { ensureCanonicalAgent } from './canonical-agents';
import { handlePlanningCompletion } from './planning-completion';
import {
  markPlanningAgents,
  runPlanningAgentCleanup,
  deleteAgentCascade,
  SKIPPED_REASON,
  type CleanupResult,
} from './agent-cleanup';
import type { PlanningAgentSpec } from './types';

// ── helpers ─────────────────────────────────────────────────────────────────

const trackedTasks: string[] = [];
const trackedAgents: string[] = [];

function seedTask(opts: {
  status?: string;
  workspaceId?: string;
  planningAgents?: unknown;
  /** Raw string stored verbatim (for invalid-JSON tests). */
  planningAgentsRaw?: string;
  assignedAgentId?: string | null;
}): string {
  const taskId = crypto.randomUUID();
  trackedTasks.push(taskId);
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, planning_session_key, planning_complete, planning_agents, assigned_agent_id, planning_updated_at, created_at, updated_at)
     VALUES (?, 'PLATFORM-017 cleanup test', 'test', ?, ?, NULL, 1, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
    [
      taskId,
      opts.status ?? 'assigned',
      opts.workspaceId ?? 'default',
      opts.planningAgentsRaw ?? (opts.planningAgents === undefined ? null : JSON.stringify(opts.planningAgents)),
      opts.assignedAgentId ?? null,
    ]
  );
  return taskId;
}

function insertAgent(opts: {
  name: string;
  role: string;
  workspaceId?: string;
  tag?: string | null;
}): string {
  const agentId = crypto.randomUUID();
  trackedAgents.push(agentId);
  run(
    `INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, session_key_prefix, planning_cycle_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test agent', '🤖', 'standby', NULL, ?, datetime('now'), datetime('now'))`,
    [agentId, opts.workspaceId ?? 'default', opts.name, opts.role, opts.tag ?? null]
  );
  return agentId;
}

function insertTaskRole(taskId: string, agentId: string, role: string): void {
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
    [crypto.randomUUID(), taskId, role, agentId]
  );
}

function agentCount(workspaceId = 'default'): number {
  return queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM agents WHERE workspace_id = ?', [workspaceId])!.cnt;
}

function getTaskPlanningAgents(taskId: string): PlanningAgentSpec[] {
  const row = queryOne<{ planning_agents: string | null }>('SELECT planning_agents FROM tasks WHERE id = ?', [taskId]);
  return row?.planning_agents ? (JSON.parse(row.planning_agents) as PlanningAgentSpec[]) : [];
}

function getAgent(agentId: string): Record<string, unknown> | undefined {
  return queryOne<Record<string, unknown>>('SELECT * FROM agents WHERE id = ?', [agentId]);
}

// Clean up everything this test file created (other suites' canonical agents in
// the shared scratch DB are left untouched).
test.afterEach(() => {
  for (const taskId of trackedTasks.splice(0)) {
    run('DELETE FROM tasks WHERE id = ?', [taskId]);
  }
  for (const agentId of trackedAgents.splice(0)) {
    run('DELETE FROM agents WHERE id = ?', [agentId]);
  }
});

// ── 1. markPlanningAgents (pure marking) ────────────────────────────────────

test('markPlanningAgents: dispatched + skipped with reason', () => {
  const specs: PlanningAgentSpec[] = [
    { name: 'A', role: 'builder', agent_id: 'aaa' },
    { name: 'B', role: 'janitor', agent_id: 'bbb' },
    { name: 'C', role: 'ghost' }, // no agent_id → never marked
  ];

  const marked = markPlanningAgents(specs, 'aaa');

  assert.equal(marked[0].status, 'dispatched');
  assert.equal(marked[0].skipped_reason, undefined);
  assert.equal(marked[1].status, 'skipped');
  assert.equal(marked[1].skipped_reason, SKIPPED_REASON);
  assert.equal(marked[2].status, undefined, 'spec without agent_id stays unmarked');
  assert.equal(marked[2].agent_id, undefined);
});

test('markPlanningAgents: no dispatched id → everything with agent_id is skipped', () => {
  const marked = markPlanningAgents([{ name: 'A', role: 'x', agent_id: 'aaa' }], null);
  assert.equal(marked[0].status, 'skipped');
  assert.equal(marked[0].skipped_reason, SKIPPED_REASON);
});

// ── 2. Happy path: 2 agents → 1 dispatched, 1 cleaned at done ───────────────

test('happy path: planning 2 agents (canonical + custom) → skipped custom deleted at done, count back to baseline', async () => {
  // Pre-ensure the canonical builder so it is reused (not created) by this
  // cycle — baseline measurement stays stable.
  const builderId = ensureCanonicalAgent('default', 'builder');
  const baseline = agentCount('default');

  const taskId = seedTask({ status: 'planning' });
  // seedTask sets planning_complete=1 — reset to 0 + session key for the
  // completion path to accept this task.
  run(
    `UPDATE tasks SET planning_complete = 0, planning_session_key = ?, status = 'planning' WHERE id = ?`,
    [`agent:main:planning:${taskId}`, taskId]
  );

  const completionSpec = {
    spec: { title: 'P017', summary: 'test', deliverables: [], success_criteria: [], constraints: {} },
    agents: [
      { name: 'Platform Engineer', role: 'builder', instructions: 'build it', avatar_emoji: '👷', soul_md: '' },
      { name: 'Repo Janitor', role: 'repo janitor', instructions: 'clean up', avatar_emoji: '🧹', soul_md: '' },
    ],
  };
  const messages = [{ role: 'assistant', content: JSON.stringify(completionSpec) }];

  await handlePlanningCompletion(taskId, completionSpec as any, messages as any);

  // PHASE 1 assert — marking persisted in planning_agents
  const specs = getTaskPlanningAgents(taskId);
  assert.equal(specs.length, 2, 'both planning specs persisted');
  assert.ok(specs[0].agent_id, 'spec 0 has resolved agent id');
  assert.ok(specs[1].agent_id, 'spec 1 has resolved agent id');
  assert.equal(specs[0].agent_id, builderId, 'spec 0 resolved to the canonical builder');
  assert.equal(specs[0].status, 'dispatched');
  assert.equal(specs[1].status, 'skipped');
  assert.equal(specs[1].skipped_reason, SKIPPED_REASON);

  const janitorId = specs[1].agent_id!;
  const taskRow = queryOne<{ assigned_agent_id: string | null }>('SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId])!;
  assert.equal(taskRow.assigned_agent_id, specs[0].agent_id, 'task assigned to the dispatched agent');
  trackedAgents.push(janitorId); // hygiene: remove even if a later assert fails

  // Both agents exist; the custom one carries the planning_cycle_task_id tag.
  const janitor = getAgent(janitorId)!;
  assert.ok(janitor, 'custom janitor agent was created');
  assert.equal(janitor.planning_cycle_task_id, taskId, 'custom agent tagged with planning cycle task id');
  assert.equal(agentCount('default'), baseline + 1, 'one new (custom) agent after planning');

  // PHASE 2 — task done → cleanup
  const result = runPlanningAgentCleanup(taskId);

  assert.deepEqual(result.deleted, [janitorId], 'skipped custom agent deleted');
  assert.ok(getAgent(janitorId) === undefined, 'janitor agent row gone');
  assert.ok(getAgent(builderId), 'canonical builder still exists');
  assert.equal(agentCount('default'), baseline, 'agent count back to baseline after done');
  assert.equal(result.protected.length, 0, 'no guard triggered on happy path');
});

// ── 3. Idempotency ──────────────────────────────────────────────────────────

test('idempotency: skipped agent already deleted → no-op, warning logged, no error, count unchanged', () => {
  const taskId = seedTask({
    planningAgents: [
      { name: 'Used', role: 'custom-a', agent_id: 'dispatched-holder', status: 'dispatched' },
      { name: 'Gone', role: 'custom-b', agent_id: 'skipped-holder', status: 'skipped', skipped_reason: SKIPPED_REASON },
    ],
  });
  // Real agent rows — tags match THIS cycle so only the guard-free path applies.
  const dispatchedId = insertAgent({ name: 'Used', role: 'custom-a', tag: taskId });
  const skippedId = insertAgent({ name: 'Gone', role: 'custom-b', tag: taskId });
  run(`UPDATE tasks SET planning_agents = ?, assigned_agent_id = ? WHERE id = ?`, [
    JSON.stringify([
      { name: 'Used', role: 'custom-a', agent_id: dispatchedId, status: 'dispatched' },
      { name: 'Gone', role: 'custom-b', agent_id: skippedId, status: 'skipped', skipped_reason: SKIPPED_REASON },
    ]),
    dispatchedId,
    taskId,
  ]);

  // Pre-delete the skipped agent (as if cleaned manually before the hook ran)
  deleteAgentCascade(skippedId);
  trackedAgents.splice(trackedAgents.indexOf(skippedId), 1); // already gone
  const countBefore = agentCount('default');

  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
  let result: CleanupResult;
  try {
    result = runPlanningAgentCleanup(taskId); // must NOT throw
  } finally {
    console.warn = origWarn;
  }

  assert.deepEqual(result.deleted, [], 'nothing deleted');
  assert.deepEqual(result.alreadyGone, [skippedId], 'missing agent reported as already-gone');
  assert.equal(agentCount('default'), countBefore, 'agent count unchanged');
  assert.ok(
    warns.some((w) => w.includes('already deleted')),
    'warning about already-deleted agent captured'
  );
});

// ── 4. Config toggle off ────────────────────────────────────────────────────

test('cleanup_on_done=false → marking preserved, deletion skipped, agents stay', () => {
  const taskId = seedTask({
    planningAgents: [
      { name: 'Used', role: 'custom-a', agent_id: 'dispatched-holder', status: 'dispatched' },
      { name: 'Kept', role: 'custom-b', agent_id: 'skipped-holder', status: 'skipped', skipped_reason: SKIPPED_REASON },
    ],
  });
  const dispatchedId = insertAgent({ name: 'Used', role: 'custom-a', tag: taskId });
  const skippedId = insertAgent({ name: 'Kept', role: 'custom-b', tag: taskId });
  run(`UPDATE tasks SET planning_agents = ?, assigned_agent_id = ? WHERE id = ?`, [
    JSON.stringify([
      { name: 'Used', role: 'custom-a', agent_id: dispatchedId, status: 'dispatched' },
      { name: 'Kept', role: 'custom-b', agent_id: skippedId, status: 'skipped', skipped_reason: SKIPPED_REASON },
    ]),
    dispatchedId,
    taskId,
  ]);
  const countBefore = agentCount('default');

  const prev = process.env.CLEANUP_ON_DONE;
  process.env.CLEANUP_ON_DONE = 'false';
  try {
    const result = runPlanningAgentCleanup(taskId);

    assert.equal(result.configDisabled, true, 'config gate reported');
    assert.deepEqual(result.deleted, [], 'nothing deleted');
    assert.ok(getAgent(skippedId), 'skipped agent still exists');
    assert.equal(agentCount('default'), countBefore, 'count = baseline + 2 (both kept)');

    // Marking is intact in the spec even though deletion was skipped
    const specs = getTaskPlanningAgents(taskId);
    assert.equal(specs[1].status, 'skipped');
    assert.equal(specs[1].skipped_reason, SKIPPED_REASON);
  } finally {
    if (prev === undefined) delete process.env.CLEANUP_ON_DONE;
    else process.env.CLEANUP_ON_DONE = prev;
  }
});

// ── 5. Guards ───────────────────────────────────────────────────────────────

test('guard: canonical role (builder) with status=skipped is never deleted', () => {
  const taskId = seedTask({
    planningAgents: [
      { name: 'Canonical Builder', role: 'builder', agent_id: 'canonical-holder', status: 'skipped', skipped_reason: SKIPPED_REASON },
    ],
  });
  const canonicalId = insertAgent({ name: 'Canonical Builder', role: 'builder', tag: taskId });
  run(`UPDATE tasks SET planning_agents = ? WHERE id = ?`, [
    JSON.stringify([
      { name: 'Canonical Builder', role: 'builder', agent_id: canonicalId, status: 'skipped', skipped_reason: SKIPPED_REASON },
    ]),
    taskId,
  ]);

  const result = runPlanningAgentCleanup(taskId);

  assert.deepEqual(result.deleted, [], 'canonical agent not deleted');
  assert.equal(result.protected.length, 1);
  assert.equal(result.protected[0].agentId, canonicalId);
  assert.match(result.protected[0].reason, /^canonical_role:/);
  assert.ok(getAgent(canonicalId), 'canonical agent still exists');
});

test('guard: skipped agent assigned to another task is never deleted', () => {
  const taskId = seedTask({
    planningAgents: [
      { name: 'Busy', role: 'custom-b', agent_id: 'skipped-holder', status: 'skipped', skipped_reason: SKIPPED_REASON },
    ],
  });
  const skippedId = insertAgent({ name: 'Busy', role: 'custom-b', tag: taskId });
  run(`UPDATE tasks SET planning_agents = ? WHERE id = ?`, [
    JSON.stringify([
      { name: 'Busy', role: 'custom-b', agent_id: skippedId, status: 'skipped', skipped_reason: SKIPPED_REASON },
    ]),
    taskId,
  ]);
  const otherTaskId = crypto.randomUUID();
  trackedTasks.push(otherTaskId);
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'other task', 'done', 'default', ?, datetime('now'), datetime('now'))`,
    [otherTaskId, skippedId]
  );

  const result = runPlanningAgentCleanup(taskId);

  assert.deepEqual(result.deleted, []);
  assert.equal(result.protected.length, 1);
  assert.equal(result.protected[0].reason, 'assigned_to_other_task');
  assert.ok(getAgent(skippedId), 'assigned-elsewhere agent still exists');
});

test('guard: skipped agent in another task role is never deleted', () => {
  const otherTaskId = seedTask({ status: 'done' }); // other task
  const cleanupTaskId = seedTask({
    planningAgents: [
      { name: 'Roleful', role: 'custom-b', agent_id: 'skipped-holder', status: 'skipped', skipped_reason: SKIPPED_REASON },
    ],
  });
  const skippedId = insertAgent({ name: 'Roleful', role: 'custom-b', tag: cleanupTaskId });
  insertTaskRole(otherTaskId, skippedId, 'builder');
  run(`UPDATE tasks SET planning_agents = ? WHERE id = ?`, [
    JSON.stringify([
      { name: 'Roleful', role: 'custom-b', agent_id: skippedId, status: 'skipped', skipped_reason: SKIPPED_REASON },
    ]),
    cleanupTaskId,
  ]);

  const result = runPlanningAgentCleanup(cleanupTaskId);

  assert.deepEqual(result.deleted, []);
  assert.equal(result.protected.length, 1);
  assert.equal(result.protected[0].reason, 'role_in_other_task');
  assert.ok(getAgent(skippedId), 'agent referenced by another task role still exists');
});

test('guard: skipped agent tagged to a different planning cycle is never deleted', () => {
  const skippedId = insertAgent({ name: 'Foreign', role: 'custom-b', tag: 'some-other-cycle-task' });
  const taskId = seedTask({
    planningAgents: [
      { name: 'Foreign', role: 'custom-b', agent_id: skippedId, status: 'skipped', skipped_reason: SKIPPED_REASON },
    ],
  });

  const result = runPlanningAgentCleanup(taskId);

  assert.deepEqual(result.deleted, []);
  assert.equal(result.protected.length, 1);
  assert.match(result.protected[0].reason, /^other_cycle:/);
  assert.ok(getAgent(skippedId), 'other-cycle agent still exists');
});

test('guard: skipped agent reassigned to the CURRENT task is never deleted', () => {
  const taskId = seedTask({
    planningAgents: [
      { name: 'Reassigned', role: 'custom-b', agent_id: 'skipped-holder', status: 'skipped', skipped_reason: SKIPPED_REASON },
    ],
  });
  const skippedId = insertAgent({ name: 'Reassigned', role: 'custom-b', tag: taskId });
  // Manual reassignment after planning: the marked-skipped agent becomes the
  // task's actual assignee → must be protected, not deleted.
  run(`UPDATE tasks SET planning_agents = ?, assigned_agent_id = ? WHERE id = ?`, [
    JSON.stringify([
      { name: 'Reassigned', role: 'custom-b', agent_id: skippedId, status: 'skipped', skipped_reason: SKIPPED_REASON },
    ]),
    skippedId,
    taskId,
  ]);

  const result = runPlanningAgentCleanup(taskId);

  assert.deepEqual(result.deleted, []);
  assert.equal(result.protected.length, 1);
  assert.equal(result.protected[0].reason, 'assigned_to_current_task');
  assert.ok(getAgent(skippedId), 'current-task assignee still exists');
});

// ── 6. Dispatched + legacy specs ────────────────────────────────────────────

test('dispatched agent is never part of cleanup', () => {
  const taskId = seedTask({
    planningAgents: [
      { name: 'Active', role: 'custom-a', agent_id: 'dispatched-holder', status: 'dispatched' },
      { name: 'Trash', role: 'custom-b', agent_id: 'skipped-holder', status: 'skipped', skipped_reason: SKIPPED_REASON },
    ],
  });
  const dispatchedId = insertAgent({ name: 'Active', role: 'custom-a', tag: taskId });
  const skippedId = insertAgent({ name: 'Trash', role: 'custom-b', tag: taskId });
  run(`UPDATE tasks SET planning_agents = ?, assigned_agent_id = ? WHERE id = ?`, [
    JSON.stringify([
      { name: 'Active', role: 'custom-a', agent_id: dispatchedId, status: 'dispatched' },
      { name: 'Trash', role: 'custom-b', agent_id: skippedId, status: 'skipped', skipped_reason: SKIPPED_REASON },
    ]),
    dispatchedId,
    taskId,
  ]);

  const result = runPlanningAgentCleanup(taskId);

  assert.deepEqual(result.deleted, [skippedId]);
  assert.ok(getAgent(dispatchedId), 'dispatched agent survives');
});

test('legacy planning_agents without status → cleanup is a no-op', () => {
  const agentId = insertAgent({ name: 'Legacy', role: 'custom-b' });
  const taskId = seedTask({
    planningAgents: [{ name: 'Legacy', role: 'custom-b', agent_id: agentId }], // no status
  });

  const result = runPlanningAgentCleanup(taskId);

  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.protected, []);
  assert.ok(getAgent(agentId), 'legacy-spec agent untouched');
});

test('invalid planning_agents JSON → no-op, no error', () => {
  const taskId = seedTask({ planningAgentsRaw: '{not json' });

  const result = runPlanningAgentCleanup(taskId);

  assert.equal(result.noSpecs, true);
  assert.deepEqual(result.deleted, []);
});

test('task without planning_agents → no-op', () => {
  const taskId = seedTask({ planningAgents: undefined });

  const result = runPlanningAgentCleanup(taskId);

  assert.equal(result.noSpecs, true);
  assert.deepEqual(result.deleted, []);
});

// ── 7. deleteAgentCascade ───────────────────────────────────────────────────

test('deleteAgentCascade removes the agent and nulls task references', () => {
  const agentId = insertAgent({ name: 'Doomed', role: 'custom-b', tag: 'task-1' });
  const taskId = seedTask({ assignedAgentId: agentId });
  // Reference the agent from a task_activity (like a real worked task)
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, 'note', 'worked here', datetime('now'))`,
    [crypto.randomUUID(), taskId, agentId]
  );

  deleteAgentCascade(agentId, taskId);

  assert.ok(getAgent(agentId) === undefined, 'agent deleted');
  const task = queryOne<{ assigned_agent_id: string | null }>('SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId])!;
  assert.equal(task.assigned_agent_id, null, 'task assignment nulled');
  const acts = queryAll<{ agent_id: string | null }>('SELECT agent_id FROM task_activities WHERE task_id = ?', [taskId]);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].agent_id, null, 'activity agent reference nulled');
});
