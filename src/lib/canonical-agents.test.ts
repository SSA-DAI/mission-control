import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { run, queryOne } from './db';
import { schema } from './db/schema';
import { migrations } from './db/migrations';
import {
  mapRoleToCanonical,
  ensureCanonicalAgent,
  CANONICAL_ROLES,
} from './canonical-agents';

// ── Role keyword mapping ──

test('mapRoleToCanonical: keyword build → builder', () => {
  assert.equal(mapRoleToCanonical('build something'), 'builder');
  assert.equal(mapRoleToCanonical('architect'), 'builder');
  assert.equal(mapRoleToCanonical('code review'), 'builder');
  assert.equal(mapRoleToCanonical('implement feature'), 'builder');
});

test('mapRoleToCanonical: keyword test → tester', () => {
  assert.equal(mapRoleToCanonical('verify results'), 'tester');
  assert.equal(mapRoleToCanonical('quality assurance'), 'tester');
  assert.equal(mapRoleToCanonical('ensure compliance'), 'tester');
  assert.equal(mapRoleToCanonical('validate output'), 'tester');
});

test('mapRoleToCanonical: keyword review → reviewer', () => {
  assert.equal(mapRoleToCanonical('audit security'), 'reviewer');
  assert.equal(mapRoleToCanonical('inspect output'), 'reviewer');
  assert.equal(mapRoleToCanonical('examine results'), 'reviewer');
  assert.equal(mapRoleToCanonical('check compliance'), 'reviewer');
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

test('mapRoleToCanonical: first matching keyword wins (builder before tester)', () => {
  // 'test and build' contains both 'build' (builder) and 'test' (tester)
  // builder is iterated first in CANONICAL_ROLES, so 'build' wins
  assert.equal(mapRoleToCanonical('test and build'), 'builder');
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

test('ensureCanonicalAgent: creates all 4 canonical roles', () => {
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
  assert.equal(ids.size, 4, 'should create 4 distinct canonical agents');

  // Verify all 4 exist in DB
  const count = queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM agents WHERE workspace_id = ? AND role IN (?,?,?,?) AND status != \'offline\'',
    [wsId, ...CANONICAL_ROLES]
  );
  assert.equal(Number(count!.count), 4);
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

test('migration 038: reuses NULL-prefix bootstrap agents and disables mrnav-* (no duplicates)', () => {
  // Regression for the migration deliverable: on deploy, 038 must NOT create +4
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
