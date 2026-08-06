import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from '@/lib/db';
import { populateTaskRolesFromAgents, handleStageTransition, getTaskRoles } from '@/lib/workflow-engine';
import { ensureCanonicalAgent, mapRoleToCanonical, type CanonicalRole } from '@/lib/canonical-agents';
import { STATUS_ROLE_MAP } from '@/lib/stage-role-map';
import type { TaskRole } from '@/lib/types';

/**
 * PLATFORM-015 — Verifier stage role fix.
 *
 * Regression coverage for the role-confusion class found in PLATFORM-009:
 * the verify stage ran under the tester (assigned_agent_id of the previous
 * stage) because task_roles was never populated for all template stages and
 * the stage-transition fallback used assigned_agent_id instead of the
 * workspace's canonical agent for the stage role.
 *
 * Cases:
 *  1. populateTaskRolesFromAgents fills ALL 5 template stage roles
 *     (builder/tester/reviewer/verifier/learner) with canonical agents per
 *     workspace, and fills MISSING roles without clobbering existing ones.
 *  2. handleStageTransition for the verify stage with NO task_role resolves the
 *     canonical verifier — never the task's assigned_agent_id (previous stage's
 *     agent) — and persists the resolution to task_roles.
 *  3. STATUS_ROLE_MAP: verification → verifier (not reviewer).
 */

function seedTask(id: string, status: string, opts: { workspace?: string; template?: string; assignedAgentId?: string | null } = {}) {
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, workflow_template_id, status_reason, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', ?, 'default', ?, NULL, datetime('now'), datetime('now'))`,
    [id, status, opts.workspace || 'default', opts.template ?? 'tpl-standard']
  );
  if (opts.assignedAgentId) {
    run('UPDATE tasks SET assigned_agent_id = ? WHERE id = ?', [opts.assignedAgentId, id]);
  }
}

// Fixture precondition: tpl-standard (post migration 041) must contain the
// verify stage owned by the verifier role — the template the fix relies on.
test('fixture: tpl-standard has verify stage with role verifier', () => {
  const tpl = queryOne<{ stages: string; is_default: number }>(
    "SELECT stages, is_default FROM workflow_templates WHERE id = 'tpl-standard'"
  );
  assert.ok(tpl, 'tpl-standard must exist (seeded by migrations)');
  const stages = JSON.parse(tpl!.stages) as Array<{ id: string; role: string | null; status: string }>;
  const verify = stages.find(s => s.id === 'verify' || s.status === 'verification');
  assert.ok(verify, 'tpl-standard must include a verify stage');
  assert.equal(verify!.role, 'verifier', 'verify stage must be owned by verifier role (migration 041)');
});

test('PLATFORM-015: populateTaskRolesFromAgents fills all 5 stage roles with canonical agents', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId, 'in_progress');

  populateTaskRolesFromAgents(taskId, 'default');

  const roles = getTaskRoles(taskId);
  const byRole = Object.fromEntries(roles.map(r => [r.role, r]));

  // All 5 canonical stage roles present: build/test/review/verify/learn
  for (const role of ['builder', 'tester', 'reviewer', 'verifier', 'learner']) {
    assert.ok(byRole[role], `task_role "${role}" must be populated`);
  }

  // Every role resolves to the workspace canonical agent (role matches, same workspace)
  for (const role of ['builder', 'tester', 'reviewer', 'verifier', 'learner']) {
    const tr = byRole[role] as TaskRole;
    const agent = queryOne<{ id: string; role: string; workspace_id: string }>(
      'SELECT id, role, workspace_id FROM agents WHERE id = ?', [tr.agent_id]
    );
    assert.ok(agent, `agent for role "${role}" must exist`);
    assert.equal(agent!.role, role, `agent for role "${role}" must be canonical (role match)`);
    assert.equal(agent!.workspace_id, 'default', 'canonical agent must belong to the task workspace');
    assert.equal(tr.agent_id, ensureCanonicalAgent('default', role as CanonicalRole),
      `role "${role}" must map to the workspace canonical agent (create-once)`);
  }

  // Idempotent: a second call preserves the same assignments (INSERT OR IGNORE)
  const before = getTaskRoles(taskId).map(r => `${r.role}:${r.agent_id}`).sort();
  populateTaskRolesFromAgents(taskId, 'default');
  const after = getTaskRoles(taskId).map(r => `${r.role}:${r.agent_id}`).sort();
  assert.deepEqual(after, before, 'repopulation must be idempotent');
});

