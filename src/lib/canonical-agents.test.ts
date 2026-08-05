import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { run, queryOne } from './db';
import { schema } from './db/schema';
import { migrations } from './db/migrations';
import {
  mapRoleToCanonical,
  ensureCanonicalAgent,
  resolvePlanningAgent,
  CANONICAL_ROLES,
  type CanonicalRole,
} from './canonical-agents';

// ── Role keyword mapping ──

test('mapRoleToCanonical: keyword build → builder', () => {
  assert.equal(mapRoleToCanonical('build something'), 'builder');
  assert.equal(mapRoleToCanonical('architect'), 'builder');
  assert.equal(mapRoleToCanonical('codebase maintainer'), 'builder');
  assert.equal(mapRoleToCanonical('bug fixer'), 'builder');
  assert.equal(mapRoleToCanonical('implement feature'), 'builder');
});

test('mapRoleToCanonical: keyword test → tester', () => {
  assert.equal(mapRoleToCanonical('quality assurance'), 'tester');
  assert.equal(mapRoleToCanonical('ensure compliance'), 'tester');
  assert.equal(mapRoleToCanonical('validate output'), 'tester');
});

test('mapRoleToCanonical: keyword verify → verifier (PLATFORM-004b)', () => {
  assert.equal(mapRoleToCanonical('verify results'), 'verifier');
  assert.equal(mapRoleToCanonical('Verifier Agent'), 'verifier');
  assert.equal(mapRoleToCanonical('final verification gate'), 'verifier');
  assert.equal(mapRoleToCanonical('approve deliverable'), 'verifier');
});

test('mapRoleToCanonical: keyword review → reviewer', () => {
  assert.equal(mapRoleToCanonical('audit security'), 'reviewer');
  assert.equal(mapRoleToCanonical('inspect output'), 'reviewer');
  assert.equal(mapRoleToCanonical('examine results'), 'reviewer');
  assert.equal(mapRoleToCanonical('check compliance'), 'reviewer');
  // PLATFORM-012 regression: realistic LLM role strings must NOT map to builder
  // via the generic 'code'/'build' substrings — 'review' is the action verb.
  assert.equal(mapRoleToCanonical('review code'), 'reviewer');
  assert.equal(mapRoleToCanonical('code reviewer'), 'reviewer');
  assert.equal(mapRoleToCanonical('code review'), 'reviewer');
});

test('mapRoleToCanonical: keyword learn → learner', () => {
  assert.equal(mapRoleToCanonical('learn patterns'), 'learner');
  assert.equal(mapRoleToCanonical('research approach'), 'learner');
  assert.equal(mapRoleToCanonical('analyze data'), 'learner');
  assert.equal(mapRoleToCanonical('document findings'), 'learner');
});

test('mapRoleToCanonical: no match returns null', () => {
  assert.equal(mapRoleToCanonical('manager'), null);
  assert.equal(mapRoleToCanonical('orchestrator'), null);
  assert.equal(mapRoleToCanonical('deployer'), null);
  assert.equal(mapRoleToCanonical(''), null);
});

test('mapRoleToCanonical: case insensitive', () => {
  assert.equal(mapRoleToCanonical('BUILDER'), 'builder');
  assert.equal(mapRoleToCanonical('TeStEr'), 'tester');
  assert.equal(mapRoleToCanonical('REVIEW'), 'reviewer');
});

test('mapRoleToCanonical: specialized action verb wins over generic build words (PLATFORM-012)', () => {
  // PLATFORM-012 fix: greedy substring matching with builder checked first mapped
  // realistic role strings to the WRONG canonical role ('test the build' → builder,
  // 'test and build' → builder). An explicit test/review/verify/learn action verb
  // in the role string must win — the agent's job is defined by what it DOES.
  assert.equal(mapRoleToCanonical('test the build'), 'tester');
  assert.equal(mapRoleToCanonical('test and build'), 'tester');
  assert.equal(mapRoleToCanonical('build and test'), 'tester');
  assert.equal(mapRoleToCanonical('fix the test'), 'tester');
  // Builder keywords only win when no specialized role is mentioned.
  assert.equal(mapRoleToCanonical('build the feature'), 'builder');
  assert.equal(mapRoleToCanonical('build and implement'), 'builder');
});

// ── Create-once (idempotent) ──

