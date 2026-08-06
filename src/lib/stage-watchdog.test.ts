/**
 * PLATFORM-022 — Stage Watchdog tests.
 *
 * Covers (per planning decisions + task acceptance):
 *  1. stuck in_progress task (active session, silent) → auto-recovered:
 *     session ended with rotation_reason=stage_stall:auto-recovery, task
 *     re-dispatched, stage_restart_count bumped, activities recorded.
 *  2. testing task with an already-ended session → recovered without an
 *     end-session step (skip end, re-dispatch directly).
 *  3. freshly dispatched task (session age < STAGE_STALL_TIMEOUT_MS) → skipped.
 *  4. concurrent sweep → no double action (recovery in flight backs off;
 *     recovered task with a fresh session is not re-touched).
 *  5. MAX_STAGE_RESTART exhausted → menunggu_keputusan_manusia (never stuck
 *     forever, no further re-dispatch).
 *  6. last-activity WINDOW: recent stage activity → skipped even when the
 *     session is old (decision B — not zero-activity-only).
 *  7. sweep only acts on genuinely stalled tasks.
 *  8. re-dispatch failure → fail fast to human decision (no sweep loop).
 *  9. metadata JSON helpers (stage_restart_count read/merge).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { run, queryOne } from './db';
import {
  STAGE_STALL_ROTATION_REASON,
  HUMAN_DECISION_STATUS,
  MAX_STAGE_RESTART,
  handleStalledStage,
  checkStageStalls,
  readStageRestartCount,
  withStageRestartCount,
  type RedispatchResult,
} from './stage-watchdog';

// ── helpers ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const OLD_ISO = new Date(NOW - 2 * 60 * 60 * 1000).toISOString(); // 2h ago → stale

function seedTask(opts: {
  status?: string;
  metadata?: string | null;
}): string {
  const taskId = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, metadata, created_at, updated_at)
     VALUES (?, 'Stage Watchdog Test', 'test task', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [taskId, opts.status ?? 'in_progress', opts.metadata ?? null]
  );
  return taskId;
}

function seedSession(opts: {
  taskId: string;
  status?: string;
  createdAt?: string;
  endedAt?: string | null;
  rotationReason?: string | null;
}): string {
  const sessionId = crypto.randomUUID();
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, status, task_id, ended_at, rotation_reason, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      `mission-control-test-${sessionId}`,
      opts.status ?? 'active',
      opts.taskId,
      opts.endedAt ?? null,
      opts.rotationReason ?? null,
      opts.createdAt ?? OLD_ISO,
      opts.createdAt ?? OLD_ISO,
    ]
  );
  return sessionId;
}

function seedActivity(taskId: string, activityType: string, createdAt: string): void {
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, NULL, ?, 'test activity', ?)`,
    [crypto.randomUUID(), taskId, activityType, createdAt]
  );
}

/** Redispatch mock that records calls AND creates a fresh active session
 *  (mirrors what the real dispatch path does), so a second sweep sees a fresh
 *  session and backs off. */
function makeRedispatch(taskId: string, counter: { calls: number }) {
  return async (): Promise<RedispatchResult> => {
    counter.calls += 1;
    const freshId = crypto.randomUUID();
    run(
      `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, status, task_id, created_at, updated_at)
       VALUES (?, NULL, ?, 'active', ?, ?, ?)`,
      [freshId, `mission-control-fresh-${freshId}`, taskId, new Date(NOW).toISOString(), new Date(NOW).toISOString()]
    );
    return { ok: true, sessionId: `mission-control-fresh-${freshId}` };
  };
}

function getTask(taskId: string) {
  return queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [taskId])!;
}

function getSession(sessionId: string) {
  return queryOne<Record<string, unknown>>('SELECT * FROM openclaw_sessions WHERE id = ?', [sessionId])!;
}

function getLatestSession(taskId: string) {
  return queryOne<Record<string, unknown>>(
    'SELECT * FROM openclaw_sessions WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    [taskId]
  );
}

