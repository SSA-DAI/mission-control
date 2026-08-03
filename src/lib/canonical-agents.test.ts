import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from './db';
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
     VALUES (?, 'Test WS', 'test-ws', '📁', datetime('now'), datetime('now'))`,
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