test('ensureCanonicalAgent: creates canonical agent in workspace when missing', () => {
  const wsId = 'ws-create-test';
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES (?, 'Test WS', 'create-ws', '📁', datetime('now'), datetime('now'))`,
    [wsId]
  );

  const id = ensureCanonicalAgent(wsId, 'builder');
  assert.ok(id, 'should return a uuid');

  const stored = queryOne<{ id: string; role: string; workspace_id: string; session_key_prefix: string }>(
    'SELECT id, role, workspace_id, session_key_prefix FROM agents WHERE id = ?', [id]
  );
  assert.ok(stored);
  assert.equal(stored!.role, 'builder');
  assert.equal(stored!.workspace_id, wsId);
  assert.equal(stored!.session_key_prefix, 'agent:builder:');
});

test('ensureCanonicalAgent: returns existing agent (create-once) — no duplicate', () => {
  const wsId = 'ws-reuse-test';
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES (?, 'Reuse WS', 'reuse-ws', '📁', datetime('now'), datetime('now'))`,
    [wsId]
  );

  const firstId = ensureCanonicalAgent(wsId, 'tester');
  const secondId = ensureCanonicalAgent(wsId, 'tester');
  assert.equal(firstId, secondId, 'should return the same agent id on second call');

  // Verify only one tester agent exists
  const count = queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM agents WHERE workspace_id = ? AND role = ? AND status != \'offline\'',
    [wsId, 'tester']
  );
  assert.equal(Number(count!.count), 1);
});

test('ensureCanonicalAgent: different workspaces have separate canonical agents', () => {
  const ws1 = 'ws-parallel-a';
  const ws2 = 'ws-parallel-b';
  for (const ws of [ws1, ws2]) {
    run(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
       VALUES (?, 'WS', ?, '📁', datetime('now'), datetime('now'))`,
      [ws, ws]
    );
  }

  const idA = ensureCanonicalAgent(ws1, 'reviewer');
  const idB = ensureCanonicalAgent(ws2, 'reviewer');

  assert.notEqual(idA, idB, 'different workspaces MUST have different canonical agents');

  // Verify workspace isolation
  const aAgent = queryOne<{ workspace_id: string }>('SELECT workspace_id FROM agents WHERE id = ?', [idA]);
  const bAgent = queryOne<{ workspace_id: string }>('SELECT workspace_id FROM agents WHERE id = ?', [idB]);
  assert.equal(aAgent!.workspace_id, ws1);
  assert.equal(bAgent!.workspace_id, ws2);
});

test('ensureCanonicalAgent: creates all 5 canonical roles', () => {
  const wsId = 'ws-all-roles';
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES (?, 'All Roles', 'all-roles', '📁', datetime('now'), datetime('now'))`,
    [wsId]
  );

  const ids = new Set<string>();
  for (const role of CANONICAL_ROLES) {
    const id = ensureCanonicalAgent(wsId, role);
    assert.ok(id);
    ids.add(id);
  }
  assert.equal(ids.size, 5, 'should create 5 distinct canonical agents');

  // Verify all 5 exist in DB
  const count = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM agents WHERE workspace_id = ? AND role IN (${CANONICAL_ROLES.map(() => '?').join(',')}) AND status != 'offline'`,
    [wsId, ...CANONICAL_ROLES]
  );
  assert.equal(Number(count!.count), 5);
});

// ── PLATFORM-005 regression: NULL-prefix bootstrap agent reuse ──

function insertBootstrapAgent(workspaceId: string, role: string, status = 'standby', name?: string): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  run(
    `INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, session_key_prefix, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'local', ?, ?)`,
    [id, workspaceId, name ?? `${role.charAt(0).toUpperCase() + role.slice(1)} Agent`, role, `${role} — core team member`, '🛠️', status, now, now]
  );
  return id;
}

function countActiveByRole(workspaceId: string, role: string): number {
  const res = queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM agents WHERE workspace_id = ? AND role = ? AND status != 'offline'",
    [workspaceId, role]
  );
  return Number(res!.count);
}

test('ensureCanonicalAgent: reuses existing NULL-prefix bootstrap agent (create-once)', () => {
  // Regression for VERIFY_FAIL: bootstrap core agents (migration 013 /
  // bootstrapCoreAgents) are created WITHOUT session_key_prefix (NULL). The old
  // lookup only matched NULL when the requested prefix was ALSO NULL — dead code
  // since CANONICAL_ROLE_PREFIXES always yields a non-null prefix — so a duplicate
  // canonical agent was created. It must reuse the existing bootstrap agent.
  const wsId = 'ws-null-prefix-reuse';
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES (?, 'Null Prefix', 'null-prefix', '📁', datetime('now'), datetime('now'))`,
    [wsId]
  );

  const bootstrapId = insertBootstrapAgent(wsId, 'builder', 'standby', 'Builder Agent');

  const firstId = ensureCanonicalAgent(wsId, 'builder');
  const secondId = ensureCanonicalAgent(wsId, 'builder');

  assert.equal(firstId, bootstrapId, 'must reuse the existing NULL-prefix bootstrap agent');
  assert.equal(secondId, bootstrapId, 'create-once must return the same id on repeated calls');
  assert.equal(countActiveByRole(wsId, 'builder'), 1, 'agent count must stay 1 — no duplicate');
});

