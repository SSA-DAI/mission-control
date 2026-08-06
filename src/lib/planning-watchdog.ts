/**
 * PLATFORM-014 — Planning Watchdog.
 *
 * Detects planning sessions that have gone silent (stalled): the planning agent
 * stopped producing messages while the task is still in status 'planning' with
 * planning_complete = 0. Hybrid detection:
 *
 *  1. Polling scheduler — a global interval (WATCHDOG_POLL_INTERVAL_MS, default
 *     30s) that sweeps all planning tasks and checks last-activity age against
 *     PLANNING_STALL_TIMEOUT_MS (default 10 minutes). Covers every session even
 *     when no frontend is open.
 *  2. Request-level guard — scheduleRequestGuard() arms a per-task timer right
 *     after an answer is submitted, fast-failing sessions whose agent never
 *     responds, without waiting for the next sweep tick.
 *
 * Recovery: auto-cancel (state preserved into planning_history) + restart a
 * fresh planning session, max MAX_AUTO_RESTART (default 2) times per task. The
 * counter resets when planning completes successfully. After the limit is
 * exhausted the task moves to 'menunggu_keputusan_manusia' so it is never stuck
 * forever and the operator/UI gets a clear signal.
 *
 * Race-safety: every transition re-checks the task row inside a transaction
 * (status='planning' AND planning_complete=0 AND session key present). A
 * completion that lands concurrently wins — the watchdog sees planning_complete
 * = 1 and skips. The completion handler (planning-completion.ts) is guarded the
 * other way: it refuses to complete a session that was cancelled/restarted.
 */

import { getDb, queryAll, run, transaction, queryOne } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { extractJSON } from '@/lib/planning-utils';
import { v4 as uuidv4 } from 'uuid';

// ── Configuration (env overridable) ─────────────────────────────────────────

/** Max time a planning session may be silent before the watchdog acts. Default 10 min. */
export const PLANNING_STALL_TIMEOUT_MS = parseInt(process.env.PLANNING_STALL_TIMEOUT || '600000', 10);

/** Max automatic restarts per task. After this, the task needs a human decision. */
export const MAX_AUTO_RESTART = parseInt(process.env.MAX_AUTO_RESTART || '2', 10);

/** How often the polling scheduler sweeps planning tasks. Default 30s. */
export const WATCHDOG_POLL_INTERVAL_MS = parseInt(process.env.WATCHDOG_POLL_INTERVAL || '30000', 10);

/** Request-level per-session timeout guard. Default same as STALL_TIMEOUT. */
export const PLANNING_REQUEST_TIMEOUT_MS = parseInt(process.env.PLANNING_REQUEST_TIMEOUT || String(PLANNING_STALL_TIMEOUT_MS), 10);

/** Status used when auto-restart budget is exhausted. */
export const HUMAN_DECISION_STATUS = 'menunggu_keputusan_manusia';

// ── Shared planning-session helpers (also used by the planning routes) ─────

/**
 * Build the initial planning prompt for a task.
 * Kept in one place so the POST /planning route and the watchdog restart use
 * the exact same prompt.
 */
export function buildPlanningPrompt(task: { title: string; description?: string | null }): string {
  return `PLANNING REQUEST

Task Title: ${task.title}
Task Description: ${task.description || 'No description provided'}

You are starting a planning session for this task. Read PLANNING.md for your protocol.

Generate your FIRST question to understand what the user needs. Remember:
- Questions must be multiple choice
- Include an "Other" option
- Be specific to THIS task, not generic
- INCLUDE a recommended answer (field "recommended" with the option ID you suggest) + a short reason (field "recommended_reason", 1 sentence max)

Respond with ONLY valid JSON in this format:
{
  "question": "Your question here?",
  "options": [
    {"id": "A", "label": "First option"},
    {"id": "B", "label": "Second option"},
    {"id": "C", "label": "Third option"},
    {"id": "other", "label": "Other"}
  ],
  "recommended": "A",
  "recommended_reason": "This approach aligns with the task description and is the least risky path"
}

IMPORTANT: All JSON responses must be compact (under 6KB) and complete — never truncated or abbreviated. "recommended" and "recommended_reason" are REQUIRED fields in every question response.`;
}

/**
 * Resolve the session-key prefix for a task's planning session.
 * Priority: assigned agent's prefix > workspace master's prefix > default.
 */
