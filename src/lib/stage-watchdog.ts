/**
 * PLATFORM-022 — Stage Watchdog.
 *
 * Auto-recovers tasks stuck in a STAGE status because their stage agent
 * (builder/tester/reviewer/verifier) hung or its session ended WITHOUT a
 * completion callback. Found during the P013–P021 batch (2026-08-06): P018
 * (builder session ended after 5 min with no implementation — rotation reasons
 * total_tokens_exceeded + session_corrupted) and P020 (reviewer hung inside the
 * process tool for 20 min, no test process running). Both required a MANUAL
 * POST /dispatch/retry because the task stayed in in_progress/testing forever.
 * The PLATFORM-014 planning watchdog only covers status 'planning' — stage
 * statuses (in_progress/testing/review/verification) had no stall detection.
 *
 * Detection (per planning decisions):
 *  - Sweep tasks whose status ∈ stage statuses and that have an
 *    openclaw_sessions row for the task.
 *  - For each task, look at its LATEST session row:
 *      * active session  → stalled iff session age > STAGE_STALL_TIMEOUT_MS
 *        AND no stage activity (task_activities type IN completed /
 *        status_changed / session_rotated) within the last
 *        STAGE_STALL_TIMEOUT_MS (last-activity WINDOW, not zero-activity-only
 *        — that is what catches the P020 hang).
 *      * non-active session (ended/rotated/completed/failed) → the stage agent
 *        is definitively gone and can never deliver a completion callback, so
 *        recover immediately (skip the end-session step — the session is
 *        already dead). Guard: a session that WE ended with
 *        rotation_reason='stage_stall:auto-recovery' recently is a recovery
 *        already in flight → back off (no double action).
 *
 * Recovery (race-safe):
 *  1. Claim inside a synchronous transaction (single better-sqlite3
 *     connection ⇒ writes serialize; the in-transaction re-check is the race
 *     protection — SQLite has no SELECT … FOR UPDATE). Re-check task status +
 *     latest session + restart counter, then atomically end the active session
 *     (status='ended', ended_at, rotation_reason='stage_stall:auto-recovery'),
 *     bump the restart counter, or move the task to menunggu_keputusan_manusia
 *     when MAX_STAGE_RESTART is exhausted.
 *  2. Re-dispatch via the proven-safe dispatch path (dispatchTaskFromServer —
 *     the same machinery behind POST /api/tasks/:id/dispatch/retry; the
 *     dispatch route health-checks the ended row and rotates to a fresh
 *     session, PLATFORM-008/P013 semantics).
 *  3. Record stage_stall_detected + session_rotated activities.
 *
 * After MAX_STAGE_RESTART (default 2) recoveries the task moves to
 * 'menunggu_keputusan_manusia' with a clear status_reason — a task is never
 * stuck forever. A re-dispatch that cannot even start also fails fast to a
 * human decision (same policy as the planning watchdog) instead of looping the
 * sweep.
 */