test('ensureCanonicalAgent: does NOT reuse a NULL-prefix offline agent', () => {
  // status != 'offline' must still be enforced: disabled agents (e.g. mrnav-* set
  // offline by migration 038) are never reused as canonical.
  const wsId = 'ws-null-prefix-offline';
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES (?, 'Null Prefix Offline', 'null-prefix-offline', '📁', datetime('now'), datetime('now'))`,
    [wsId]
  );

  const offlineId = insertBootstrapAgent(wsId, 'tester', 'offline', 'Tester Agent');

  const canonicalId = ensureCanonicalAgent(wsId, 'tester');
  assert.notEqual(canonicalId, offlineId, 'offline agent must not be reused');
  assert.equal(countActiveByRole(wsId, 'tester'), 1, 'exactly one ACTIVE tester agent');

  const offline = queryOne<{ status: string }>('SELECT status FROM agents WHERE id = ?', [offlineId]);
  assert.equal(offline!.status, 'offline', 'offline agent untouched');
});

test('ensureCanonicalAgent: prefers exact session_key_prefix match over NULL-prefix', () => {
  // default workspace has BOTH NULL-prefix bootstrap agents and gateway-synced
  // agents with canonical prefixes. Dispatch must keep resolving to the
  // gateway-backed agent (exact prefix), not the local bootstrap placeholder.
  const wsId = 'ws-prefix-preference';
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES (?, 'Prefix Pref', 'prefix-pref', '📁', datetime('now'), datetime('now'))`,
    [wsId]
  );

  const bootstrapId = insertBootstrapAgent(wsId, 'reviewer', 'standby', 'Reviewer Agent');
  const gatewayId = crypto.randomUUID();
  const now = new Date().toISOString();
  run(
    `INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, session_key_prefix, source, gateway_agent_id, created_at, updated_at)
     VALUES (?, ?, 'reviewer', 'reviewer', 'gateway reviewer', '🔍', 'standby', 'agent:reviewer:', 'gateway', 'gw-reviewer', ?, ?)`,
    [gatewayId, wsId, now, now]
  );

  const canonicalId = ensureCanonicalAgent(wsId, 'reviewer');
  assert.equal(canonicalId, gatewayId, 'exact prefix match must win over NULL-prefix bootstrap agent');
  assert.notEqual(canonicalId, bootstrapId);
  assert.equal(countActiveByRole(wsId, 'reviewer'), 2, 'both pre-existing agents preserved — no new agent created');
});