export function resolvePlanningSessionPrefix(task: {
  id: string;
  workspace_id: string;
  assigned_agent_id?: string | null;
}): string {
  const db = getDb();

  const taskWithAgent = db.prepare(`
    SELECT a.session_key_prefix
    FROM tasks t
    LEFT JOIN agents a ON t.assigned_agent_id = a.id
    WHERE t.id = ?
  `).get(task.id) as { session_key_prefix?: string } | undefined;

  if (taskWithAgent?.session_key_prefix) return taskWithAgent.session_key_prefix;

  const defaultMaster = queryOne<{ session_key_prefix?: string }>(
    `SELECT session_key_prefix FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
    [task.workspace_id]
  );

  return defaultMaster?.session_key_prefix || 'agent:main:';
}

/**
 * Build a planning session key. `attempt` (0 = first session) makes restarted
 * sessions distinguishable: agent:main:planning:<taskId>:r1, r2, ...
 */
export function buildPlanningSessionKey(taskId: string, prefix: string, attempt = 0): string {
  const base = `${prefix}planning:${taskId}`;
  return attempt > 0 ? `${base}:r${attempt}` : base;
}

/**
 * Parse a DB timestamp defensively. SQLite `datetime('now')` produces
 * 'YYYY-MM-DD HH:MM:SS' in UTC with no timezone marker — bare Date.parse()
 * would interpret it as LOCAL time (wrong by the TZ offset). Normalize to ISO
 * UTC before parsing.
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

/** Timestamp (ms) of the last recorded planning activity, or null if unknown. */
export function lastPlanningActivityMs(task: {
  planning_updated_at?: string | null;
  planning_messages?: string | null;
  updated_at?: string | null;
}): number | null {
  if (task.planning_updated_at) {
    const t = parseDbTimestamp(task.planning_updated_at);
    if (t !== null) return t;
  }
  try {
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    const last = messages[messages.length - 1];
    if (last && typeof last.timestamp === 'number') return last.timestamp;
    if (last && typeof last.timestamp === 'string') {
      const t = Date.parse(last.timestamp);
      if (!Number.isNaN(t)) return t;
    }
  } catch {
    // fall through to updated_at
  }
  if (task.updated_at) {
    const t = parseDbTimestamp(task.updated_at);
    if (t !== null) return t;
  }
  return null;
}

/**
 * True when the ball is with the USER: the last assistant message is a
 * question, so the planning agent is healthy and simply waiting for an answer.
 * A session in this state must NOT be auto-restarted.
 */
export function isAwaitingUser(planningMessagesJson?: string | null): boolean {
  if (!planningMessagesJson) return false;
  try {
    const messages = JSON.parse(planningMessagesJson) as Array<{ role: string; content: string }>;
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return false;
    const parsed = extractJSON(lastAssistant.content) as { question?: unknown } | null;
    return Boolean(parsed && parsed.question);
  } catch {
    return false;
  }
}

// ── Activity logging ────────────────────────────────────────────────────────

export function logPlanningActivity(
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

// ── Safe cancel (shared by POST /planning/cancel and the watchdog) ──────────

/**
 * Cancel a planning session SAFELY: planning_messages / planning_spec /
 * planning_agents are preserved (both in place and archived into
 * planning_history), the session key is cleared so a fresh session can start,
 * and the task returns to the inbox. Also resets the auto-restart counter —
 * a human explicitly intervened.
 *
 * Returns the action taken: 'cancelled' | 'noop' (no active session).
 */
export function cancelPlanningSession(
  taskId: string,
  reason: string,
  opts?: { preserveSpec?: boolean }
): { action: 'cancelled' | 'noop'; task?: Record<string, unknown> } {
  const preserveSpec = opts?.preserveSpec ?? true;
  const db = getDb();

  return transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | (Record<string, unknown> & {
          planning_session_key?: string | null;
          planning_messages?: string | null;
          planning_spec?: string | null;
          planning_agents?: string | null;
          planning_history?: string | null;
        })
      | undefined;

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Archive the active session into planning_history (append-only).
    let history: unknown[] = [];
    if (task.planning_history) {
      try {
        history = JSON.parse(task.planning_history);
      } catch {
        history = [];
      }
    }
    if (task.planning_session_key) {
      history.push({
        sessionKey: task.planning_session_key,
        messages: task.planning_messages ? JSON.parse(task.planning_messages) : [],
        cancelledAt: new Date().toISOString(),
        reason,
      });
    }

    db.prepare(`
      UPDATE tasks
      SET planning_session_key = NULL,
          planning_complete = 0,
          planning_dispatch_error = NULL,
          planning_updated_at = ?,
          auto_restart_count = 0,
          answered_question_indices = NULL,
          status = 'inbox',
          status_reason = ?,
          planning_history = ?,
          updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), reason, JSON.stringify(history), new Date().toISOString(), taskId);

    const hadSession = Boolean(task.planning_session_key);
    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
    return { action: (hadSession ? 'cancelled' : 'noop') as 'cancelled' | 'noop', task: updated };
  });
}

