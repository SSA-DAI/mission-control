/**
 * GLOBAL ODE STALL REMEDIATION (2026-09-18) — human-decision recovery tests.
 *
 * Regression: ODE-P04-T10 was parked at menunggu_keputusan_manusia; a manual
 * dispatch/retry dispatched a fresh tester session (r11) while the task stayed
 * parked. The stage watchdog only sweeps stage statuses, so the session ran,
 * ended without a callback, and the task sat parked again — work wasted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { run, queryOne } from './db';
import { HUMAN_DECISION_STATUS } from './stage-watchdog';
import { restoreStageStatusFromHumanDecision } from './human-decision-recovery';
import { stageStatusForRole, stageRoleForStatus } from './stage-role-map';

function seedAgent(role: string): string {
  const id = crypto.randomUUID();
  run(
    `INSERT INTO agents (id, name, role, status, session_key_prefix, created_at, updated_at)
     VALUES (?, ?, ?, 'standby', ?, datetime('now'), datetime('now'))`,
    [id, `Agent ${role}`, role, `agent:${role}:`]
  );
  return id;
}

function seedTask(status: string, agentId: string | null, metadata?: string): string {
  const id = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, description, status, status_reason, assigned_agent_id, workspace_id, metadata, created_at, updated_at)
     VALUES (?, 'Human decision recovery', 'test', ?, 'parked reason', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [id, status, agentId, metadata ?? null]
  );
  return id;
}

function cleanup(taskId: string, agentId?: string | null): void {
  run('DELETE FROM task_activities WHERE task_id = ?', [taskId]);
  run('DELETE FROM tasks WHERE id = ?', [taskId]);
  if (agentId) run('DELETE FROM agents WHERE id = ?', [agentId]);
}

test('stage-role-map: role ↔ status mapping is a bijection for canonical roles', () => {
  assert.equal(stageStatusForRole('builder'), 'in_progress');
  assert.equal(stageStatusForRole('tester'), 'testing');
  assert.equal(stageStatusForRole('reviewer'), 'review');
  assert.equal(stageStatusForRole('verifier'), 'verification');
  assert.equal(stageStatusForRole(' Builder '), 'in_progress');
  assert.equal(stageStatusForRole('learner'), null);
  assert.equal(stageStatusForRole(null), null);
  // round-trip
  for (const status of ['in_progress', 'testing', 'review', 'verification']) {
    assert.equal(stageStatusForRole(stageRoleForStatus(status)), status);
  }
});

test('parked task + tester agent → restored to testing with a fresh budget', () => {
  const agentId = seedAgent('tester');
  const taskId = seedTask(HUMAN_DECISION_STATUS, agentId, JSON.stringify({ stage_restart_count: 2 }));

  const result = restoreStageStatusFromHumanDecision(taskId);

  assert.equal(result.restored, true);
  assert.equal(result.from, HUMAN_DECISION_STATUS);
  assert.equal(result.to, 'testing');
  assert.equal(result.agentRole, 'tester');

  const task = queryOne<{ status: string; status_reason: string | null; metadata: string | null }>(
    'SELECT status, status_reason, metadata FROM tasks WHERE id = ?',
    [taskId]
  );
  assert.equal(task?.status, 'testing');
  assert.equal(task?.status_reason, null, 'stale parked reason must be cleared');
  assert.deepEqual(JSON.parse(task!.metadata!), { stage_restart_count: 0 });

  const activity = queryOne<{ message: string; metadata: string }>(
    `SELECT message, metadata FROM task_activities
      WHERE task_id = ? AND activity_type = 'status_changed'
      ORDER BY datetime(created_at) DESC LIMIT 1`,
    [taskId]
  );
  assert.match(activity!.message, /menunggu_keputusan_manusia → testing/);
  assert.equal(JSON.parse(activity!.metadata).reason, 'human_decision_retry_restore');

  cleanup(taskId, agentId);
});

test('builder/reviewer/verifier parked tasks map to their own stage', () => {
  for (const [role, expected] of [
    ['builder', 'in_progress'],
    ['reviewer', 'review'],
    ['verifier', 'verification'],
  ] as const) {
    const agentId = seedAgent(role);
    const taskId = seedTask(HUMAN_DECISION_STATUS, agentId);
    const result = restoreStageStatusFromHumanDecision(taskId);
    assert.equal(result.restored, true, `${role} must be restorable`);
    assert.equal(result.to, expected);
    cleanup(taskId, agentId);
  }
});

test('a non-parked task is untouched (no writes, no reset)', () => {
  const agentId = seedAgent('tester');
  const taskId = seedTask('testing', agentId, JSON.stringify({ stage_restart_count: 1 }));

  const result = restoreStageStatusFromHumanDecision(taskId);
  assert.equal(result.restored, false);
  assert.equal(result.reason, 'not_parked');

  const task = queryOne<{ status: string; metadata: string | null }>(
    'SELECT status, metadata FROM tasks WHERE id = ?',
    [taskId]
  );
  assert.equal(task?.status, 'testing');
  assert.deepEqual(JSON.parse(task!.metadata!), { stage_restart_count: 1 }, 'budget untouched');
  cleanup(taskId, agentId);
});

test('parked task without an agent / with an unmapped role stays parked', () => {
  const noAgent = seedTask(HUMAN_DECISION_STATUS, null);
  assert.equal(restoreStageStatusFromHumanDecision(noAgent).reason, 'no_agent');
  assert.equal(
    queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [noAgent])?.status,
    HUMAN_DECISION_STATUS
  );
  cleanup(noAgent);

  const learnerAgent = seedAgent('learner');
  const learnerTask = seedTask(HUMAN_DECISION_STATUS, learnerAgent);
  const result = restoreStageStatusFromHumanDecision(learnerTask);
  assert.equal(result.restored, false);
  assert.equal(result.reason, 'unmapped_role');
  assert.equal(
    queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [learnerTask])?.status,
    HUMAN_DECISION_STATUS
  );
  cleanup(learnerTask, learnerAgent);
});