import { getDb, queryAll, queryOne, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { dispatchTaskFromServer } from '@/lib/server-dispatch';
import { v4 as uuidv4 } from 'uuid';

// ── Configuration (env overridable) ─────────────────────────────────────────

/** Stage statuses owned by stage agents (builder/tester/reviewer/verifier). */
export const STAGE_STATUSES = ['in_progress', 'testing', 'review', 'verification'] as const;

/** Activity types that count as "the stage made progress". */
export const STAGE_ACTIVITY_TYPES = ['completed', 'status_changed', 'session_rotated'] as const;

/** Max time a stage session may be silent before the watchdog acts. Default 30 min. */
export const STAGE_STALL_TIMEOUT_MS = parseInt(process.env.STAGE_STALL_TIMEOUT || '1800000', 10);

/** Max automatic re-dispatches per task. After this, the task needs a human decision. */
export const MAX_STAGE_RESTART = parseInt(process.env.MAX_STAGE_RESTART || '2', 10);

/** How often the polling scheduler sweeps stage tasks. Default 30s. */
export const STAGE_WATCHDOG_POLL_INTERVAL_MS = parseInt(process.env.STAGE_WATCHDOG_POLL_INTERVAL_MS || '30000', 10);

/**
 * Grace window after WE ended a session for a stall. Prevents a concurrent
 * sweep (or the recovery's own re-dispatch window) from double-acting on the
 * same task: while the ended row is still "recent", the recovery is assumed to
 * be in flight and the task is skipped.
 */
export const STAGE_RECOVERY_GRACE_MS = 5 * 60 * 1000;

/** Status used when the auto-recovery budget is exhausted (or re-dispatch fails). */
export const HUMAN_DECISION_STATUS = 'menunggu_keputusan_manusia';

/** rotation_reason written when the watchdog ends a stalled session. */
export const STAGE_STALL_ROTATION_REASON = 'stage_stall:auto-recovery';

// ── Timestamp helpers ───────────────────────────────────────────────────────

/**
 * Parse a DB timestamp defensively. SQLite `datetime('now')` produces
 * 'YYYY-MM-DD HH:MM:SS' in UTC with no timezone marker — bare Date.parse()
 * would interpret it as LOCAL time (wrong by the TZ offset). Normalize to ISO
 * UTC before parsing. (Same helper as the planning watchdog.)
 */
function parseDbTimestamp(s: string | null | undefined): number | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) {
    const t = Date.parse(s.replace(' ', 'T') + 'Z');
    if (!Number.isNaN(t)) return t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// ── Restart counter (tasks.metadata JSON, decision: metadata field) ─────────

export interface StageTaskMetadata {
  stage_restart_count?: number;
}

/**
 * Read stage_restart_count from tasks.metadata JSON. Missing/invalid JSON or a
 * missing field → 0. Other metadata keys are preserved (merge, never clobber).
 */
export function readStageRestartCount(metadataJson: string | null | undefined): number {
  if (!metadataJson) return 0;
  try {
    const meta = JSON.parse(metadataJson) as StageTaskMetadata | null;
    const v = meta?.stage_restart_count;
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  } catch {
    return 0;
  }
}

/** Pure helper: return the new tasks.metadata JSON with stage_restart_count set. */
export function withStageRestartCount(metadataJson: string | null | undefined, count: number): string {
  let meta: Record<string, unknown> = {};
  if (metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      meta = {};
    }
  }
  meta.stage_restart_count = count;
  return JSON.stringify(meta);
}

// ── Last stage activity window ──────────────────────────────────────────────

/**
 * Timestamp (ms) of the last stage activity for the task: MAX(task_activities
 * .created_at) where activity_type IN completed/status_changed/session_rotated.
 * This is the source of truth for "the stage made progress" (the planning
 * decision: openclaw_sessions.updated_at is unreliable — it is almost never
 * updated).
 */
export function lastStageActivityMs(taskId: string): number | null {
  const row = queryOne<{ last_activity?: string | null }>(
    `SELECT MAX(created_at) AS last_activity
     FROM task_activities
     WHERE task_id = ? AND activity_type IN (${STAGE_ACTIVITY_TYPES.map(() => '?').join(',')})`,
    [taskId, ...STAGE_ACTIVITY_TYPES]
  );
  return parseDbTimestamp(row?.last_activity ?? null);
}

// ── Activity logging ────────────────────────────────────────────────────────

export function logStageActivity(
  taskId: string,
  activityType: string,
  message: string,
  metadata?: unknown
): void {
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [uuidv4(), taskId, activityType, message, metadata ? JSON.stringify(metadata) : null]
  );
}

function broadcastTask(taskId: string): void {
  const updatedTask = queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask as any });
  }
}

// ── Re-dispatch (proven-safe dispatch path) ─────────────────────────────────

export interface RedispatchResult {
  ok: boolean;
  error?: string;
  /** session id of the freshly created/rotated session, when known. */
  sessionId?: string | null;
}

/**
 * Default re-dispatch: mirrors POST /api/tasks/[id]/dispatch/retry semantics
 * on top of dispatchTaskFromServer (the same HTTP dispatch the retry endpoint
 * calls — proven rotation-safe: the dispatch route health-checks the ended
 * row and rotates to a fresh session key). Clears the dispatch error, verifies
 * that dispatch actually recorded an active runtime session (the retry
 * endpoint's 502 check), and surfaces the new session id.
 */