// ── Start / restart a planning session ──────────────────────────────────────

export interface StartSessionDeps {
  /** Send the initial prompt to the planning session (default: OpenClaw chat.send). */
  sendPrompt?: (sessionKey: string, prompt: string) => Promise<void>;
}

async function defaultSendPrompt(sessionKey: string, prompt: string): Promise<void> {
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    await client.connect();
  }
  await client.call('chat.send', {
    sessionKey,
    message: prompt,
    idempotencyKey: `planning-start-${sessionKey}-${Date.now()}`,
  });
}

export interface StartSessionResult {
  ok: boolean;
  sessionKey?: string;
  error?: string;
}

/**
 * Create (or restart) a planning session for a task: build a session key,
 * send the initial planning prompt, and persist the session state.
 * `attempt` > 0 marks a watchdog restart and appends :r<attempt> to the key.
 */
export async function startPlanningSession(
  taskId: string,
  opts?: { attempt?: number; deps?: StartSessionDeps; onBeforeSend?: () => void; prefix?: string }
): Promise<StartSessionResult> {
  const attempt = opts?.attempt ?? 0;
  const deps = opts?.deps ?? {};

  const task = queryOne<{
    id: string;
    title: string;
    description?: string | null;
    workspace_id: string;
    assigned_agent_id?: string | null;
  }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

  if (!task) return { ok: false, error: 'Task not found' };

  const prefix = opts?.prefix || resolvePlanningSessionPrefix(task);
  const sessionKey = buildPlanningSessionKey(taskId, prefix, attempt);
  const prompt = buildPlanningPrompt(task);

  opts?.onBeforeSend?.();

  try {
    const sendPrompt = deps.sendPrompt || defaultSendPrompt;
    await sendPrompt(sessionKey, prompt);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const messages = [{ role: 'user', content: prompt, timestamp: Date.now() }];
  const nowIso = new Date().toISOString();
  run(
    `UPDATE tasks
     SET planning_session_key = ?,
         planning_messages = ?,
         planning_updated_at = ?,
         answered_question_indices = NULL,
         status = 'planning',
         updated_at = ?
     WHERE id = ?`,
    [sessionKey, JSON.stringify(messages), nowIso, nowIso, taskId]
  );

  return { ok: true, sessionKey };
}

// ── Stall handling ──────────────────────────────────────────────────────────

export interface WatchdogDeps extends StartSessionDeps {
  /** Current wall-clock time in ms (tests override this). */
  now?: () => number;
}

export type StallAction =
  | { action: 'restarted'; attempt: number; sessionKey: string }
  | { action: 'human_decision' }
  | { action: 'skipped'; reason: string };

/**
 * Core watchdog decision for one task. Re-checks state inside a transaction so
 * a concurrently-arriving completion wins and the watchdog backs off.
 */
export async function handleStalledPlanning(
  taskId: string,
  deps?: WatchdogDeps
): Promise<StallAction> {
  const db = getDb();
  const now = deps?.now ? deps.now() : Date.now();

  // Phase 1 — transaction: verify the task is genuinely stalled and, if so,
  // atomically claim it (preserve history, bump counter, clear session).
  const claim = transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | (Record<string, unknown> & {
          status?: string;
          planning_complete?: number;
          planning_session_key?: string | null;
          planning_messages?: string | null;
          planning_updated_at?: string | null;
          auto_restart_count?: number;
          planning_history?: string | null;
        })
      | undefined;

    if (!task) return { ok: false as const, reason: 'task_not_found' };
    if (task.status !== 'planning') return { ok: false as const, reason: `status_${task.status}` };
    if (task.planning_complete === 1) return { ok: false as const, reason: 'already_complete' };
    if (!task.planning_session_key) return { ok: false as const, reason: 'no_session' };

    const last = lastPlanningActivityMs(task);
    if (last !== null && now - last < PLANNING_STALL_TIMEOUT_MS) {
      return { ok: false as const, reason: 'not_stalled_yet' };
    }
    if (isAwaitingUser(task.planning_messages)) {
      return { ok: false as const, reason: 'awaiting_user' };
    }

    const count = Number(task.auto_restart_count ?? 0);
    const canRestart = count < MAX_AUTO_RESTART;

    // Archive the stalled session (state preserved).
    let history: unknown[] = [];
    if (task.planning_history) {
      try {
        history = JSON.parse(task.planning_history);
      } catch {
        history = [];
      }
    }
    history.push({
      sessionKey: task.planning_session_key,
      messages: task.planning_messages ? JSON.parse(task.planning_messages) : [],
      stalledAt: new Date().toISOString(),
      reason: 'stall_timeout',
    });

    if (canRestart) {
      const newCount = count + 1;
      const nowIso = new Date().toISOString();
      db.prepare(`
        UPDATE tasks
        SET auto_restart_count = ?,
            planning_session_key = NULL,
            planning_dispatch_error = NULL,
            planning_updated_at = ?,
            status_reason = ?,
            planning_history = ?,
            updated_at = ?
        WHERE id = ?
      `).run(newCount, nowIso, `Planning stalled — auto-restart #${newCount}`, JSON.stringify(history), nowIso, taskId);
      return { ok: true as const, action: 'restart' as const, attempt: newCount };
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE tasks
      SET status = ?,
          planning_session_key = NULL,
          planning_dispatch_error = NULL,
          planning_updated_at = ?,
          status_reason = ?,
          planning_history = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      HUMAN_DECISION_STATUS,
      nowIso,
      `Planning stalled after ${MAX_AUTO_RESTART} auto-restart(s) — menunggu keputusan manusia`,
      JSON.stringify(history),
      nowIso,
      taskId
    );
    return { ok: true as const, action: 'human_decision' as const, attempt: count };
  });

  if (!claim.ok) {
    return { action: 'skipped', reason: claim.reason };
  }

  logPlanningActivity(
    taskId,
    'planning_stall_detected',
    `Planning session silent > ${Math.round(PLANNING_STALL_TIMEOUT_MS / 60000)} min — watchdog triggered`,
    { stalledMs: PLANNING_STALL_TIMEOUT_MS }
  );

  if (claim.action === 'human_decision') {
    logPlanningActivity(
      taskId,
      'planning_decision_needed',
      `Auto-restart budget exhausted (${MAX_AUTO_RESTART}/${MAX_AUTO_RESTART}) — menunggu keputusan manusia`,
      { maxAutoRestart: MAX_AUTO_RESTART }
    );
    broadcastTask(taskId);
    return { action: 'human_decision' };
  }

  // Phase 2 — restart: create a fresh session (network call, outside the tx).
  const started = await startPlanningSession(taskId, {
    attempt: claim.attempt,
    deps,
    onBeforeSend: () => {
      logPlanningActivity(
        taskId,
        'planning_restarted',
        `Planning auto-restarted (attempt ${claim.attempt}/${MAX_AUTO_RESTART}) — state preserved`,
        { attempt: claim.attempt, maxAutoRestart: MAX_AUTO_RESTART }
      );
    },
  });

  if (!started.ok) {
    // Restart could not even start (e.g. OpenClaw unreachable). Fail fast to a
    // human decision instead of looping the sweep.
    run(
      `UPDATE tasks SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?`,
      [HUMAN_DECISION_STATUS, `Auto-restart failed to start: ${started.error} — menunggu keputusan manusia`, new Date().toISOString(), taskId]
    );
    logPlanningActivity(
      taskId,
      'planning_decision_needed',
      `Auto-restart failed to start (${started.error}) — menunggu keputusan manusia`,
      { error: started.error }
    );
    broadcastTask(taskId);
    return { action: 'human_decision' };
  }

  broadcastTask(taskId);
  return { action: 'restarted', attempt: claim.attempt, sessionKey: started.sessionKey! };
}