test('migration 038: reuses NULL-prefix bootstrap agents and disables mrnav-* (no duplicates)', () => {  // Regression for the migration deliverable: on deploy, 038 must NOT create +4
  // duplicate canonical agents in workspaces that only have NULL-prefix bootstrap
  // agents. Run 038 against a scratch in-memory DB with production-equivalent state.
  const db = new Database(':memory:');
  db.exec(schema);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, icon, created_at, updated_at) VALUES (?, 'Mig WS', 'mig-ws', '📁', ?, ?)`
  ).run('ws-mig', now, now);
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at) VALUES (?, 'ws-mig', 'task', 'in_progress', ?, ?)`
  ).run('task-mig', now, now);

  // NULL-prefix bootstrap agents (production-equivalent to migration 013 output)
  const bootstrapIds: Record<string, string> = {};
  for (const role of ['builder', 'tester', 'reviewer', 'learner'] as const) {
    const id = `boot-${role}`;
    db.prepare(
      `INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, session_key_prefix, source, created_at, updated_at)
       VALUES (?, 'ws-mig', ?, ?, ?, '🛠️', 'standby', NULL, 'local', ?, ?)`
    ).run(id, `${role.charAt(0).toUpperCase() + role.slice(1)} Agent`, role, `${role} — core team member`, now, now);
    bootstrapIds[role] = id;
  }

  // Legacy mrnav-* agents still standby
  db.prepare(
    `INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, session_key_prefix, source, created_at, updated_at)
     VALUES ('mrnav-legacy', 'ws-mig', 'mrnav-legacy', 'builder', 'legacy per-spec agent', '🛠️', 'standby', 'agent:builder:', 'local', ?, ?)`
  ).run(now, now);

  const migration038 = migrations.find(m => m.id === '038');
  assert.ok(migration038, 'migration 038 must exist');
  migration038!.up(db);

  // 1) mrnav-* disabled (not deleted — audit trail)
  const mrnav = db.prepare('SELECT status FROM agents WHERE id = ?').get('mrnav-legacy') as { status: string };
  assert.equal(mrnav.status, 'offline');

  // 2) NULL-prefix bootstrap agents reused — one ACTIVE builder, and it is the
  //    bootstrap agent itself; no new canonical with the canonical prefix
  for (const role of ['builder', 'tester', 'reviewer', 'learner'] as const) {
    const active = db.prepare(
      "SELECT COUNT(*) as cnt FROM agents WHERE workspace_id = 'ws-mig' AND role = ? AND status != 'offline'"
    ).get(role) as { cnt: number };
    assert.equal(Number(active.cnt), 1, `exactly one active ${role} agent — no duplicate`);

    const reused = db.prepare(
      "SELECT COUNT(*) as cnt FROM agents WHERE workspace_id = 'ws-mig' AND role = ? AND session_key_prefix IS NULL AND status != 'offline'"
    ).get(role) as { cnt: number };
    assert.equal(Number(reused.cnt), 1, `bootstrap ${role} agent (NULL prefix) must be the reused one`);
  }

  // 3) No agent with canonical prefixes was created by the migration
  const prefixed = db.prepare(
    "SELECT COUNT(*) as cnt FROM agents WHERE workspace_id = 'ws-mig' AND session_key_prefix IN ('agent:builder:','agent:tester:','agent:reviewer:','agent:learner:')"
  ).get() as { cnt: number };
  assert.equal(Number(prefixed.cnt), 1, 'only the disabled mrnav-legacy agent carries a canonical prefix');

  // 4) Workspace WITHOUT tasks gets no canonical agents
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, icon, created_at, updated_at) VALUES ('ws-no-tasks', 'No Tasks', 'no-tasks', '📁', ?, ?)`
  ).run(now, now);
  migration038!.up(db);
  const noTasksAgents = db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE workspace_id = 'ws-no-tasks'").get() as { cnt: number };
  assert.equal(Number(noTasksAgents.cnt), 0, 'workspace without tasks must not receive canonical agents');

  db.close();
});

// ── PLATFORM-012: resolvePlanningAgent (canonical-first, shared helper) ──

function ensureWorkspace(id: string, name: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES (?, ?, ?, '📁', datetime('now'), datetime('now'))`,
    [id, name, id]
  );
}

test('resolvePlanningAgent: canonical role (builder) returns existing agent — no new INSERT', () => {
  const wsId = 'ws-plat012-canonical-reuse';
  ensureWorkspace(wsId, 'PLATFORM-012 Canonical Reuse');

  // Pre-create the canonical builder agent
  const existingId = ensureCanonicalAgent(wsId, 'builder');
  const beforeCount = countActiveByRole(wsId, 'builder');
  assert.equal(beforeCount, 1, 'one builder should exist before resolvePlanningAgent');

  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    wsId,
    { name: 'Builder', role: 'build and implement feature' },
    true,
    seenRoles
  );

  assert.ok(result, 'should resolve canonical builder');
  assert.equal(result!.agentId, existingId, 'must reuse existing canonical builder ID');
  assert.equal(result!.isCanonical, true);
  assert.equal(result!.prefix, 'agent:builder:');

  // No new agent created
  const afterCount = countActiveByRole(wsId, 'builder');
  assert.equal(afterCount, 1, 'agent count must stay 1 — no duplicate');
});

