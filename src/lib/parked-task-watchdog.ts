/**
 * GLOBAL ODE STALL REMEDIATION (2026-09-18) — Parked-task watchdog.
 *
 * Incident (ODE pipeline, 2026-09-13 → 2026-09-17): both gating tasks moved to
 * `menunggu_keputusan_manusia` and stayed there for FOUR DAYS. Nothing noticed:
 * the stage watchdog stops at "a task is never stuck forever" — it hands off to
 * a human and goes quiet. There is no escalation, no reminder, and no signal
 * that says how long a task has been waiting for a decision.
 *
 * This watchdog closes that loop deterministically (no LLM): every sweep it
 * finds tasks parked in HUMAN_DECISION_STATUS longer than PARKED_ALERT_AFTER_MS
 * and records a `stage_parked_alert` activity (cooldown-bounded, so the timeline
 * is not spammed) + broadcasts the task so the UI refreshes.
 *
 * Why an activity and not a status change: the parked status is intentional
 * (a human decision is genuinely required). The gap is visibility, so the fix
 * is an escalating, auditable reminder on the task timeline — plus a machine
 * readable surface (`listParkedTasks`) for external notifiers (the awanfleet
 * parked-task cron) to alert the owner off-instance.
 */

import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { v4 as uuidv4 } from 'uuid';
import { HUMAN_DECISION_STATUS } from '@/lib/stage-watchdog';

// ── Configuration (env overridable) ─────────────────────────────────────────

/** How long a task may sit parked before the first alert. Default 2 hours. */
export const PARKED_ALERT_AFTER_MS = parseInt(
  process.env.PARKED_ALERT_AFTER_MS || '7200000',
  10
);

/** Minimum gap between two parked alerts for the same task. Default 6 hours. */
export const PARKED_ALERT_COOLDOWN_MS = parseInt(
  process.env.PARKED_ALERT_COOLDOWN_MS || '21600000',
  10
);

/** How often the parked sweep runs. Default 5 minutes. */
export const PARKED_WATCHDOG_POLL_INTERVAL_MS = parseInt(
  process.env.PARKED_WATCHDOG_POLL_INTERVAL_MS || '300000',
  10
);

/** task_activities type used for parked reminders (also the cooldown marker). */
export const PARKED_ALERT_ACTIVITY_TYPE = 'stage_parked_alert';

// ── Detection ───────────────────────────────────────────────────────────────

export interface ParkedTask {
  id: string;
  title: string;
  status: string;
  status_reason: string | null;
  assigned_agent_id: string | null;
  /** Timestamp the task was parked (tasks.updated_at), as epoch ms. */
  parkedAtMs: number | null;
  /** How long the task has been parked, in ms. */
  parkedMs: number;
  /** Last parked-alert activity for this task (epoch ms), null when never. */
  lastAlertMs: number | null;
  /** True when the cooldown has elapsed and a fresh alert is due. */
  alertDue: boolean;
}

interface ParkedRow {
  id: string;
  title: string;
  status: string;
  status_reason?: string | null;
  assigned_agent_id?: string | null;
  updated_at?: string | null;
  last_alert?: string | null;
}

/** Parse a SQLite timestamp (datetime('now') = 'YYYY-MM-DD HH:MM:SS' UTC). */
function parseDbTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    const t = Date.parse(`${s.replace(' ', 'T')}Z`);
    if (!Number.isNaN(t)) return t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Every task parked at HUMAN_DECISION_STATUS, newest-parked last, with the
 * parked duration and whether a fresh alert is due. Read-only.
 */