function activityCount(taskId: string, type: string): number {
  const row = queryOne<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM task_activities WHERE task_id = ? AND activity_type = ?',
    [taskId, type]
  );
  return row?.cnt ?? 0;
}

// ── 1. stuck in_progress → recovered ────────────────────────────────────────

test('stuck in_progress (old active session, no activity) → session ended + re-dispatched', async () => {
  const taskId = seedTask({ status: 'in_progress' });
  const sessionId = seedSession({ taskId, status: 'active' });

  const counter = { calls: 0 };
  const redispatch = makeRedispatch(taskId, counter);
  const result = await handleStalledStage(taskId, { now: () => NOW, redispatch });

  assert.equal(result.action, 'restarted');
  assert.equal((result as { attempt: number }).attempt, 1);

  const task = getTask(taskId);
  assert.equal(task.status, 'in_progress', 'task stays in the stage (recovery re-dispatches it)');
  assert.equal(readStageRestartCount(task.metadata as string), 1, 'restart counter bumped in metadata');

  const ended = getSession(sessionId);
  assert.equal(ended.status, 'ended');
  assert.equal(ended.rotation_reason, STAGE_STALL_ROTATION_REASON);
  assert.ok(ended.ended_at, 'ended_at recorded');

  assert.equal(counter.calls, 1, 're-dispatch fired exactly once');

  assert.equal(activityCount(taskId, 'stage_stall_detected'), 1);
  assert.equal(activityCount(taskId, 'session_rotated'), 1);
  const rotated = queryOne<{ metadata?: string | null }>(
    `SELECT metadata FROM task_activities WHERE task_id = ? AND activity_type = 'session_rotated' ORDER BY created_at DESC LIMIT 1`,
    [taskId]
  );
  const meta = JSON.parse(rotated!.metadata ?? '{}') as { rotation_reason?: string; attempt?: number };
  assert.equal(meta.rotation_reason, STAGE_STALL_ROTATION_REASON);
  assert.equal(meta.attempt, 1);
});

// ── 2. testing + ended session → recovered (skip end, re-dispatch) ──────────

test('testing task with already-ended session → re-dispatched without ending again', async () => {
  const taskId = seedTask({ status: 'testing' });
  const sessionId = seedSession({
    taskId,
    status: 'ended',
    endedAt: OLD_ISO,
    rotationReason: 'total_tokens_exceeded', // P018 signature, not a watchdog end
  });

  const counter = { calls: 0 };
  const redispatch = makeRedispatch(taskId, counter);
  const result = await handleStalledStage(taskId, { now: () => NOW, redispatch });

  assert.equal(result.action, 'restarted');
  assert.equal((result as { attempt: number }).attempt, 1);
  assert.equal(counter.calls, 1);

  const task = getTask(taskId);
  assert.equal(readStageRestartCount(task.metadata as string), 1);

  const session = getSession(sessionId);
  assert.equal(session.status, 'ended', 'already-ended session untouched');
  assert.equal(session.rotation_reason, 'total_tokens_exceeded', 'original rotation reason preserved');
  assert.equal(session.ended_at, OLD_ISO, 'ended_at not overwritten');

  assert.equal(activityCount(taskId, 'stage_stall_detected'), 1);
  assert.equal(activityCount(taskId, 'session_rotated'), 1);
});

// ── 3. fresh dispatch → skipped ─────────────────────────────────────────────

test('freshly dispatched task (session age < timeout) is NOT touched', async () => {
  const taskId = seedTask({ status: 'in_progress' });
  const sessionId = seedSession({ taskId, status: 'active', createdAt: new Date(NOW).toISOString() });

  const counter = { calls: 0 };
  const redispatch = makeRedispatch(taskId, counter);
  const result = await handleStalledStage(taskId, { now: () => NOW, redispatch });

  assert.equal(result.action, 'skipped');
  assert.equal((result as { reason: string }).reason, 'not_stalled_yet');

  const task = getTask(taskId);
  assert.equal(readStageRestartCount(task.metadata as string), 0, 'counter untouched');
  assert.equal(getSession(sessionId).status, 'active', 'session untouched');
  assert.equal(counter.calls, 0, 'no re-dispatch');
  assert.equal(activityCount(taskId, 'stage_stall_detected'), 0);
});