test('resolvePlanningAgent: canonical role (tester) returns existing agent', () => {
  const wsId = 'ws-plat012-tester-reuse';
  ensureWorkspace(wsId, 'PLATFORM-012 Tester Reuse');

  const existingId = ensureCanonicalAgent(wsId, 'tester');
  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    wsId,
    { name: 'QA Tester', role: 'test and validate output' },
    true,
    seenRoles
  );

  assert.ok(result);
  assert.equal(result!.agentId, existingId);
  assert.equal(result!.isCanonical, true);
  assert.equal(result!.prefix, 'agent:tester:');
});

test('resolvePlanningAgent: canonical role (reviewer) returns existing agent', () => {
  const wsId = 'ws-plat012-reviewer-reuse';
  ensureWorkspace(wsId, 'PLATFORM-012 Reviewer Reuse');

  const existingId = ensureCanonicalAgent(wsId, 'reviewer');
  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    wsId,
    { name: 'Code Reviewer', role: 'review and audit changes' },
    true,
    seenRoles
  );

  assert.ok(result);
  assert.equal(result!.agentId, existingId);
  assert.equal(result!.isCanonical, true);
  assert.equal(result!.prefix, 'agent:reviewer:');
});

test('resolvePlanningAgent: canonical role (verifier) returns existing agent', () => {
  const wsId = 'ws-plat012-verifier-reuse';
  ensureWorkspace(wsId, 'PLATFORM-012 Verifier Reuse');

  const existingId = ensureCanonicalAgent(wsId, 'verifier');
  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    wsId,
    { name: 'Verifier', role: 'verify and approve deliverables' },
    true,
    seenRoles
  );

  assert.ok(result);
  assert.equal(result!.agentId, existingId);
  assert.equal(result!.isCanonical, true);
  assert.equal(result!.prefix, 'agent:verifier:');
});

test('resolvePlanningAgent: canonical role (learner) returns existing agent', () => {
  const wsId = 'ws-plat012-learner-reuse';
  ensureWorkspace(wsId, 'PLATFORM-012 Learner Reuse');

  const existingId = ensureCanonicalAgent(wsId, 'learner');
  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    wsId,
    { name: 'Learner', role: 'learn and document findings' },
    true,
    seenRoles
  );

  assert.ok(result);
  assert.equal(result!.agentId, existingId);
  assert.equal(result!.isCanonical, true);
  assert.equal(result!.prefix, 'agent:learner:');
});

test('resolvePlanningAgent: all 5 canonical roles resolve without creating duplicate agents', () => {
  const wsId = 'ws-plat012-all-canonical';
  ensureWorkspace(wsId, 'PLATFORM-012 All Canonical');

  // Pre-create all 5 canonical agents
  const preIds: Record<string, string> = {};
  for (const role of CANONICAL_ROLES) {
    preIds[role] = ensureCanonicalAgent(wsId, role);
  }

  // Verify exactly 5 agents exist
  for (const role of CANONICAL_ROLES) {
    assert.equal(countActiveByRole(wsId, role), 1, `${role}: exactly one before planning`);
  }

  // Simulate a planning spec with all 5 canonical agents (tester first for variety)
  const seenRoles = new Set<CanonicalRole>();
  const spec = [
    { name: 'Tester', role: 'test everything' },
    { name: 'Builder', role: 'build the feature' },
    { name: 'Reviewer', role: 'review code' },
    { name: 'Verifier', role: 'verify acceptance' },
    { name: 'Learner', role: 'learn patterns' },
  ];

  const resolved: Array<{ role: string; agentId: string; isCanonical: boolean }> = [];
  for (const agent of spec) {
    const result = resolvePlanningAgent(wsId, agent, true, seenRoles);
    if (result) {
      resolved.push({ role: agent.role, agentId: result.agentId, isCanonical: result.isCanonical });
    }
  }

  assert.equal(resolved.length, 5, 'all 5 agents should resolve');
  for (const r of resolved) {
    assert.equal(r.isCanonical, true, `${r.role}: must be canonical`);
  }

  // Agent count stays at 5 per role — zero new agents created
  for (const role of CANONICAL_ROLES) {
    assert.equal(countActiveByRole(wsId, role), 1, `${role}: agent count must stay 1 — no duplicate`);
  }

  // Each resolved ID matches the pre-existing canonical agent
  // (just verify builder/tester explicitly; the per-role checks above cover the rest)
  assert.equal(resolved.find(r => r.role.includes('build'))!.agentId, preIds.builder);
  assert.equal(resolved.find(r => r.role.includes('test'))!.agentId, preIds.tester);
});

