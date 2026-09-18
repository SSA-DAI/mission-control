/**
 * GLOBAL ODE STALL REMEDIATION (2026-09-18) — Parked-task watchdog tests.
 *
 * Covers:
 *  1. a task parked longer than the threshold gets a `stage_parked_alert`
 *     activity (the ODE 4-day-park incident must be visible).
 *  2. a freshly parked task (below threshold) is NOT alerted.
 *  3. cooldown: a second sweep inside the cooldown window stays quiet, and the
 *     reminder returns once the cooldown elapses.
 *  4. a non-parked task (stage status) is never alerted.
 *  5. listParkedTasks reports parked duration + alertDue deterministically and
 *     never mutates the task status.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { run, queryOne } from './db';
import { HUMAN_DECISION_STATUS } from './stage-watchdog';
import {
  PARKED_ALERT_ACTIVITY_TYPE,
  PARKED_ALERT_AFTER_MS,
  PARKED_ALERT_COOLDOWN_MS,
  checkParkedTasks,
  listParkedTasks,
} from './parked-task-watchdog';

const HOUR = 3_600_000;

function seedParkedTask(opts: {
  status?: string;
  updatedAt?: string;
  statusReason?: string | null;
}): string {
  const taskId = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, description, status, status_reason, workspace_id, created_at, updated_at)
     VALUES (?, 'Parked Task Test', 'test task', ?, ?, 'default', datetime('now'), ?)`,
    [
      taskId,
      opts.status ?? HUMAN_DECISION_STATUS,
      opts.statusReason ?? 'Stage agent stalled — auto-recovery budget exhausted',
      opts.updatedAt ?? new Date(Date.now() - 8 * HOUR).toISOString(),
    ]
  );
  return taskId;
}

function alertCount(taskId: string): number {
  const row = queryOne<{ c: number }>(
    'SELECT COUNT(*) AS c FROM task_activities WHERE task_id = ? AND activity_type = ?',
    [taskId, PARKED_ALERT_ACTIVITY_TYPE]
  );
  return row?.c ?? 0;
}

function cleanup(taskId: string): void {
  run('DELETE FROM task_activities WHERE task_id = ?', [taskId]);
  run('DELETE FROM tasks WHERE id = ?', [taskId]);
}

test('parked task past the threshold → one reminder recorded (incident regression)', () => {
  const taskId = seedParkedTask({ updatedAt: new Date(Date.now() - 4 * 24 * HOUR).toISOString() });

  const alerted = checkParkedTasks();
  assert.equal(alerted, 1);
  assert.equal(alertCount(taskId), 1);

  const activity = queryOne<{ message: string; metadata: string }>(
    'SELECT message, metadata FROM task_activities WHERE task_id = ? AND activity_type = ?',
    [taskId, PARKED_ALERT_ACTIVITY_TYPE]
  );
  assert.match(activity!.message, /parked at menunggu_keputusan_manusia for 96h/);
  const meta = JSON.parse(activity!.metadata) as { parkedMs: number; assignedAgentId: string | null };
  assert.ok(meta.parkedMs >= 95 * HOUR);

  // status must be untouched — the parked status is intentional
  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, HUMAN_DECISION_STATUS);

  cleanup(taskId);
});

test('freshly parked task (below threshold) → no reminder', () => {
  const taskId = seedParkedTask({ updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
  assert.equal(checkParkedTasks(), 0);
  assert.equal(alertCount(taskId), 0);
  cleanup(taskId);
});

test('cooldown suppresses repeats, then allows the next reminder', () => {
  const parkedAt = new Date(Date.now() - 10 * HOUR).toISOString();
  const taskId = seedParkedTask({ updatedAt: parkedAt });

  // first sweep → alert
  assert.equal(checkParkedTasks(), 1);
  assert.equal(alertCount(taskId), 1);

  // second sweep immediately after → still inside the cooldown → quiet
  assert.equal(checkParkedTasks(), 0);
  assert.equal(alertCount(taskId), 1);

  // simulate the cooldown elapsing by backdating the reminder activity
  const stale = new Date(Date.now() - PARKED_ALERT_COOLDOWN_MS - 60_000).toISOString();
  run('UPDATE task_activities SET created_at = ? WHERE task_id = ? AND activity_type = ?', [
    stale,
    taskId,
    PARKED_ALERT_ACTIVITY_TYPE,
  ]);

  assert.equal(checkParkedTasks(), 1);
  assert.equal(alertCount(taskId), 2);
  cleanup(taskId);
});

test('non-parked tasks are never alerted', () => {
  const inProgress = seedParkedTask({
    status: 'in_progress',
    updatedAt: new Date(Date.now() - 30 * HOUR).toISOString(),
  });
  const done = seedParkedTask({
    status: 'done',
    updatedAt: new Date(Date.now() - 30 * HOUR).toISOString(),
  });

  assert.equal(checkParkedTasks(), 0);
  assert.equal(alertCount(inProgress), 0);
  assert.equal(alertCount(done), 0);
  cleanup(inProgress);
  cleanup(done);
});

test('listParkedTasks: duration + alertDue are deterministic and read-only', () => {
  const now = Date.now();
  const parked = seedParkedTask({ updatedAt: new Date(now - 3 * HOUR).toISOString() });

  const rows = listParkedTasks(now).filter(r => r.id === parked);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].parkedMs, 3 * HOUR);
  assert.equal(rows[0].alertDue, true);
  assert.equal(rows[0].lastAlertMs, null);

  // below threshold → not due
  const rows2 = listParkedTasks(now, { thresholdMs: 6 * HOUR }).filter(r => r.id === parked);
  assert.equal(rows2[0].alertDue, false);

  // never alerts on read
  assert.equal(alertCount(parked), 0);
  cleanup(parked);
});

test('threshold + cooldown are env-overridable defaults', () => {
  assert.equal(typeof PARKED_ALERT_AFTER_MS, 'number');
  assert.equal(typeof PARKED_ALERT_COOLDOWN_MS, 'number');
  assert.ok(PARKED_ALERT_AFTER_MS > 0);
  assert.ok(PARKED_ALERT_COOLDOWN_MS > 0);
});