export async function defaultRedispatch(taskId: string): Promise<RedispatchResult> {
  const task = queryOne<{ status?: string; assigned_agent_id?: string | null }>(
    'SELECT status, assigned_agent_id FROM tasks WHERE id = ?',
    [taskId]
  );
  if (!task) return { ok: false, error: 'Task not found' };
  if (task.status === 'done') return { ok: false, error: 'Completed tasks cannot be retried for dispatch' };
  if (!task.assigned_agent_id) return { ok: false, error: 'Task has no assigned agent' };

  run(
    `UPDATE tasks SET planning_dispatch_error = NULL, status_reason = NULL, updated_at = datetime('now') WHERE id = ?`,
    [taskId]
  );

  const result = await dispatchTaskFromServer(taskId);
  if (!result.success) {
    return { ok: false, error: result.error || 'Dispatch failed' };
  }

  const active = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM openclaw_sessions
     WHERE task_id = ? AND agent_id = ? AND status = 'active'`,
    [taskId, task.assigned_agent_id]
  );
  if ((active?.cnt ?? 0) === 0) {
    return { ok: false, error: 'Dispatch returned success but no active runtime session was recorded.' };
  }

  const body = result.body as { session_id?: string | null } | null | undefined;
  return { ok: true, sessionId: body?.session_id ?? null };
}

// ── Stall handling ──────────────────────────────────────────────────────────

export interface StageWatchdogDeps {
  /** Current wall-clock time in ms (tests override this). */
  now?: () => number;
  /** Re-dispatch function (tests override this to avoid real HTTP). */
  redispatch?: (taskId: string) => Promise<RedispatchResult>;
}

export type StageStallAction =
  | { action: 'restarted'; attempt: number; sessionId: string }
  | { action: 'human_decision' }
  | { action: 'skipped'; reason: string };

interface StageSessionSnapshot {
  id: string;
  status: string;
  agent_id?: string | null;
  created_at?: string | null;
  ended_at?: string | null;
  rotation_reason?: string | null;
}

/** Latest openclaw_sessions row for a task (any status). */
function latestTaskSession(taskId: string): StageSessionSnapshot | null {
  return (
    queryOne<StageSessionSnapshot>(
      `SELECT id, status, agent_id, created_at, ended_at, rotation_reason
       FROM openclaw_sessions WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [taskId]
    ) ?? null
  );
}

interface StageClaim {
  ok: boolean;
  reason?: string;
  action?: 'restart' | 'human_decision';
  attempt?: number;
  sessionId?: string;
  endedSession?: boolean;
}

/**
 * Core watchdog decision for one task, in a transaction. Phase 1 (claim)
 * re-checks everything under the synchronous single-connection transaction —
 * this is the race protection (a concurrent sweep or completion that lands
 * first wins and we back off). SQLite has no SELECT … FOR UPDATE; better-sqlite3
 * serializes all writes on the single connection, so the in-transaction
 * re-check is equivalent in effect for our concurrent-sweep scenario.
 */
