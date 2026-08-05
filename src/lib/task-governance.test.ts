import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryAll, queryOne } from './db';
import {
  hasStageEvidence,
  taskCanBeDone,
  ensureFixerExists,
  getFailureCountInStage,
  pickDynamicAgent,
} from './task-governance';

function seedTask(id: string, workspace = 'default') {
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'T', 'review', 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [id, workspace]
  );
}

test('evidence gate requires deliverable + activity', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  assert.equal(hasStageEvidence(taskId), false);

  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'index.html', datetime('now'))`,
    [taskId]
  );
  assert.equal(hasStageEvidence(taskId), false);

  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );

  assert.equal(hasStageEvidence(taskId), true);
});

test('task cannot be done when status_reason indicates failure', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  run(`UPDATE tasks SET status_reason = 'Validation failed: CSS broken' WHERE id = ?`, [taskId]);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'index.html', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );

  assert.equal(taskCanBeDone(taskId), false);
});

// ── PLATFORM-004b: learner knowledge gate ──

function seedEvidence(taskId: string): void {
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'index.html', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );
}

test('task cannot be done without a learner knowledge entry (PLATFORM-004b gate)', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  seedEvidence(taskId);

  // Evidence present, but no knowledge entry for this task → gate blocks done
  assert.equal(taskCanBeDone(taskId), false);
});

test('task can be done with >=1 learner knowledge entry (task-scoped)', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  seedEvidence(taskId);

  // Knowledge entry for a DIFFERENT task must not unlock this task
  const otherTaskId = crypto.randomUUID();
  seedTask(otherTaskId);
  run(
    `INSERT INTO knowledge_entries (id, workspace_id, task_id, category, title, content, confidence, created_at)
     VALUES (lower(hex(randomblob(16))), 'default', ?, 'pattern', 'Other task lesson', 'not mine', 0.8, datetime('now'))`,
    [otherTaskId]
  );
  assert.equal(taskCanBeDone(taskId), false, 'knowledge for another task must not count');

  // Knowledge entry scoped to THIS task unlocks done
  run(
    `INSERT INTO knowledge_entries (id, workspace_id, task_id, category, title, content, confidence, created_at)
     VALUES (lower(hex(randomblob(16))), 'default', ?, 'pattern', 'Lesson learned', 'always run next build', 0.9, datetime('now'))`,
    [taskId]
  );
  assert.equal(taskCanBeDone(taskId), true);
});

test('ensureFixerExists creates fixer when missing', () => {
  const fixer = ensureFixerExists('default');
  assert.equal(fixer.created, true);

  const stored = queryOne<{ id: string; role: string }>('SELECT id, role FROM agents WHERE id = ?', [fixer.id]);
  assert.ok(stored);
  assert.equal(stored?.role, 'fixer');
});

test('failure counter reads status_changed failure events', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'Stage failed: verification → in_progress (reason: x)', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'Stage failed: verification → in_progress (reason: y)', datetime('now'))`,
    [taskId]
  );

  assert.equal(getFailureCountInStage(taskId, 'verification'), 2);
});

// ── PLATFORM-005: pickDynamicAgent workspace scoping ──

test('pickDynamicAgent scopes byRole to task workspace — NOT cross-workspace', () => {
  const wsA = 'ws-pick-a';
  const wsB = 'ws-pick-b';

  for (const ws of [wsA, wsB]) {
    run(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
       VALUES (?, 'WS', ?, '📁', datetime('now'), datetime('now'))`,
      [ws, ws]
    );
  }

  // Create a builder agent in workspace A
  const agentA = crypto.randomUUID();
  run(
    `INSERT INTO agents (id, workspace_id, name, role, avatar_emoji, status, created_at, updated_at)
     VALUES (?, ?, 'Builder A', 'builder', '🤖', 'standby', datetime('now'), datetime('now'))`,
    [agentA, wsA]
  );

  // Create a builder agent in workspace B
  const agentB = crypto.randomUUID();
  run(
    `INSERT INTO agents (id, workspace_id, name, role, avatar_emoji, status, created_at, updated_at)
     VALUES (?, ?, 'Builder B', 'builder', '🤖', 'standby', datetime('now'), datetime('now'))`,
    [agentB, wsB]
  );

  // Task in workspace A
  const taskIdA = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Task A', 'assigned', 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [taskIdA, wsA]
  );

  // Task in workspace B
  const taskIdB = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Task B', 'assigned', 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [taskIdB, wsB]
  );

  const pickedA = pickDynamicAgent(taskIdA, 'builder');
  const pickedB = pickDynamicAgent(taskIdB, 'builder');

  assert.ok(pickedA, 'should pick an agent for workspace A');
  assert.ok(pickedB, 'should pick an agent for workspace B');
  assert.equal(pickedA!.id, agentA, 'workspace A must get agent from workspace A');
  assert.equal(pickedB!.id, agentB, 'workspace B must get agent from workspace B');
  assert.notEqual(pickedA!.id, pickedB!.id, 'different workspaces must use different agents');
});

test('pickDynamicAgent: workspace without agents returns null', () => {
  const wsEmpty = 'ws-empty-pick';
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES (?, 'Empty', 'empty', '📁', datetime('now'), datetime('now'))`,
    [wsEmpty]
  );

  const taskId = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Empty Task', 'assigned', 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [taskId, wsEmpty]
  );

  const picked = pickDynamicAgent(taskId, 'builder');
  assert.equal(picked, null, 'should return null when no agent in workspace');
});

test('pickDynamicAgent: ignores agents from other workspaces even if matching role', () => {
  const wsA = 'ws-isolate-A';
  const wsB = 'ws-isolate-B';

  for (const ws of [wsA, wsB]) {
    run(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
       VALUES (?, 'WS', ?, '📁', datetime('now'), datetime('now'))`,
      [ws, ws]
    );
  }

  // Only put a tester in workspace B
  const testerB = crypto.randomUUID();
  run(
    `INSERT INTO agents (id, workspace_id, name, role, avatar_emoji, status, created_at, updated_at)
     VALUES (?, ?, 'Tester B', 'tester', '🧪', 'standby', datetime('now'), datetime('now'))`,
    [testerB, wsB]
  );

  // Task in workspace A with no agents
  const taskIdA = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Task A', 'testing', 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [taskIdA, wsA]
  );

  // pickDynamicAgent for workspace A should NOT pick the tester from workspace B
  const picked = pickDynamicAgent(taskIdA, 'tester');
  assert.equal(picked, null, 'must NOT leak agent from workspace B into workspace A');
});
