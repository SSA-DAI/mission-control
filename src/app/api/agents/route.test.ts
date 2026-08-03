import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mapHealthToDbStatus } from './route';

type RunFn = typeof import('@/lib/db').run;

let db: { run: RunFn; queryOne: typeof import('@/lib/db').queryOne; queryAll: typeof import('@/lib/db').queryAll };
const dbPath = `.tmp/agents-route-test-${process.pid}.db`;

before(async () => {
  process.env.DATABASE_PATH = dbPath;
  db = await import('@/lib/db');
  // Schema is auto-created by db init
});

after(() => {
  try {
    require('fs').unlinkSync(dbPath);
  } catch {}
});

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

// ── mapping unit tests ──

test('mapHealthToDbStatus: idle → standby', () => {
  assert.equal(mapHealthToDbStatus('idle'), 'standby');
});

test('mapHealthToDbStatus: working → working', () => {
  assert.equal(mapHealthToDbStatus('working'), 'working');
});

test('mapHealthToDbStatus: stalled → working', () => {
  assert.equal(mapHealthToDbStatus('stalled'), 'working');
});

test('mapHealthToDbStatus: stuck → working', () => {
  assert.equal(mapHealthToDbStatus('stuck'), 'working');
});

test('mapHealthToDbStatus: zombie → offline', () => {
  assert.equal(mapHealthToDbStatus('zombie'), 'offline');
});

test('mapHealthToDbStatus: offline → offline', () => {
  assert.equal(mapHealthToDbStatus('offline'), 'offline');
});

test('mapHealthToDbStatus: unknown state → offline (safe default)', () => {
  assert.equal(mapHealthToDbStatus('an_invalid_state'), 'offline');
});

test('mapHealthToDbStatus: all 6 health states produce valid DB status', () => {
  const validDbStatuses = new Set(['standby', 'working', 'offline']);
  for (const state of ['idle', 'working', 'stalled', 'stuck', 'zombie', 'offline']) {
    const result = mapHealthToDbStatus(state);
    assert.ok(validDbStatuses.has(result), `${state} → ${result} is a valid DB status`);
  }
});

test('mapHealthToDbStatus: all return values satisfy CHECK constraint', () => {
  const valid = new Set(['standby', 'working', 'offline']);
  const results = new Set([
    mapHealthToDbStatus('idle'),
    mapHealthToDbStatus('working'),
    mapHealthToDbStatus('stalled'),
    mapHealthToDbStatus('stuck'),
    mapHealthToDbStatus('zombie'),
    mapHealthToDbStatus('offline'),
  ]);
  for (const r of results) {
    assert.ok(valid.has(r), `${r} satisfies CHECK constraint`);
  }
});

// ── integration: GET /api/agents health enrichment ──

function seedTestData() {
  const now = minutesAgo(0);

  db.run(`INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
          VALUES ('default', 'Default', 'default', '📁', ?, ?)`,
    [now, now]);

  // Agent 1: has active task + active session = working
  const agent1Id = 'agent-working-1';
  db.run(`INSERT OR REPLACE INTO agents (id, name, role, avatar_emoji, status, workspace_id, source, created_at, updated_at)
          VALUES (?, 'Builder', 'builder', '🤖', 'standby', 'default', 'local', ?, ?)`,
    [agent1Id, minutesAgo(30), now]);

  const task1Id = 'task-working-1';
  db.run(`INSERT OR REPLACE INTO tasks (id, title, status, priority, assigned_agent_id, workspace_id, business_id, created_at, updated_at)
          VALUES (?, 'Build feature X', 'in_progress', 'high', ?, 'default', 'default', ?, ?)`,
    [task1Id, agent1Id, minutesAgo(30), minutesAgo(2)]);

  db.run(`INSERT OR REPLACE INTO openclaw_sessions (id, agent_id, openclaw_session_id, status, session_type, task_id, created_at, updated_at)
          VALUES (?, ?, ?, 'active', 'persistent', ?, ?, ?)`,
    ['sess-working-1', agent1Id, 'session-w1', task1Id, minutesAgo(30), minutesAgo(2)]);

  db.run(`INSERT OR REPLACE INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
          VALUES (?, ?, ?, 'updated', 'Started build', ?)`,
    ['act-working-1', task1Id, agent1Id, minutesAgo(2)]);

  // Agent 2: no active task → idle
  const agent2Id = 'agent-idle-1';
  db.run(`INSERT OR REPLACE INTO agents (id, name, role, avatar_emoji, status, workspace_id, source, created_at, updated_at)
          VALUES (?, 'Reviewer', 'reviewer', '🧐', 'standby', 'default', 'local', ?, ?)`,
    [agent2Id, minutesAgo(60), minutesAgo(60)]);

  // Agent 3: active task but NO session → zombie
  const agent3Id = 'agent-zombie-1';
  db.run(`INSERT OR REPLACE INTO agents (id, name, role, avatar_emoji, status, workspace_id, source, created_at, updated_at)
          VALUES (?, 'MrNav-Dev', 'navigator', '🧭', 'working', 'default', 'local', ?, ?)`,
    [agent3Id, minutesAgo(120), minutesAgo(120)]);

  const task3Id = 'task-zombie-1';
  db.run(`INSERT OR REPLACE INTO tasks (id, title, status, priority, assigned_agent_id, workspace_id, business_id, created_at, updated_at)
          VALUES (?, 'Fix navigation bug', 'assigned', 'normal', ?, 'default', 'default', ?, ?)`,
    [task3Id, agent3Id, minutesAgo(120), minutesAgo(120)]);

  // Agent 4: offline in DB
  const agent4Id = 'agent-offline-1';
  db.run(`INSERT OR REPLACE INTO agents (id, name, role, avatar_emoji, status, workspace_id, source, created_at, updated_at)
          VALUES (?, 'Retired', 'retired', '💤', 'offline', 'default', 'local', ?, ?)`,
    [agent4Id, minutesAgo(300), minutesAgo(300)]);

  return { agent1Id, agent2Id, agent3Id, agent4Id };
}