// ── 4. concurrent sweep → no double action ──────────────────────────────────

test('concurrent sweep: recovery in flight (ended session just marked) → backs off', async () => {
  const taskId = seedTask({ status: 'in_progress' });
  // Session already ended by a previous watchdog claim moments ago.
  seedSession({
    taskId,
    status: 'ended',
    endedAt: new Date(NOW - 30 * 1000).toISOString(),
    rotationReason: STAGE_STALL_ROTATION_REASON,
  });

  const counter = { calls: 0 };
  const redispatch = makeRedispatch(taskId, counter);
  const result = await handleStalledStage(taskId, { now: () => NOW, redispatch });

  assert.equal(result.action, 'skipped');
  assert.equal((result as { reason: string }).reason, 'already_recovering');
  assert.equal(counter.calls, 0, 'no double dispatch');
  assert.equal(readStageRestartCount(getTask(taskId).metadata as string), 0, 'counter not double-bumped');
});

test('concurrent sweep: after a successful recovery the fresh session is not re-touched', async () => {
  const taskId = seedTask({ status: 'in_progress' });
  const sessionId = seedSession({ taskId, status: 'active' });

  const counter = { calls: 0 };
  const redispatch = makeRedispatch(taskId, counter);

  // First sweep recovers (ends session, "re-dispatches" → fresh active session).
  const r1 = await handleStalledStage(taskId, { now: () => NOW, redispatch });
  assert.equal(r1.action, 'restarted');

  // Second sweep arrives concurrently → must see the fresh session and skip.
  const r2 = await handleStalledStage(taskId, { now: () => NOW, redispatch });
  assert.equal(r2.action, 'skipped');
  assert.equal((r2 as { reason: string }).reason, 'not_stalled_yet');

  assert.equal(counter.calls, 1, 'exactly one re-dispatch total');
  assert.equal(getSession(sessionId).status, 'ended');
  const latest = getLatestSession(taskId);
  assert.equal(latest!.status, 'active', 'fresh session is the latest');
});

test('two sequential stalled sessions exhaust the budget — no double action per stall', async () => {
  // Simulate: stall #1 recovered (counter 1, fresh session), stall #2 (fresh
  // session also goes silent) recovers again (counter 2), then the budget is
  // exhausted. Each successive session is created LATER than the previous one
  // (created_at stays monotonic so the latest-session lookup is deterministic)
  // but still older than STAGE_STALL_TIMEOUT_MS.
  const taskId = seedTask({ status: 'review' });
  const session1 = seedSession({ taskId, status: 'active' }); // 2h ago

  const counter = { calls: 0 };
  const redispatch = makeRedispatch(taskId, counter);

  const r1 = await handleStalledStage(taskId, { now: () => NOW, redispatch });
  assert.equal(r1.action, 'restarted');
  assert.equal(readStageRestartCount(getTask(taskId).metadata as string), 1);

  // Stall #2: age the fresh session to 90 min ago (newer than session #1's 2h,
  // still > 30 min timeout). Also age recovery #1's activities (stamped with
  // real datetime('now'), which is "recent" relative to the fake clock).
  const session2 = getLatestSession(taskId) as { id: string };
  const old90 = new Date(NOW - 90 * 60 * 1000).toISOString();
  run(`UPDATE openclaw_sessions SET created_at = ?, updated_at = ? WHERE id = ?`, [old90, old90, session2.id]);
  run(`UPDATE task_activities SET created_at = ? WHERE task_id = ?`, [old90, taskId]);

  const r2 = await handleStalledStage(taskId, { now: () => NOW, redispatch });
  assert.equal(r2.action, 'restarted');
  assert.equal(readStageRestartCount(getTask(taskId).metadata as string), 2);

  // Stall #3: age the newest session to 60 min ago → budget exhausted.
  const session3 = getLatestSession(taskId) as { id: string };
  const old60 = new Date(NOW - 60 * 60 * 1000).toISOString();
  run(`UPDATE openclaw_sessions SET created_at = ?, updated_at = ? WHERE id = ?`, [old60, old60, session3.id]);
  run(`UPDATE task_activities SET created_at = ? WHERE task_id = ?`, [old60, taskId]);

  const r3 = await handleStalledStage(taskId, { now: () => NOW, redispatch });
  assert.equal(r3.action, 'human_decision');
  assert.equal(counter.calls, 2, 'only the two allowed re-dispatches happened');
  assert.equal(getTask(taskId).status, HUMAN_DECISION_STATUS);
});