test('resolvePlanningAgent: dedup — second canonical role of same type returns null', () => {
  const wsId = 'ws-plat012-dedup';
  ensureWorkspace(wsId, 'PLATFORM-012 Dedup');

  ensureCanonicalAgent(wsId, 'builder');
  const seenRoles = new Set<CanonicalRole>();

  // First builder resolves
  const first = resolvePlanningAgent(
    wsId,
    { name: 'Builder A', role: 'build module A' },
    true,
    seenRoles
  );
  assert.ok(first, 'first builder should resolve');

  // Second builder (same canonical role) returns null
  const second = resolvePlanningAgent(
    wsId,
    { name: 'Builder B', role: 'build module B' },
    true,
    seenRoles
  );
  assert.equal(second, null, 'second builder must be deduped to null');

  // Agent count stays at 1
  assert.equal(countActiveByRole(wsId, 'builder'), 1, 'dedup prevents agent count increase');
});

test('resolvePlanningAgent: non-canonical role returns custom agent (isCanonical=false) when ALLOW_DYNAMIC=true', () => {
  const wsId = 'ws-plat012-custom-allowed';
  ensureWorkspace(wsId, 'PLATFORM-012 Custom Allowed');

  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    wsId,
    { name: 'Deployer', role: 'deploy to production' },
    true,
    seenRoles
  );

  assert.ok(result, 'non-canonical role should resolve when dynamic is allowed');
  assert.equal(result!.isCanonical, false);
  assert.ok(result!.agentId, 'should have a generated agentId');
  // 'deploy' has no keyword match → should be treated as non-canonical custom
});

test('resolvePlanningAgent: non-canonical role returns null when ALLOW_DYNAMIC=false', () => {
  const wsId = 'ws-plat012-custom-denied';
  ensureWorkspace(wsId, 'PLATFORM-012 Custom Denied');

  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    wsId,
    { name: 'Deployer', role: 'deploy to production' },
    false,
    seenRoles
  );

  assert.equal(result, null, 'non-canonical role must return null when dynamic is disabled');
});

test('resolvePlanningAgent: non-canonical role without workspace returns null', () => {
  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    null,
    { name: 'Deployer', role: 'deploy' },
    true,
    seenRoles
  );

  assert.equal(result, null, 'non-canonical without workspace must return null (cannot resolve prefix)');
});

test('resolvePlanningAgent: canonical role with null workspaceId falls back to default workspace', () => {
  // Ensure default workspace exists
  ensureWorkspace('default', 'Default Workspace');

  const canonicalId = ensureCanonicalAgent('default', 'builder');
  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    null, // null workspace → falls back to 'default'
    { name: 'Builder', role: 'build feature' },
    true,
    seenRoles
  );

  assert.ok(result);
  assert.equal(result!.isCanonical, true);
  // The canonical agent should match the one in 'default' workspace
  const agent = queryOne<{ workspace_id: string }>('SELECT workspace_id FROM agents WHERE id = ?', [result!.agentId]);
  assert.equal(agent!.workspace_id, 'default');
});

test('resolvePlanningAgent: role with no name field uses role only', () => {
  const wsId = 'ws-plat012-role-only';
  ensureWorkspace(wsId, 'PLATFORM-012 Role Only');

  const existingId = ensureCanonicalAgent(wsId, 'builder');
  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    wsId,
    { name: '', role: 'build this thing' }, // empty name, role has keyword
    true,
    seenRoles
  );

  assert.ok(result);
  assert.equal(result!.agentId, existingId, 'should match canonical by role keyword even with empty name');
  assert.equal(result!.isCanonical, true);
});