test('PLATFORM-015: populateTaskRolesFromAgents fills MISSING roles, preserves existing overrides', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId, 'in_progress');

  // Pre-existing manual override for builder only (simulates PATCH /roles).
  // The override agent lives in a SEPARATE workspace so it can never be picked
  // up by ensureCanonicalAgent for the default workspace in sibling tests.
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES ('override-ws', 'Override WS', 'override-ws', '📁', datetime('now'), datetime('now'))`
  );
  const overrideAgentId = crypto.randomUUID();
  run(
    `INSERT INTO agents (id, name, role, status, workspace_id, session_key_prefix, created_at, updated_at)
     VALUES (?, 'Custom Builder', 'builder', 'standby', 'override-ws', NULL, datetime('now'), datetime('now'))`,
    [overrideAgentId]
  );
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'builder', ?, datetime('now'))`,
    [taskId, overrideAgentId]
  );

  populateTaskRolesFromAgents(taskId, 'default');

  const byRole = Object.fromEntries(getTaskRoles(taskId).map(r => [r.role, r]));
  assert.equal(byRole.builder.agent_id, overrideAgentId, 'existing builder override must be preserved');
  for (const role of ['tester', 'reviewer', 'verifier', 'learner']) {
    assert.ok(byRole[role], `missing role "${role}" must be filled`);
    assert.equal(byRole[role].agent_id, ensureCanonicalAgent('default', role as CanonicalRole),
      `filled role "${role}" must be the workspace canonical agent`);
  }
});

test('PLATFORM-015: verify stage with NO task_role resolves canonical verifier, NOT assigned_agent_id', async () => {
  const taskId = crypto.randomUUID();

  // Simulate the PLATFORM-009 bug state: task is in the review stage (previous
  // stage) with assigned_agent_id = the TESTER — the agent that ran the previous
  // stage. task_roles is completely empty.
  const testerAgentId = ensureCanonicalAgent('default', 'tester');
  const verifierAgentId = ensureCanonicalAgent('default', 'verifier');
  seedTask(taskId, 'review', { assignedAgentId: testerAgentId });

  const rolesBefore = getTaskRoles(taskId);
  assert.equal(rolesBefore.length, 0, 'fixture: no task_roles (the bug condition)');

  // Transition into the verification stage (skipDispatch to avoid network I/O)
  const result = await handleStageTransition(taskId, 'verification', { skipDispatch: true });
  assert.equal(result.success, true);
  assert.equal(result.handedOff, true);
  assert.ok(result.newAgentId, 'transition must resolve an agent');

  const task = queryOne<{ assigned_agent_id: string }>('SELECT assigned_agent_id FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task!.assigned_agent_id, verifierAgentId,
    'verify stage must run under the canonical VERIFIER, not the previous stage agent (tester)');
  assert.notEqual(task!.assigned_agent_id, testerAgentId,
    'assigned_agent_id (previous stage agent) must never be reused as the verify fallback');

  // Resolution is persisted to task_roles (defense-in-depth for later transitions)
  const verifierRole = queryOne<{ agent_id: string }>(
    'SELECT agent_id FROM task_roles WHERE task_id = ? AND role = ?', [taskId, 'verifier']
  );
  assert.ok(verifierRole, 'resolved canonical verifier must be persisted to task_roles');
  assert.equal(verifierRole!.agent_id, verifierAgentId);
});

test('PLATFORM-015: mapRoleToCanonical("verifier") → verifier (stage role fallback anchor)', () => {
  assert.equal(mapRoleToCanonical('verifier'), 'verifier');
  assert.equal(mapRoleToCanonical('Verifier Agent'), 'verifier');
  assert.equal(mapRoleToCanonical('verify'), 'verifier');
});

test('PLATFORM-015: STATUS_ROLE_MAP verification → verifier, not reviewer', () => {
  assert.equal(STATUS_ROLE_MAP.verification, 'verifier', 'verification status must map to verifier');
  assert.notEqual(STATUS_ROLE_MAP.verification, 'reviewer', 'verification must NOT map to reviewer');
  // Sanity: other stages keep their canonical owners
  assert.equal(STATUS_ROLE_MAP.assigned, 'builder');
  assert.equal(STATUS_ROLE_MAP.in_progress, 'builder');
  assert.equal(STATUS_ROLE_MAP.testing, 'tester');
  assert.equal(STATUS_ROLE_MAP.review, 'reviewer');
});