// ── 5. MAX_STAGE_RESTART exhausted → human decision ─────────────────────────

test('MAX_STAGE_RESTART reached → menunggu_keputusan_manusia, no further dispatch', async () => {
  const taskId = seedTask({
    status: 'verification',
    metadata: JSON.stringify({ stage_restart_count: MAX_STAGE_RESTART }),
  });
  const sessionId = seedSession({ taskId, status: 'active' });

  const counter = { calls: 0 };
  const redispatch = makeRedispatch(taskId, counter);
  const result = await handleStalledStage(taskId, { now: () => NOW, redispatch });

  assert.equal(result.action, 'human_decision');

  const task = getTask(taskId);
  assert.equal(task.status, HUMAN_DECISION_STATUS);
  assert.equal(readStageRestartCount(task.metadata as string), MAX_STAGE_RESTART, 'counter stays at the cap');
  assert.ok(String(task.status_reason).includes('menunggu keputusan manusia'));

  const ended = getSession(sessionId);
  assert.equal(ended.status, 'ended', 'stalled active session is still ended for the audit trail');
  assert.equal(ended.rotation_reason, STAGE_STALL_ROTATION_REASON);

  assert.equal(counter.calls, 0, 'no re-dispatch past the limit');
  assert.equal(activityCount(taskId, 'stage_stall_detected'), 1);
  assert.equal(activityCount(taskId, 'stage_decision_needed'), 1);
});

// ── 6. last-activity window (decision B) ────────────────────────────────────

test('old session with RECENT stage activity → skipped (last-activity window, not zero-activity-only)', async () => {
  const taskId = seedTask({ status: 'in_progress' });
  seedSession({ taskId, status: 'active' }); // 2h old
  seedActivity(taskId, 'status_changed', new Date(NOW - 10 * 60 * 1000).toISOString()); // 10 min ago

  const counter = { calls: 0 };
  const redispatch = makeRedispatch(taskId, counter);
  const result = await handleStalledStage(taskId, { now: () => NOW, redispatch });

  assert.equal(result.action, 'skipped');
  assert.equal((result as { reason: string }).reason, 'recent_activity');
  assert.equal(counter.calls, 0);
  assert.equal(readStageRestartCount(getTask(taskId).metadata as string), 0);
});

test('old session with activity only older than the timeout → stalled (catches P020 hang)', async () => {
  const taskId = seedTask({ status: 'review' });
  seedSession({ taskId, status: 'active' }); // 2h old
  seedActivity(taskId, 'session_rotated', new Date(NOW - 40 * 60 * 1000).toISOString()); // 40 min ago

  const counter = { calls: 0 };
  const redispatch = makeRedispatch(taskId, counter);
  const result = await handleStalledStage(taskId, { now: () => NOW, redispatch });

  assert.equal(result.action, 'restarted');
  assert.equal(counter.calls, 1);
});

// ── 7. sweep ────────────────────────────────────────────────────────────────