test('resolvePlanningAgent: mixed canonical + custom agents in one planning cycle', () => {
  const wsId = 'ws-plat012-mixed';
  ensureWorkspace(wsId, 'PLATFORM-012 Mixed');

  const builderId = ensureCanonicalAgent(wsId, 'builder');
  const testerId = ensureCanonicalAgent(wsId, 'tester');
  const beforeTotal = queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM agents WHERE workspace_id = ? AND status != 'offline'",
    [wsId]
  );
  const beforeCount = Number(beforeTotal!.count);
  assert.equal(beforeCount, 2, '2 canonical agents before planning');

  // Planning spec: 2 canonical (builder, tester) + 1 custom (deployer)
  const seenRoles = new Set<CanonicalRole>();
  const spec = [
    { name: 'Builder', role: 'build the feature' },
    { name: 'Tester', role: 'test the build' },
    { name: 'Deployer', role: 'deploy to staging' },
  ];

  let canonicalCount = 0;
  let customCount = 0;

  for (const agent of spec) {
    const resolved = resolvePlanningAgent(wsId, agent, true, seenRoles);
    if (!resolved) continue;

    if (resolved.isCanonical) {
      canonicalCount++;
      // Verify it matches the pre-existing agent. Keyed by spec position, not by
      // substring: 'test the build' contains BOTH 'test' and 'build', so a
      // substring-based role check would assert against the wrong canonical id.
      const expectedId = agent === spec[0] ? builderId : testerId;
      assert.equal(resolved.agentId, expectedId, `${agent.role}: should map to its canonical agent`);
    } else {
      customCount++;
      assert.equal(resolved.agentId.length, 36, 'custom agentId should be a UUID');
    }
  }

  assert.equal(canonicalCount, 2, '2 canonical agents resolved');
  assert.equal(customCount, 1, '1 custom agent resolved');

  // DB agent count: 2 (canonical, already exist) + 0 (custom not INSERTed by resolvePlanningAgent)
  const afterTotal = queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM agents WHERE workspace_id = ? AND status != 'offline'",
    [wsId]
  );
  assert.equal(Number(afterTotal!.count), beforeCount,
    'resolvePlanningAgent does NOT insert custom agents — caller must INSERT');
});

test('resolvePlanningAgent: keyword "engineer" resolves to builder (not custom)', () => {
  const wsId = 'ws-plat012-engineer';
  ensureWorkspace(wsId, 'PLATFORM-012 Engineer');

  const existingId = ensureCanonicalAgent(wsId, 'builder');
  const seenRoles = new Set<CanonicalRole>();
  const result = resolvePlanningAgent(
    wsId,
    { name: 'Software Engineer', role: 'engineer the solution' },
    true,
    seenRoles
  );

  assert.ok(result);
  assert.equal(result!.isCanonical, true, '"engineer" keyword should map to builder canonical');
  assert.equal(result!.agentId, existingId);
});

test('resolvePlanningAgent: role without keywords + dynamic disabled = null (safe skip)', () => {
  const wsId = 'ws-plat012-safe-skip';
  ensureWorkspace(wsId, 'PLATFORM-012 Safe Skip');

  // Roles like "manager", "orchestrator", "deployer" have no keyword match
  // and with dynamic disabled should return null (not create anything)
  const seenRoles = new Set<CanonicalRole>();
  for (const role of ['manager', 'orchestrator', 'notify', 'monitor']) {
    const result = resolvePlanningAgent(
      wsId,
      { name: role, role },
      false,
      seenRoles
    );
    assert.equal(result, null, `"${role}" with dynamic disabled must return null`);
  }

  // Verify zero agents were created for these roles
  for (const role of ['manager', 'orchestrator']) {
    const count = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM agents WHERE workspace_id = ? AND role = ?",
      [wsId, role]
    );
    assert.equal(Number(count!.count), 0, `${role}: no agent created`);
  }
});

