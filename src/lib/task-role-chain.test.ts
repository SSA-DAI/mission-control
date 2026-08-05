import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from './db';
import { attachRoleChains } from './task-role-chain';
import type { Task } from './types';

function seedTask(id: string, status: string, opts: { workspace?: string; template?: string | null; statusReason?: string | null } = {}) {
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, workflow_template_id, status_reason, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', ?, 'default', ?, ?, datetime('now'), datetime('now'))`,
    [id, status, opts.workspace || 'default', opts.template ?? 'tpl-standard', opts.statusReason ?? null]
  );
}

function seedActivity(taskId: string, message: string) {
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', ?, datetime('now'))`,
    [taskId, message]
  );
}

function seedRole(taskId: string, role: string, agentName: string) {
  const agentId = crypto.randomUUID();
  run(
    `INSERT INTO agents (id, workspace_id, name, role, avatar_emoji, status, created_at, updated_at)
     VALUES (?, 'default', ?, ?, '🤖', 'standby', datetime('now'), datetime('now'))`,
    [agentId, agentName, role]
  );
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, ?, datetime('now'))`,
    [taskId, role, agentId]
  );
}

test('chain: tpl-standard renders 6 roles with per-role status', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId, 'review'); // tpl-standard: build→test→review→verify→done
  seedRole(taskId, 'builder', 'Builder Agent');
  seedRole(taskId, 'reviewer', 'Reviewer Agent');
  seedRole(taskId, 'learner', 'Learner Agent');

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  assert.ok(task);
  attachRoleChains({ tasks: [task] });

  const chain = task.role_chain || [];
  assert.equal(chain.length, 6, 'main + builder + tester + reviewer + verifier + learner');
  assert.deepEqual(chain.map(n => n.role), ['main', 'builder', 'tester', 'reviewer', 'verifier', 'learner']);

  const byRole = Object.fromEntries(chain.map(n => [n.role, n]));
  assert.equal(byRole.main.status, 'done');
  assert.equal(byRole.builder.status, 'done');
  assert.equal(byRole.tester.status, 'done');
  assert.equal(byRole.reviewer.status, 'active');
  assert.equal(byRole.verifier.status, 'pending');
  assert.equal(byRole.learner.status, 'active');

  // agent names surfaced from task_roles
  assert.equal(byRole.builder.agentName, 'Builder Agent');
  assert.equal(byRole.reviewer.agentName, 'Reviewer Agent');
  assert.equal(task.knowledge_count, 0);
});

test('chain: verifier failed when verification failed back to builder', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId, 'in_progress', { statusReason: 'Failed: requirement 2 unmet' });
  seedActivity(taskId, 'Stage failed: verification → in_progress (reason: requirement 2 unmet)');

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  assert.ok(task);
  attachRoleChains({ tasks: [task] });

  const byRole = Object.fromEntries((task.role_chain || []).map(n => [n.role, n]));
  assert.equal(byRole.builder.status, 'active', 'builder reworking');
  assert.equal(byRole.verifier.status, 'failed', 'verifier verdict failed');
  assert.equal(byRole.reviewer.status, 'pending', 'review will run again after rework');
});

test('chain: learner gate blocks done — knowledge_count=0 → learner pending at done', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId, 'done');
  seedRole(taskId, 'learner', 'Learner Agent');

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  assert.ok(task);
  attachRoleChains({ tasks: [task] });

  const byRole = Object.fromEntries((task.role_chain || []).map(n => [n.role, n]));
  assert.equal(byRole.learner.status, 'pending', 'task done without knowledge → learner still pending (gate)');
  assert.equal(byRole.verifier.status, 'done');
});

test('chain: knowledge entry flips learner to done + knowledge_count', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId, 'verification');

  run(
    `INSERT INTO knowledge_entries (id, workspace_id, task_id, category, title, content, confidence, created_at)
     VALUES (lower(hex(randomblob(16))), 'default', ?, 'pattern', 'Lesson', 'content', 0.9, datetime('now'))`,
    [taskId]
  );

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  assert.ok(task);
  attachRoleChains({ tasks: [task] });

  assert.equal(task.knowledge_count, 1);
  const byRole = Object.fromEntries((task.role_chain || []).map(n => [n.role, n]));
  assert.equal(byRole.learner.status, 'done');
  assert.equal(byRole.verifier.status, 'active');
});