test('GET /api/agents enriches working agent with health fields', async () => {
  const { agent1Id } = seedTestData();
  
  // We test the enrichment logic directly since the route function is exported
  const { evaluateAgentHealth } = await import('@/lib/agent-health');
  const evaluation = evaluateAgentHealth(agent1Id);

  assert.equal(evaluation.health_state, 'working');
  assert.ok(['active_recently', 'working_silently'].includes(evaluation.display_state));
  assert.ok(evaluation.signals.has_active_session);
  assert.ok(evaluation.signals.latest_activity_message);
  assert.ok(evaluation.last_activity_at);

  // Mapping
  const dbStatus = mapHealthToDbStatus(evaluation.health_state);
  assert.equal(dbStatus, 'working');
});

test('GET /api/agents: idle agent has no active task', async () => {
  const { agent2Id } = seedTestData();
  const { evaluateAgentHealth } = await import('@/lib/agent-health');
  const evaluation = evaluateAgentHealth(agent2Id);

  assert.equal(evaluation.health_state, 'idle');
  assert.equal(evaluation.display_state, 'idle');
  assert.equal(mapHealthToDbStatus(evaluation.health_state), 'standby');
  assert.ok(evaluation.reason.includes('No active task'));
});

test('GET /api/agents: zombie agent (task but no session) shows offline', async () => {
  const { agent3Id } = seedTestData();
  const { evaluateAgentHealth } = await import('@/lib/agent-health');
  const evaluation = evaluateAgentHealth(agent3Id);

  assert.equal(evaluation.health_state, 'zombie');
  assert.equal(evaluation.display_state, 'no_heartbeat');
  assert.equal(evaluation.severity, 'danger');
  assert.equal(mapHealthToDbStatus(evaluation.health_state), 'offline');
  // This is the mrnav-dev scenario — should NOT be 'working'
  assert.notEqual(mapHealthToDbStatus(evaluation.health_state), 'working');
});

test('GET /api/agents: offline agent stays offline', async () => {
  const { agent4Id } = seedTestData();
  const { evaluateAgentHealth } = await import('@/lib/agent-health');
  const evaluation = evaluateAgentHealth(agent4Id);

  assert.equal(evaluation.health_state, 'offline');
  assert.equal(evaluation.display_state, 'offline');
  assert.equal(mapHealthToDbStatus(evaluation.health_state), 'offline');
});

test('enriched response contains all required health fields', async () => {
  const { agent1Id } = seedTestData();
  const { evaluateAgentHealth } = await import('@/lib/agent-health');
  const evaluation = evaluateAgentHealth(agent1Id);

  // Simulate what enrichAgentWithHealth produces
  const enriched = {
    status: mapHealthToDbStatus(evaluation.health_state),
    display_state: evaluation.display_state,
    reason: evaluation.reason,
    latest_activity_message: evaluation.signals.latest_activity_message,
    active_task: evaluation.task_id ? { id: evaluation.task_id } : undefined,
    last_activity_at: evaluation.last_activity_at,
  };

  assert.ok(enriched.display_state, 'display_state must be present');
  assert.ok(enriched.reason, 'reason must be present');
  assert.ok(enriched.last_activity_at || evaluation.health_state === 'idle', 'last_activity_at should be present except for idle');
  assert.ok(enriched.status === 'working' || enriched.status === 'standby' || enriched.status === 'offline', 'status must satisfy CHECK constraint');
});

test('reconciliation no longer produces false WORKING for sessionless agents', async () => {
  const { agent3Id } = seedTestData();
  const { evaluateAgentHealth } = await import('@/lib/agent-health');
  const evaluation = evaluateAgentHealth(agent3Id);
  const mapped = mapHealthToDbStatus(evaluation.health_state);

  // mrnav-dev scenario: task is assigned but no session → should NOT be working
  assert.notEqual(mapped, 'working');
  assert.equal(mapped, 'offline');
  // The old reconciliation would have called this 'working' — we fixed that
});