function claimStalledStage(taskId: string, now: number): StageClaim {
  const db = getDb();
  return transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | (Record<string, unknown> & { status?: string; metadata?: string | null })
      | undefined;

    if (!task) return { ok: false, reason: 'task_not_found' };
    if (!task.status || !(STAGE_STATUSES as readonly string[]).includes(task.status)) {
      return { ok: false, reason: `status_${task.status ?? 'null'}` };
    }

    const session = latestTaskSession(taskId);
    if (!session) return { ok: false, reason: 'no_session' };

    const count = readStageRestartCount(task.metadata);
    const canRestart = count < MAX_STAGE_RESTART;
    const nowIso = new Date(now).toISOString();

    if (session.status === 'active') {
      // Active session: stalled iff session age AND last-activity window both
      // exceed the timeout (last-activity WINDOW detection, not zero-activity).
      const sessionCreated = parseDbTimestamp(session.created_at);
      if (sessionCreated === null) return { ok: false, reason: 'unparseable_session_time' };
      if (now - sessionCreated <= STAGE_STALL_TIMEOUT_MS) return { ok: false, reason: 'not_stalled_yet' };

      const lastAct = lastStageActivityMs(taskId) ?? sessionCreated;
      if (now - lastAct <= STAGE_STALL_TIMEOUT_MS) return { ok: false, reason: 'recent_activity' };

      // Stalled → end the active session with the audit trail, then recover.
      db.prepare(`
        UPDATE openclaw_sessions
        SET status = 'ended', ended_at = ?, updated_at = ?, rotation_reason = ?
        WHERE id = ? AND status = 'active'
      `).run(nowIso, nowIso, STAGE_STALL_ROTATION_REASON, session.id);

      if (canRestart) {
        const newCount = count + 1;
        db.prepare('UPDATE tasks SET metadata = ?, status_reason = ?, updated_at = ? WHERE id = ?')
          .run(withStageRestartCount(task.metadata, newCount), `Stage agent stalled — auto-recovery #${newCount} (session ${session.id} ended)`, nowIso, taskId);
        return { ok: true, action: 'restart', attempt: newCount, sessionId: session.id, endedSession: true };
      }
      db.prepare('UPDATE tasks SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
        .run(HUMAN_DECISION_STATUS, `Stage agent stalled after ${MAX_STAGE_RESTART} auto-recovery attempt(s) — menunggu keputusan manusia`, nowIso, taskId);
      return { ok: true, action: 'human_decision', sessionId: session.id, endedSession: true };
    }

    // Non-active session (ended/rotated/completed/failed): the stage agent is
    // gone and can never call back → recover immediately, no end-session step.
    // Guard: if WE ended this session for a stall recently, a recovery is
    // already in flight (claim committed, re-dispatch running) → back off so a
    // concurrent sweep cannot double-dispatch.
    if (session.rotation_reason === STAGE_STALL_ROTATION_REASON && session.ended_at) {
      const endedAt = parseDbTimestamp(session.ended_at);
      if (endedAt !== null && now - endedAt <= STAGE_RECOVERY_GRACE_MS) {
        return { ok: false, reason: 'already_recovering' };
      }
    }

    if (canRestart) {
      const newCount = count + 1;
      db.prepare('UPDATE tasks SET metadata = ?, status_reason = ?, updated_at = ? WHERE id = ?')
        .run(withStageRestartCount(task.metadata, newCount), `Stage session ended without callback — auto-recovery #${newCount} (session ${session.id})`, nowIso, taskId);
      return { ok: true, action: 'restart', attempt: newCount, sessionId: session.id, endedSession: false };
    }
    db.prepare('UPDATE tasks SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
      .run(HUMAN_DECISION_STATUS, `Stage session ended without callback after ${MAX_STAGE_RESTART} auto-recovery attempt(s) — menunggu keputusan manusia`, nowIso, taskId);
    return { ok: true, action: 'human_decision', sessionId: session.id, endedSession: false };
  });
}

/**
 * Handle a possibly-stalled stage task. Re-checks state inside a transaction,
 * then (outside the transaction, for the network call) re-dispatches the task.
 * Returns the action taken.
 */
