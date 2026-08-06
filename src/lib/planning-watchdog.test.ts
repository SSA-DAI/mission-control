/**
 * PLATFORM-014 — Planning Watchdog tests.
 *
 * Covers:
 *  1. stall detection → auto-cancel + restart (state preserved, counter bump)
 *  2. fresh planning (recent activity) → NOT restarted
 *  3. awaiting-user planning (last message is a question) → NOT restarted
 *  4. restart budget exhausted (2×) → menunggu_keputusan_manusia
 *  5. counter reset on successful completion
 *  6. POST /planning/cancel equivalent (cancelPlanningSession) preserves state
 *  7. race conditions: completion wins over watchdog / watchdog wins over
 *     stale completion — no corrupt state
 *  8. restart start failure → human decision (no infinite loop)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { run, queryOne } from './db';
import {
  handleStalledPlanning,
  checkPlanningStalls,
  cancelPlanningSession,
  isAwaitingUser,
  lastPlanningActivityMs,
  HUMAN_DECISION_STATUS,
} from './planning-watchdog';
import { handlePlanningCompletion } from './planning-completion';

// ── helpers ─────────────────────────────────────────────────────────────────

const OLD_TS = '2020-01-01T00:00:00.000Z'; // far past → always "stalled"

function seedTask(opts: {
  status?: string;
  planningMessages?: string;
  planningSpec?: string;
  planningComplete?: number;
  sessionKey?: string | null;
  planningUpdatedAt?: string | null;
  autoRestartCount?: number;
}): string {
  const taskId = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, planning_session_key, planning_messages, planning_spec, planning_complete, planning_updated_at, auto_restart_count, created_at, updated_at)
     VALUES (?, 'Watchdog Test', 'test task', ?, 'default', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      taskId,
      opts.status ?? 'planning',
      opts.sessionKey === undefined ? `agent:main:planning:${taskId}` : opts.sessionKey,
      opts.planningMessages ?? null,
      opts.planningSpec ?? null,
      opts.planningComplete ?? 0,
      opts.planningUpdatedAt === undefined ? OLD_TS : opts.planningUpdatedAt,
      opts.autoRestartCount ?? 0,
    ]
  );
  return taskId;
}

function noopSend(): Promise<void> {
  return Promise.resolve();
}

function failingSend(): Promise<void> {
  return Promise.reject(new Error('OpenClaw unreachable'));
}

function getTask(taskId: string) {
  return queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [taskId])!;
}

// ── 1. stall detection → auto-restart ───────────────────────────────────────

test('stalled planning (old activity, not awaiting user) → auto-restart with preserved state', async () => {
  const messages = JSON.stringify([{ role: 'user', content: 'PLANNING REQUEST...', timestamp: 1577836800000 }]);
  const taskId = seedTask({ planningMessages: messages, planningSpec: JSON.stringify({ title: 'old spec' }) });

  const sent: string[] = [];
  const result = await handleStalledPlanning(taskId, { sendPrompt: async (key) => { sent.push(key); } });

  assert.equal(result.action, 'restarted');
  assert.equal((result as { attempt: number }).attempt, 1);

  const task = getTask(taskId);
  assert.equal(task.auto_restart_count, 1);
  assert.equal(task.status, 'planning');
  assert.ok(String(task.planning_session_key).endsWith(`:r1`), `new session key should be :r1, got ${task.planning_session_key}`);
  assert.equal(sent.length, 1, 'restart must send the initial prompt to the new session');

  // State preserved: old messages archived in planning_history, spec untouched.
  const history = JSON.parse(String(task.planning_history)) as Array<{ sessionKey: string; messages: unknown[] }>;
  assert.equal(history.length, 1);
  assert.equal(history[0].sessionKey, `agent:main:planning:${taskId}`);
  assert.equal(JSON.stringify(history[0].messages), messages);
  assert.equal(task.planning_spec, JSON.stringify({ title: 'old spec' }));

  // Activity log entries exist.
  const activities = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM task_activities WHERE task_id = ? AND activity_type IN ('planning_stall_detected', 'planning_restarted')`,
    [taskId]
  );
  assert.equal(activities!.cnt, 2);
});

// ── 2. fresh planning → skipped ─────────────────────────────────────────────

test('recently-active planning is NOT restarted', async () => {
  const taskId = seedTask({ planningUpdatedAt: new Date().toISOString() });
  const result = await handleStalledPlanning(taskId, { sendPrompt: noopSend });
  assert.equal(result.action, 'skipped');
  assert.equal((result as { reason: string }).reason, 'not_stalled_yet');

  const task = getTask(taskId);
  assert.equal(task.auto_restart_count, 0);
  assert.equal(task.status, 'planning');
  assert.ok(task.planning_session_key, 'session key untouched');
});

// ── 3. awaiting user → skipped ──────────────────────────────────────────────

test('planning awaiting a user answer is NOT restarted (ball is with the human)', async () => {
  const questionMsg = JSON.stringify([
    { role: 'assistant', content: JSON.stringify({ question: 'Pick one?', options: [{ id: 'A', label: 'A' }] }), timestamp: 1577836800000 },
  ]);
  const taskId = seedTask({ planningMessages: questionMsg });

  assert.equal(isAwaitingUser(questionMsg), true);

  const result = await handleStalledPlanning(taskId, { sendPrompt: noopSend });
  assert.equal(result.action, 'skipped');
  assert.equal((result as { reason: string }).reason, 'awaiting_user');

  const task = getTask(taskId);
  assert.equal(task.auto_restart_count, 0);
  assert.equal(task.status, 'planning');
});

// ── 4. restart budget exhausted → human decision ────────────────────────────

test('stall after 2 auto-restarts → menunggu_keputusan_manusia, no new session', async () => {
  const taskId = seedTask({ autoRestartCount: 2 });

  let sent = 0;
  const result = await handleStalledPlanning(taskId, { sendPrompt: async () => { sent++; } });

  assert.equal(result.action, 'human_decision');

  const task = getTask(taskId);
  assert.equal(task.status, HUMAN_DECISION_STATUS);
  assert.equal(task.auto_restart_count, 2, 'counter stays at the cap');
  assert.equal(task.planning_session_key, null, 'session closed');
  assert.equal(sent, 0, 'no restart attempt past the limit');

  const activities = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM task_activities WHERE task_id = ? AND activity_type = 'planning_decision_needed'`,
    [taskId]
  );
  assert.equal(activities!.cnt, 1);
});

test('restart start failure → human decision instead of infinite loop', async () => {
  const taskId = seedTask({});
  const result = await handleStalledPlanning(taskId, { sendPrompt: failingSend });

  assert.equal(result.action, 'human_decision');

  const task = getTask(taskId);
  assert.equal(task.status, HUMAN_DECISION_STATUS);
  assert.equal(task.auto_restart_count, 1, 'attempt consumed');
});

// ── 5. counter reset on completion ──────────────────────────────────────────

test('successful planning completion resets auto_restart_count to 0', async () => {
  const taskId = seedTask({ autoRestartCount: 2, planningMessages: '[]' });

  const { skipped } = await handlePlanningCompletion(
    taskId,
    { status: 'complete', spec: { title: 'spec' }, agents: [] },
    []
  );

  assert.equal(skipped, false);
  const task = getTask(taskId);
  assert.equal(task.planning_complete, 1);
  assert.equal(task.auto_restart_count, 0, 'counter resets when planning succeeds');
  assert.equal(task.status, 'inbox', 'no agent created → back to inbox');
});

// ── 6. safe cancel preserves state ──────────────────────────────────────────

test('cancelPlanningSession preserves messages/spec, clears session, resets counter, returns to inbox', () => {
  const messages = JSON.stringify([{ role: 'user', content: 'hi', timestamp: 1577836800000 }]);
  const spec = JSON.stringify({ title: 'keep me' });
  const taskId = seedTask({ planningMessages: messages, planningSpec: spec, autoRestartCount: 1 });

  const { action, task } = cancelPlanningSession(taskId, 'manual cancel');

  assert.equal(action, 'cancelled');
  assert.equal(task!.status, 'inbox');
  assert.equal(task!.planning_session_key, null);
  assert.equal(task!.planning_messages, messages, 'messages preserved in place');
  assert.equal(task!.planning_spec, spec, 'spec preserved in place');
  assert.equal(task!.auto_restart_count, 0, 'human intervention resets the budget');

  const history = JSON.parse(String(task!.planning_history)) as Array<{ sessionKey: string; messages: unknown[] }>;
  assert.equal(history.length, 1);
  assert.equal(JSON.stringify(history[0].messages), messages);
});

test('cancelPlanningSession with no active session is a noop that still returns to inbox', () => {
  const taskId = seedTask({ sessionKey: null, status: 'menunggu_keputusan_manusia', autoRestartCount: 2 });
  const { action, task } = cancelPlanningSession(taskId, 'manual reset');
  assert.equal(action, 'noop');
  assert.equal(task!.status, 'inbox');
  assert.equal(task!.auto_restart_count, 0);
});

// ── 7. race conditions ──────────────────────────────────────────────────────

test('race: completion lands first → watchdog backs off (no restart, no counter bump)', async () => {
  const taskId = seedTask({ planningMessages: '[]' });

  // Completion wins the race.
  const { skipped } = await handlePlanningCompletion(
    taskId,
    { status: 'complete', spec: { title: 'spec' }, agents: [] },
    []
  );
  assert.equal(skipped, false);

  // Watchdog fires afterwards — must see the completed task and skip.
  let sent = 0;
  const result = await handleStalledPlanning(taskId, { sendPrompt: async () => { sent++; } });
  assert.equal(result.action, 'skipped');
  assert.ok(
    ['status_assigned', 'status_inbox'].includes((result as { reason: string }).reason),
    `unexpected skip reason: ${(result as { reason: string }).reason}`
  );
  assert.equal(sent, 0);

  const task = getTask(taskId);
  assert.equal(task.planning_complete, 1, 'completion intact');
  assert.equal(task.auto_restart_count, 0, 'watchdog did not touch the counter');
});

test('race: watchdog restarts first → stale completion from the old session is ignored', async () => {
  const taskId = seedTask({ planningMessages: '[]' });
  const oldKey = `agent:main:planning:${taskId}`;

  // Watchdog claims + restarts.
  const result = await handleStalledPlanning(taskId, { sendPrompt: noopSend });
  assert.equal(result.action, 'restarted');

  // Stale completion arrives with the OLD session key — must be skipped.
  const stale = await handlePlanningCompletion(
    taskId,
    { status: 'complete', spec: { title: 'stale' }, agents: [] },
    [],
    { sessionKey: oldKey }
  );
  assert.equal(stale.skipped, true);

  const task = getTask(taskId);
  assert.equal(task.planning_complete, 0, 'stale completion must not mark planning complete');
  assert.equal(task.planning_spec, null, 'stale spec must not be written');
  assert.equal(task.auto_restart_count, 1, 'watchdog counter intact');
});

test('race: watchdog claims, then completion with the NEW session key is accepted', async () => {
  const taskId = seedTask({ planningMessages: '[]' });

  const result = await handleStalledPlanning(taskId, { sendPrompt: noopSend });
  assert.equal(result.action, 'restarted');
  const newKey = String(getTask(taskId).planning_session_key);

  const fresh = await handlePlanningCompletion(
    taskId,
    { status: 'complete', spec: { title: 'fresh' }, agents: [] },
    [],
    { sessionKey: newKey }
  );
  assert.equal(fresh.skipped, false);
  const task = getTask(taskId);
  assert.equal(task.planning_complete, 1);
  assert.equal(task.auto_restart_count, 0, 'counter reset by successful completion');
});

// ── 8. sweep ────────────────────────────────────────────────────────────────

test('checkPlanningStalls sweeps only genuinely stalled tasks', async () => {
  const staleA = seedTask({});
  const staleB = seedTask({});
  const fresh = seedTask({ planningUpdatedAt: new Date().toISOString() });
  const awaiting = seedTask({
    planningMessages: JSON.stringify([
      { role: 'assistant', content: JSON.stringify({ question: 'Q?', options: [{ id: 'A', label: 'A' }] }), timestamp: 1577836800000 },
    ]),
  });

  let sent = 0;
  const acted = await checkPlanningStalls({ sendPrompt: async () => { sent++; } });

  assert.equal(acted, 2, 'only the two stale tasks are acted upon');
  assert.equal(sent, 2);
  assert.equal(getTask(staleA).auto_restart_count, 1);
  assert.equal(getTask(staleB).auto_restart_count, 1);
  assert.equal(getTask(fresh).auto_restart_count, 0);
  assert.equal(getTask(awaiting).auto_restart_count, 0);
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('lastPlanningActivityMs prefers planning_updated_at, then message timestamp, then updated_at', () => {
  assert.equal(lastPlanningActivityMs({ planning_updated_at: '2024-05-01T00:00:00.000Z' }), 1714521600000);
  assert.equal(
    lastPlanningActivityMs({ planning_messages: JSON.stringify([{ timestamp: 1700000000000 }]) }),
    1700000000000
  );
  assert.equal(
    lastPlanningActivityMs({ updated_at: '2024-06-01T00:00:00.000Z' }),
    1717200000000
  );
  assert.equal(lastPlanningActivityMs({}), null);
});