test('migration 041: tpl-standard gets verify(verifier) stage, tpl-strict verify→verifier, canonical verifier created once', () => {
  // PLATFORM-004b regression: replay migration 041 against a scratch in-memory DB
  // with production-equivalent state (post-013 templates, NULL-prefix bootstrap agents).
  const db = new Database(':memory:');
  db.exec(schema);

  const now = new Date().toISOString();

  // Seed workspaces + a task so the canonical-verifier loop has a target
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, icon, created_at, updated_at) VALUES ('default', 'Default', 'default', '📁', ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO workspaces (id, name, slug, icon, created_at, updated_at) VALUES (?, 'Mig WS', 'mig041-ws', '📁', ?, ?)`
  ).run('ws-mig041', now, now);
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at) VALUES (?, 'ws-mig041', 'task', 'in_progress', ?, ?)`
  ).run('task-mig041', now, now);

  // Templates as they exist after migration 013 (standard w/o verify, strict verify→reviewer)
  const tplStandard = [
    { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
    { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
    { id: 'review', label: 'Review', role: 'reviewer', status: 'review' },
    { id: 'done', label: 'Done', role: null, status: 'done' },
  ];
  const tplStrict = [
    { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
    { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
    { id: 'review', label: 'Review', role: null, status: 'review' },
    { id: 'verify', label: 'Verify', role: 'reviewer', status: 'verification' },
    { id: 'done', label: 'Done', role: null, status: 'done' },
  ];
  db.prepare(
    `INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
     VALUES ('tpl-standard', 'default', 'Standard', 'd', ?, '{}', 0, ?, ?)`
  ).run(JSON.stringify(tplStandard), now, now);
  db.prepare(
    `INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
     VALUES ('tpl-strict', 'default', 'Strict', 'd', ?, '{}', 1, ?, ?)`
  ).run(JSON.stringify(tplStrict), now, now);

  // NULL-prefix bootstrap agents (no verifier yet)
  for (const role of ['builder', 'tester', 'reviewer', 'learner'] as const) {
    db.prepare(
      `INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, session_key_prefix, source, created_at, updated_at)
       VALUES (?, 'ws-mig041', ?, ?, ?, '🛠️', 'standby', NULL, 'local', ?, ?)`
    ).run(`boot-${role}`, `${role.charAt(0).toUpperCase() + role.slice(1)} Agent`, role, `${role} — core team member`, now, now);
  }

  const migration041 = migrations.find(m => m.id === '041');
  assert.ok(migration041, 'migration 041 must exist');
  migration041!.up(db);

  // 1) tpl-standard now has verify stage with role verifier and is default
  const std = db.prepare("SELECT stages, is_default FROM workflow_templates WHERE id = 'tpl-standard'").get() as { stages: string; is_default: number };
  const stdStages = JSON.parse(std.stages) as Array<{ role: string | null; status: string }>;
  assert.deepEqual(stdStages.map(s => s.status), ['in_progress', 'testing', 'review', 'verification', 'done']);
  assert.equal(stdStages[3].role, 'verifier', 'tpl-standard verify stage must use verifier role');
  assert.equal(std.is_default, 1, 'tpl-standard must be the default template');

  // 2) tpl-strict verify role → verifier, no longer default
  const strict = db.prepare("SELECT stages, is_default FROM workflow_templates WHERE id = 'tpl-strict'").get() as { stages: string; is_default: number };
  const strictStages = JSON.parse(strict.stages) as Array<{ role: string | null }>;
  assert.equal(strictStages[3].role, 'verifier', 'tpl-strict verify stage must resolve to verifier');
  assert.equal(strict.is_default, 0);

  // 3) Exactly one active canonical verifier agent created (create-once)
  const verifiers = db.prepare(
    "SELECT COUNT(*) as cnt FROM agents WHERE workspace_id = 'ws-mig041' AND role = 'verifier' AND status != 'offline'"
  ).get() as { cnt: number };
  assert.equal(Number(verifiers.cnt), 1, 'exactly one canonical verifier agent');
  const verifier = db.prepare(
    "SELECT session_key_prefix FROM agents WHERE workspace_id = 'ws-mig041' AND role = 'verifier' AND status != 'offline'"
  ).get() as { session_key_prefix: string };
  assert.equal(verifier.session_key_prefix, 'agent:verifier:');

  // 4) Re-running 041 must not duplicate the verifier agent
  migration041!.up(db);
  const again = db.prepare(
    "SELECT COUNT(*) as cnt FROM agents WHERE workspace_id = 'ws-mig041' AND role = 'verifier' AND status != 'offline'"
  ).get() as { cnt: number };
  assert.equal(Number(again.cnt), 1, 'create-once: no duplicate on re-run');

  db.close();
});