test('checkStageStalls acts only on genuinely stalled tasks', async () => {
  const stuck = seedTask({ status: 'in_progress' });
  seedSession({ taskId: stuck, status: 'active' });

  const ended = seedTask({ status: 'testing' });
  seedSession({ taskId: ended, status: 'ended', endedAt: OLD_ISO, rotationReason: 'gateway_status:done' });

  const fresh = seedTask({ status: 'in_progress' });
  seedSession({ taskId: fresh, status: 'active', createdAt: new Date(NOW).toISOString() });

  const counter = { calls: 0 };
  const redispatch = async (taskId: string): Promise<RedispatchResult> => {
    counter.calls += 1;
    run(
      `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, status, task_id, created_at, updated_at)
       VALUES (?, NULL, ?, 'active', ?, ?, ?)`,
      [crypto.randomUUID(), `fresh-${crypto.randomUUID()}`, taskId, new Date(NOW).toISOString(), new Date(NOW).toISOString()]
    );
    return { ok: true, sessionId: 'fresh' };
  };

  const acted = await checkStageStalls({ now: () => NOW, redispatch });

  // The sweep scans the WHOLE shared test DB, so other test files' leftover
  // stage-status tasks may also be acted upon. The contract is per-task: the
  // stuck + ended-session tasks are recovered, the fresh one is untouched.
  assert.ok(acted >= 2, `expected at least our 2 stalled tasks acted, got ${acted}`);
  assert.equal(counter.calls >= 2, true, 'our stalled tasks were re-dispatched');
  assert.equal(readStageRestartCount(getTask(stuck).metadata as string), 1);
  assert.equal(readStageRestartCount(getTask(ended).metadata as string), 1);
  assert.equal(readStageRestartCount(getTask(fresh).metadata as string), 0, 'fresh task never touched');
  assert.equal(getTask(fresh).status, 'in_progress', 'fresh task stays in stage');
});

// ── 8. re-dispatch failure → human decision ─────────────────────────────────

test('re-dispatch failure → menunggu_keputusan_manusia (fail fast, no sweep loop)', async () => {
  const taskId = seedTask({ status: 'in_progress' });
  seedSession({ taskId, status: 'active' });

  const result = await handleStalledStage(taskId, {
    now: () => NOW,
    redispatch: async () => ({ ok: false, error: 'OpenClaw gateway unreachable' }),
  });

  assert.equal(result.action, 'human_decision');

  const task = getTask(taskId);
  assert.equal(task.status, HUMAN_DECISION_STATUS);
  assert.ok(String(task.status_reason).includes('OpenClaw gateway unreachable'));
  assert.ok(String(task.planning_dispatch_error).toLowerCase().includes('stage watchdog'), 'error surfaced in planning_dispatch_error');
  assert.equal(activityCount(taskId, 'stage_decision_needed'), 1);
});

// ── 9. metadata helpers ─────────────────────────────────────────────────────

test('metadata helpers: read + merge stage_restart_count without clobbering other keys', () => {
  assert.equal(readStageRestartCount(null), 0);
  assert.equal(readStageRestartCount('not json'), 0);
  assert.equal(readStageRestartCount('{"other":1}'), 0);
  assert.equal(readStageRestartCount('{"stage_restart_count":3}'), 3);
  assert.equal(readStageRestartCount('{"stage_restart_count":-5}'), 0, 'negative clamps to 0');

  const merged = JSON.parse(withStageRestartCount('{"other":"keep"}', 2)) as Record<string, unknown>;
  assert.equal(merged.stage_restart_count, 2);
  assert.equal(merged.other, 'keep', 'existing keys preserved');

  const fresh = JSON.parse(withStageRestartCount(null, 1)) as Record<string, unknown>;
  assert.equal(fresh.stage_restart_count, 1);
});

// ── guard: non-stage status is out of scope ─────────────────────────────────

test('task in a non-stage status is never recovered (e.g. assigned → handled by health sweeper)', async () => {
  const taskId = seedTask({ status: 'assigned' });
  seedSession({ taskId, status: 'active' });

  const counter = { calls: 0 };
  const redispatch = makeRedispatch(taskId, counter);
  const result = await handleStalledStage(taskId, { now: () => NOW, redispatch });

  assert.equal(result.action, 'skipped');
  assert.equal((result as { reason: string }).reason, 'status_assigned');
  assert.equal(counter.calls, 0);
});