// ── Polling sweep ───────────────────────────────────────────────────────────

let sweepInFlight: Promise<number> | null = null;

/**
 * One sweep: find all planning tasks, evaluate stall, act on the stalled ones.
 * Returns how many tasks were acted upon (restarted or sent to human decision).
 * Concurrent sweeps coalesce into a single run.
 */
export function checkPlanningStalls(deps?: WatchdogDeps): Promise<number> {
  if (sweepInFlight) return sweepInFlight;

  sweepInFlight = (async () => {
    const now = deps?.now ? deps.now() : Date.now();
    const candidates = queryAll<{ id: string }>(
      `SELECT id FROM tasks
       WHERE status = 'planning' AND planning_complete = 0 AND planning_session_key IS NOT NULL`
    );

    let acted = 0;
    for (const task of candidates) {
      const result = await handleStalledPlanning(task.id, deps);
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

// ── Request-level timeout guard ─────────────────────────────────────────────

const requestGuards = new Map<string, NodeJS.Timeout>();

/**
 * Arm a per-task one-shot guard: if the planning session is still silent
 * PLANNING_REQUEST_TIMEOUT_MS after the guard was armed (and not awaiting the
 * user), the stall handler fires immediately — no need to wait for the next
 * sweep tick. Re-arming replaces the previous guard (each new answer resets the
 * clock). Not used in tests (timers are environment-dependent); the sweep
 * covers the same logic deterministically.
 */
export function scheduleRequestGuard(taskId: string, deps?: WatchdogDeps): void {
  if (process.env.NODE_ENV === 'test') return;
  const existing = requestGuards.get(taskId);
  if (existing) clearTimeout(existing);

  const armedAt = Date.now();
  const timer = setTimeout(() => {
    requestGuards.delete(taskId);
    const task = queryOne<{
      status?: string;
      planning_complete?: number;
      planning_session_key?: string | null;
      planning_updated_at?: string | null;
      planning_messages?: string | null;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task || task.status !== 'planning' || task.planning_complete === 1 || !task.planning_session_key) {
      return; // completed, cancelled, or otherwise no longer planning
    }
    const last = lastPlanningActivityMs(task);
    if (last !== null && Date.now() - last < PLANNING_REQUEST_TIMEOUT_MS) return;
    if (isAwaitingUser(task.planning_messages)) return;
    if (last !== null && armedAt < last) return; // activity happened after arming

    handleStalledPlanning(taskId, deps).catch((err) => {
      console.error(`[PlanningWatchdog] request guard failed for task ${taskId}:`, err);
    });
  }, PLANNING_REQUEST_TIMEOUT_MS);

  requestGuards.set(taskId, timer);
}

/** Clear any pending request guard (used when planning ends/cancels). */
export function clearRequestGuard(taskId: string): void {
  const existing = requestGuards.get(taskId);
  if (existing) {
    clearTimeout(existing);
    requestGuards.delete(taskId);
  }
}

// ── Scheduler bootstrap ─────────────────────────────────────────────────────

/**
 * Start the polling scheduler. Called once from getDb() (same pattern as
 * ensureCatalogSyncScheduled). No-op in test env — tests drive
 * checkPlanningStalls() directly.
 */
export function ensurePlanningWatchdogScheduled(): void {
  if (process.env.NODE_ENV === 'test') return;
  const g = globalThis as unknown as { __mcPlanningWatchdogTimer?: NodeJS.Timeout };
  if (g.__mcPlanningWatchdogTimer) return;
  g.__mcPlanningWatchdogTimer = setInterval(() => {
    checkPlanningStalls().then((acted) => {
      if (acted > 0) {
        console.log(`[PlanningWatchdog] sweep handled ${acted} stalled planning task(s)`);
      }
    }).catch((err) => {
      console.error('[PlanningWatchdog] sweep failed:', err);
    });
  }, WATCHDOG_POLL_INTERVAL_MS);
  console.log(`[PlanningWatchdog] scheduler started (interval ${WATCHDOG_POLL_INTERVAL_MS}ms, stall timeout ${PLANNING_STALL_TIMEOUT_MS}ms, max restart ${MAX_AUTO_RESTART})`);
}
