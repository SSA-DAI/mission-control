/**
 * PLATFORM-010 (D3) — Task session health snapshot integration tests.
 *
 * Exercises buildTaskSessionHealth (the logic behind GET
 * /api/tasks/[id]/planning/health) against a scratch DB with fake gateway
 * providers — no live gateway needed.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';

let db: typeof import('@/lib/db');
const dbPath = `.tmp/p010-health-snapshot-${process.pid}.db`;

before(async () => {
  process.env.DATABASE_PATH = dbPath;
  db = await import('@/lib/db');
});

after(() => {
  try {
    unlinkSync(dbPath);
  } catch {
    // already gone
  }
});

function seed(taskId: string) {
  const now = new Date().toISOString();
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  db.run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '📁', ?, ?)`,
    [now, now]
  );

  db.run(
    `INSERT OR REPLACE INTO agents (id, name, role, avatar_emoji, status, workspace_id, source, session_key_prefix, created_at, updated_at)
     VALUES ('agent-builder', 'Builder', 'builder', '🛡️', 'standby', 'default', 'local', 'agent:builder:', ?, ?)`,
    [minsAgo(120), now]
  );

  db.run(
    `INSERT OR REPLACE INTO tasks
       (id, title, status, priority, assigned_agent_id, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Health snapshot', 'in_progress', 'high', 'agent-builder', 'default', 'default', ?, ?)`,
    [taskId, minsAgo(120), minsAgo(2)]
  );

  // Rotated run-1 session (memory-flush corruption, MRN-104 pattern)
  db.run(
    `INSERT OR REPLACE INTO openclaw_sessions
       (id, agent_id, openclaw_session_id, status, session_type, task_id, total_tokens, context_tokens,
        run_number, rotated_from, rotation_reason, file_size_bytes, created_at, updated_at)
     VALUES ('sess-r1', 'agent-builder', 'mission-control-builder-task-r1-old', 'rotated', 'persistent', ?, 900_000, 0,
        1, NULL, 'total_tokens_exceeded:900000>1000000', 3_000_000, ?, ?)`,
    [taskId, minsAgo(90), minsAgo(90)]
  );

  // Active run-2 session (healthy but >50% cap → degraded)
  db.run(
    `INSERT OR REPLACE INTO openclaw_sessions
       (id, agent_id, openclaw_session_id, status, session_type, task_id, total_tokens, context_tokens,
        run_number, rotated_from, rotation_reason, created_at, updated_at)
     VALUES ('sess-r2', 'agent-builder', 'mission-control-builder-task-r2-abc123', 'active', 'persistent', ?, 600_000, 0,
        2, 'sess-r1', NULL, ?, ?)`,
    [taskId, minsAgo(10), minsAgo(2)]
  );

  // Token rate alert in the activity feed
  db.run(
    `INSERT OR REPLACE INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES ('act-alert', ?, 'agent-builder', 'token_rate_alert', '⚠️ TOKEN RATE ALERT: Builder consumed 710,000 tokens in the last 10 minutes', ?)`,
    [taskId, minsAgo(5)]
  );
}

test('buildTaskSessionHealth: DB-only (gateway down) still returns truthful data', async () => {
  const taskId = 'p010-health-task-1';
  seed(taskId);

  const { buildTaskSessionHealth } = await import('./task-session-health');
  const snap = await buildTaskSessionHealth(taskId, {
    listGatewaySessions: async () => { throw new Error('gateway down'); },
    getHistory: async () => { throw new Error('gateway down'); },
  }, Date.now());

  assert.equal(snap.taskId, taskId);
  assert.equal(snap.gatewayReachable, false, 'gateway outage is surfaced, not fatal');
  assert.equal(snap.sessions.length, 2, 'both runs listed (newest first)');

  const current = snap.sessions[0];
  assert.equal(current.sessionId, 'mission-control-builder-task-r2-abc123');
  assert.equal(current.runNumber, 2);
  assert.equal(current.agentName, 'Builder');
  assert.equal(current.status, 'active');
  assert.equal(current.totalTokens, 600_000);
  assert.equal(current.health, 'degraded', '600k tokens > 50% of 1M cap → degraded 🟡');
  assert.equal(current.ageSeconds > 0, true, 'umur sesi computed');
  assert.equal(current.fileSizeBytes, null, 'no history → no live file size');
  assert.equal(current.rotatedFrom, 'sess-r1', 'rotation origin recorded');

  // Rotated session present in rotations history
  assert.equal(snap.rotations.length, 1);
  assert.equal(snap.rotations[0].runNumber, 1);
  assert.ok(snap.rotations[0].reason.includes('total_tokens_exceeded'));

  // Alert surfaced from activity feed
  assert.equal(snap.alerts.length, 1);
  assert.equal(snap.alerts[0].activityType, 'token_rate_alert');
});

test('buildTaskSessionHealth: corruption markers + live file size from gateway history', async () => {
  const taskId = 'p010-health-task-2';
  seed(taskId);

  const { buildTaskSessionHealth } = await import('./task-session-health');
  const history = [
    { role: 'user', content: 'read file /repo/a.ts' },
    { role: 'assistant', content: 'Error: Path escapes sandbox root' },
    { role: 'assistant', content: 'Error: Memory flush writes are restricted' },
    { role: 'assistant', content: 'ok'.repeat(500) },
  ];
  const snap = await buildTaskSessionHealth(taskId, {
    listGatewaySessions: async () => [],
    getHistory: async (key: string) => (key.endsWith('mission-control-builder-task-r2-abc123') ? history : []),
  }, Date.now());

  const current = snap.sessions[0];
  assert.equal(current.health, 'unhealthy', 'memory-flush marker in history → unhealthy 🔴');
  assert.ok(
    current.healthReasons.some(r => r.includes('session_corrupted')),
    `corruption reason present: ${current.healthReasons.join('; ')}`
  );
  assert.equal(current.corruptionMarker, 'Path escapes sandbox root');
  assert.ok(
    current.fileSizeBytes !== null && current.fileSizeBytes > 1000,
    `live file size estimated from history: ${current.fileSizeBytes}`
  );
  assert.equal(snap.gatewayReachable, true);
});

test('buildTaskSessionHealth: no sessions → empty snapshot (not an error)', async () => {
  const { buildTaskSessionHealth } = await import('./task-session-health');
  const snap = await buildTaskSessionHealth('p010-health-task-none', {
    listGatewaySessions: async () => [],
    getHistory: async () => [],
  }, Date.now());
  assert.equal(snap.sessions.length, 0);
  assert.equal(snap.rotations.length, 0);
  assert.equal(snap.alerts.length, 0);
});
