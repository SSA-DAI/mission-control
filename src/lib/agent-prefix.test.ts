import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './db';
import {
  resolveAgentSessionPrefix,
  getGatewayAgentPrefix,
  getMasterAgentPrefix,
  CANONICAL_ROLE_PREFIXES,
} from './agent-prefix';

// PLATFORM-002 regression tests: agent session-prefix resolution must NEVER
// fall back to the legacy 'agent:main:' prefix (no such gateway agent exists).

function seedGatewayAgent(name: string, prefix: string) {
  run(
    `INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, model, source, gateway_agent_id, session_key_prefix, created_at, updated_at)
     VALUES (lower(hex(randomblob(16))), ?, 'builder', 'gateway-synced', '🔗', 0, 'default', NULL, 'gateway', ?, ?, datetime('now'), datetime('now'))`,
    [name, name, prefix]
  );
}

function seedWorkspaceAgent(name: string, workspaceId: string, opts: { isMaster?: boolean; prefix?: string | null } = {}) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES (?, 'Test WS', 'test-ws', '📁', datetime('now'), datetime('now'))`,
    [workspaceId]
  );
  run(
    `INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, model, source, session_key_prefix, created_at, updated_at)
     VALUES (lower(hex(randomblob(16))), ?, 'builder', 'local', '🤖', ?, ?, NULL, 'local', ?, datetime('now'), datetime('now'))`,
    [name, opts.isMaster ? 1 : 0, workspaceId, opts.prefix ?? null]
  );
}

test('resolver never returns legacy agent:main: when nothing matches', () => {
  const ws = crypto.randomUUID();
  // no master, no gateway agents at all
  assert.equal(getMasterAgentPrefix(ws), null);
  assert.equal(getGatewayAgentPrefix('builder'), null);
  assert.equal(resolveAgentSessionPrefix(ws, 'builder'), null);
});

test('master agent prefix wins when present', () => {
  const ws = crypto.randomUUID();
  seedWorkspaceAgent('master-agent', ws, { isMaster: true, prefix: 'agent:custom:' });
  assert.equal(getMasterAgentPrefix(ws), 'agent:custom:');
  assert.equal(resolveAgentSessionPrefix(ws, 'builder'), 'agent:custom:');
});

test('canonical gateway agent prefix resolved by name (case-insensitive)', () => {
  seedGatewayAgent('builder', 'agent:builder:');
  assert.equal(getGatewayAgentPrefix('builder'), 'agent:builder:');
  assert.equal(getGatewayAgentPrefix('BUILDER'), 'agent:builder:');
  assert.equal(resolveAgentSessionPrefix(null, 'builder'), 'agent:builder:');
});

test('role-map match only returns prefix when a gateway agent exists for it', () => {
  seedGatewayAgent('tester', 'agent:tester:');
  assert.equal(getGatewayAgentPrefix('Quality assurance tester'), 'agent:tester:');
  // reviewer gateway agent not seeded -> role match must NOT invent the prefix
  assert.equal(getGatewayAgentPrefix('reviewer'), null);
});

test('custom planning agent names without gateway match resolve to null (no agent:main:)', () => {
  assert.equal(getGatewayAgentPrefix('mrn-007-implementer'), null);
  assert.equal(resolveAgentSessionPrefix(crypto.randomUUID(), 'mrn-007-implementer'), null);
});

test('canonical role map contains exactly the gateway agent roles', () => {
  assert.deepEqual(Object.keys(CANONICAL_ROLE_PREFIXES).sort(), ['builder', 'learner', 'main', 'reviewer', 'tester']);
  assert.equal(CANONICAL_ROLE_PREFIXES.builder, 'agent:builder:');
  assert.equal(CANONICAL_ROLE_PREFIXES.tester, 'agent:tester:');
  assert.equal(CANONICAL_ROLE_PREFIXES.reviewer, 'agent:reviewer:');
  assert.equal(CANONICAL_ROLE_PREFIXES.learner, 'agent:learner:');
  assert.equal(CANONICAL_ROLE_PREFIXES.main, 'agent:main:');
  // PLATFORM-006: manager agent retired — must not resolve to a legacy prefix
  assert.equal(getGatewayAgentPrefix('manager'), null);
});