export async function handleStalledStage(
  taskId: string,
  deps?: StageWatchdogDeps
): Promise<StageStallAction> {
  const now = deps?.now ? deps.now() : Date.now();
  const redispatch = deps?.redispatch || defaultRedispatch;

  const claim = claimStalledStage(taskId, now);
  if (!claim.ok) {
    return { action: 'skipped', reason: claim.reason! };
  }

  const stalledMinutes = Math.round(STAGE_STALL_TIMEOUT_MS / 60000);
  logStageActivity(
    taskId,
    'stage_stall_detected',
    `Stage agent silent/ended > ${stalledMinutes} min without completion callback — watchdog triggered`,
    {
      stalledMs: STAGE_STALL_TIMEOUT_MS,
      endedSession: claim.endedSession,
      sessionId: claim.sessionId,
    }
  );

  if (claim.action === 'human_decision') {
    logStageActivity(
      taskId,
      'stage_decision_needed',
      `Auto-recovery budget exhausted (${MAX_STAGE_RESTART}/${MAX_STAGE_RESTART}) — menunggu keputusan manusia`,
      { maxStageRestart: MAX_STAGE_RESTART }
    );
    broadcastTask(taskId);
    return { action: 'human_decision' };
  }

  // Phase 2 — re-dispatch (network call, outside the transaction).
  const result = await redispatch(taskId);
  if (!result.ok) {
    // Re-dispatch could not even start (e.g. gateway unreachable, no agent).
    // Fail fast to a human decision instead of looping the sweep.
    const error = result.error || 'Unknown re-dispatch error';
    run(
      `UPDATE tasks SET status = ?, status_reason = ?, planning_dispatch_error = ?, updated_at = ? WHERE id = ?`,
      [
        HUMAN_DECISION_STATUS,
        `Auto-recovery re-dispatch failed: ${error} — menunggu keputusan manusia`,
        `Stage watchdog re-dispatch failed: ${error}`,
        new Date().toISOString(),
        taskId,
      ]
    );
    logStageActivity(
      taskId,
      'stage_decision_needed',
      `Auto-recovery re-dispatch failed (${error}) — menunggu keputusan manusia`,
      { error }
    );
    broadcastTask(taskId);
    return { action: 'human_decision' };
  }

  logStageActivity(
    taskId,
    'session_rotated',
    `Stage watchdog auto-recovery #${claim.attempt} — session ${claim.sessionId} ended and task re-dispatched${result.sessionId ? ` to fresh session ${result.sessionId}` : ''}`,
    {
      rotation_reason: STAGE_STALL_ROTATION_REASON,
      attempt: claim.attempt,
      maxStageRestart: MAX_STAGE_RESTART,
      ended_session_id: claim.sessionId,
      new_session_id: result.sessionId ?? null,
    }
  );
  broadcastTask(taskId);
  return { action: 'restarted', attempt: claim.attempt!, sessionId: claim.sessionId! };
}

// ── Polling sweep ───────────────────────────────────────────────────────────

let sweepInFlight: Promise<number> | null = null;

/**
 * One sweep: find all stage-status tasks that have a session row, evaluate
 * stall, act on the stalled ones. Returns how many tasks were acted upon
 * (recovered or sent to human decision). Concurrent sweeps coalesce into a
 * single run.
 */
export function checkStageStalls(deps?: StageWatchdogDeps): Promise<number> {
  if (sweepInFlight) return sweepInFlight;

  sweepInFlight = (async () => {
    const candidates = queryAll<{ task_id: string }>(
      `SELECT DISTINCT t.id AS task_id
       FROM tasks t
       INNER JOIN openclaw_sessions s ON s.task_id = t.id
       WHERE t.status IN (${STAGE_STATUSES.map(() => '?').join(',')})`,
      [...STAGE_STATUSES]
    );

    let acted = 0;
    for (const candidate of candidates) {
      const result = await handleStalledStage(candidate.task_id, deps);
      if (result.action !== 'skipped') acted += 1;
    }
    return acted;
  })();

  sweepInFlight.finally(() => {
    sweepInFlight = null;
  }).catch(() => {
    sweepInFlight = null;
  });

  return sweepInFlight;
}

// ── Scheduler bootstrap ─────────────────────────────────────────────────────

/**
 * Start the polling scheduler. Called once from getDb() right after the
 * planning watchdog bootstrap (same pattern). No-op in test env — tests drive
 * checkStageStalls()/handleStalledStage() directly.
 */
export function ensureStageWatchdogScheduled(): void {
  if (process.env.NODE_ENV === 'test') return;
  const g = globalThis as unknown as { __mcStageWatchdogTimer?: NodeJS.Timeout };
  if (g.__mcStageWatchdogTimer) return;
  g.__mcStageWatchdogTimer = setInterval(() => {
    checkStageStalls().then((acted) => {
      if (acted > 0) {
        console.log(`[StageWatchdog] sweep handled ${acted} stalled stage task(s)`);
      }
    }).catch((err) => {
      console.error('[StageWatchdog] sweep failed:', err);
    });
  }, STAGE_WATCHDOG_POLL_INTERVAL_MS);
  console.log(`[StageWatchdog] scheduler started (interval ${STAGE_WATCHDOG_POLL_INTERVAL_MS}ms, stall timeout ${STAGE_STALL_TIMEOUT_MS}ms, max restart ${MAX_STAGE_RESTART})`);
}