export function listParkedTasks(
  now: number = Date.now(),
  opts: { thresholdMs?: number; cooldownMs?: number } = {}
): ParkedTask[] {
  const thresholdMs = opts.thresholdMs ?? PARKED_ALERT_AFTER_MS;
  const cooldownMs = opts.cooldownMs ?? PARKED_ALERT_COOLDOWN_MS;

  const rows = queryAll<ParkedRow>(
    `SELECT t.id, t.title, t.status, t.status_reason, t.assigned_agent_id, t.updated_at,
            (SELECT MAX(a.created_at) FROM task_activities a
              WHERE a.task_id = t.id AND a.activity_type = ?) AS last_alert
       FROM tasks t
      WHERE t.status = ?
      ORDER BY t.updated_at ASC`,
    [PARKED_ALERT_ACTIVITY_TYPE, HUMAN_DECISION_STATUS]
  );

  return rows.map(row => {
    const parkedAtMs = parseDbTimestamp(row.updated_at ?? null);
    const parkedMs = parkedAtMs === null ? 0 : Math.max(0, now - parkedAtMs);
    const lastAlertMs = parseDbTimestamp(row.last_alert ?? null);
    const cooldownElapsed = lastAlertMs === null || now - lastAlertMs >= cooldownMs;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      status_reason: row.status_reason ?? null,
      assigned_agent_id: row.assigned_agent_id ?? null,
      parkedAtMs,
      parkedMs,
      lastAlertMs,
      alertDue: parkedMs >= thresholdMs && cooldownElapsed,
    };
  });
}

// ── Sweep ───────────────────────────────────────────────────────────────────

export interface ParkedSweepDeps {
  now?: () => number;
  thresholdMs?: number;
  cooldownMs?: number;
}

/**
 * One sweep: record a `stage_parked_alert` reminder for every parked task that
 * crossed the threshold and is out of cooldown. Returns how many alerts were
 * recorded. Never changes a task's status.
 */
export function checkParkedTasks(deps?: ParkedSweepDeps): number {
  const now = deps?.now ? deps.now() : Date.now();
  const parked = listParkedTasks(now, {
    thresholdMs: deps?.thresholdMs,
    cooldownMs: deps?.cooldownMs,
  });

  let alerted = 0;
  for (const task of parked) {
    if (!task.alertDue) continue;
    const hours = Math.round((task.parkedMs / 3_600_000) * 10) / 10;
    const cooldownHours = Math.round(PARKED_ALERT_COOLDOWN_MS / 3_600_000);
    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [
        uuidv4(),
        task.id,
        PARKED_ALERT_ACTIVITY_TYPE,
        `Task parked at ${HUMAN_DECISION_STATUS} for ${hours}h — human decision required${task.status_reason ? ` (${task.status_reason})` : ''}`,
        JSON.stringify({
          parkedMs: task.parkedMs,
          parkedHours: hours,
          thresholdMs: deps?.thresholdMs ?? PARKED_ALERT_AFTER_MS,
          cooldownMs: PARKED_ALERT_COOLDOWN_MS,
          cooldownHours,
          assignedAgentId: task.assigned_agent_id,
        }),
      ]
    );
    const updated = queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [task.id]);
    if (updated) broadcast({ type: 'task_updated', payload: updated as any });
    alerted += 1;
  }
  return alerted;
}

// ── Scheduler bootstrap ─────────────────────────────────────────────────────

/**
 * Start the parked-task polling scheduler (same pattern as the planning/stage
 * watchdogs). No-op in test env — tests drive checkParkedTasks() directly.
 */
export function ensureParkedTaskWatchdogScheduled(): void {
  if (process.env.NODE_ENV === 'test') return;
  const g = globalThis as unknown as { __mcParkedTaskWatchdogTimer?: NodeJS.Timeout };
  if (g.__mcParkedTaskWatchdogTimer) return;
  g.__mcParkedTaskWatchdogTimer = setInterval(() => {
    try {
      const alerted = checkParkedTasks();
      if (alerted > 0) {
        console.log(`[ParkedTaskWatchdog] alerted on ${alerted} parked task(s)`);
      }
    } catch (err) {
      console.error('[ParkedTaskWatchdog] sweep failed:', err);
    }
  }, PARKED_WATCHDOG_POLL_INTERVAL_MS);
  console.log(
    `[ParkedTaskWatchdog] scheduler started (interval ${PARKED_WATCHDOG_POLL_INTERVAL_MS}ms, alert after ${PARKED_ALERT_AFTER_MS}ms, cooldown ${PARKED_ALERT_COOLDOWN_MS}ms)`
  );
}
