/**
 * GLOBAL SESSION CONTEXT & COMPACTION REMEDIATION — Handoff watchdog.
 *
 * Proactive bounded-session lifecycle sweep. While the stage watchdog acts on
 * STALLED sessions (silent > 30 min), this watchdog acts on BUDGET pressure:
 * a session approaching hard context exhaustion is checkpointed and rolled
 * over BEFORE auto-compaction fails mid-turn ("Auto-compaction could not
 * recover this turn").
 *
 * Contract (§6/§8/§16/§26):
 *  1. Evaluate every ACTIVE pipeline session against the context budget
 *     (live telemetry when available; conservative proxies otherwise).
 *  2. warning   → cooldown-bounded `context_budget_warning` activity.
 *  3. rollover  → persist a valid HANDOFF_CHECKPOINT (agent-authored if
 *                 present on disk, else mechanical synthesis), log
 *                 checkpoint_started/completed, mark the task
 *                 ROLLOVER_REQUESTED, end the old session
 *                 (rotation_reason='ctx_budget:auto-rollover'), re-dispatch.
 *                 The dispatch route then injects the BOUNDED continuation
 *                 context into the fresh session and flips the task to ARMED.
 *  4. failures  → HANDOFF_BLOCKED (checkpoint could not be produced: session
 *                 left running, nothing terminated) or CONTINUATION_PENDING
 *                 (checkpoint fine, fresh session could not start; retried by
 *                 later sweeps and by any manual/stage re-dispatch — all of
 *                 which inject the checkpoint because the metadata flag is
 *                 read by the dispatch route).
 *
 * Race safety: the decision is claimed inside a transaction; phase 2 ends the
 * session with a conditional UPDATE (status='active' → 'rotated') so a
 * concurrent sweep / stage watchdog that already acted wins and we back off.
 * An in-flight grace window (recent session_handoff_started activity) skips
 * tasks whose rollover is already running.
 *
 * No LLM, no canonical writes: execution-lifecycle state only.
 */

import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import {
  evaluateContextBudget,
  resolveContextBudgetConfig,
  getLatestHandoffCheckpoint,
  getContinuationIndex,
  saveHandoffCheckpointRow,
  synthesizeHandoffCheckpoint,
  validateHandoffCheckpoint,
  renderHandoffCheckpoint,
  writeHandoffCheckpointAtomic,
  logHandoffActivity,
  lastHandoffActivity,
  lastHandoffActivityMs,
  readHandoffMetadata,
  writeHandoffMetadata,
  type ContextBudgetVerdict,
  type HandoffCheckpointV1,
} from '@/lib/session-handoff';
import { defaultRedispatch, type RedispatchResult } from '@/lib/stage-watchdog';

// ── Configuration (env overridable) ─────────────────────────────────────────

/** How often the handoff sweep runs. Default 60s (cheap; DB-only fast path). */
export const HANDOFF_WATCHDOG_POLL_INTERVAL_MS = parseInt(
  process.env.PLATFORM_HANDOFF_WATCHDOG_POLL_INTERVAL_MS || '60000',
  10
);

/** Minimum session run age before the sweep may act (tokens refresh at dispatch). */
export const HANDOFF_MIN_SESSION_AGE_MS = parseInt(
  process.env.PLATFORM_HANDOFF_MIN_SESSION_AGE_MS || '300000',
  10
);

/** Cooldown between two context_budget_warning activities for the same task. */
export const HANDOFF_WARN_COOLDOWN_MS = parseInt(
  process.env.PLATFORM_HANDOFF_WARN_COOLDOWN_MS || '3600000',
  10
);

/** In-flight grace: skip rollover when session_handoff_started is this recent. */
export const HANDOFF_INFLIGHT_GRACE_MS = parseInt(
  process.env.PLATFORM_HANDOFF_INFLIGHT_GRACE_MS || '300000',
  10
);

/** rotation_reason written when the sweep ends a session for budget pressure. */
export const HANDOFF_ROTATION_REASON = 'ctx_budget:auto-rollover';

/** Statuses that must never be rolled over by this watchdog. */
const SKIP_TASK_STATUSES = ['done', 'planning', 'pending_dispatch', 'menunggu_keputusan_manusia', 'inbox'] as const;

// ── Candidate scan ──────────────────────────────────────────────────────────

interface HandoffCandidateRow {
  session_id: string;
  session_row_id: string;
  task_id: string;
  task_title: string;
  task_status: string;
  task_metadata: string | null;
  task_workspace_path: string | null;
  agent_id: string | null;
  openclaw_session_id: string;
  run_number: number | null;
  total_tokens: number | null;
  file_size_bytes: number | null;
  created_at: string;
}

export interface HandoffCandidate {
  sessionRowId: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  taskMetadata: string | null;
  taskWorkspacePath: string | null;
  agentId: string | null;
  gatewaySessionKey: string;
  runNumber: number;
  totalTokens: number | null;
  fileSizeBytes: number | null;
  sessionCreatedAt: string;
}

/** All ACTIVE pipeline sessions eligible for budget evaluation. Read-only. */
export function listHandoffCandidates(): HandoffCandidate[] {
  const rows = queryAll<HandoffCandidateRow>(
    `SELECT s.id AS session_row_id, s.task_id, s.agent_id, s.openclaw_session_id,
            s.run_number, s.total_tokens, s.file_size_bytes, s.created_at,
            t.title AS task_title, t.status AS task_status, t.metadata AS task_metadata,
            t.workspace_path AS task_workspace_path
       FROM openclaw_sessions s
       JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'active'
        AND t.status NOT IN (${SKIP_TASK_STATUSES.map(() => '?').join(',')})
      ORDER BY s.created_at ASC`,
    [...SKIP_TASK_STATUSES]
  );
  return rows.map((r) => ({
    sessionRowId: r.session_row_id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    taskStatus: r.task_status,
    taskMetadata: r.task_metadata,
    taskWorkspacePath: r.task_workspace_path,
    agentId: r.agent_id,
    gatewaySessionKey: r.openclaw_session_id,
    runNumber: r.run_number ?? 1,
    totalTokens: r.total_tokens,
    fileSizeBytes: r.file_size_bytes,
    sessionCreatedAt: r.created_at,
  }));
}

// ── Budget evaluation with optional gateway enrichment ─────────────────────

export interface HandoffTelemetry {
  liveContextTokens?: number | null;
  contextWindow?: number | null;
  totalTokens?: number | null;
  transcriptBytes?: number | null;
}

export interface HandoffWatchdogDeps {
  now?: () => number;
  /**
   * Best-effort live telemetry provider (gateway sessions.list / models.list /
   * chat.history). Returns null entries when the gateway is unreachable — the
   * sweep then falls back to conservative DB-only signals (row totals).
   */
  telemetry?: (candidates: HandoffCandidate[]) => Promise<Record<string, HandoffTelemetry> | null>;
  redispatch?: (taskId: string) => Promise<RedispatchResult>;
}

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

/** Evaluate one candidate against the budget (pure; deps inject telemetry). */
export function evaluateCandidateBudget(
  candidate: HandoffCandidate,
  telemetry: HandoffTelemetry | null,
  nowMs: number
): ContextBudgetVerdict {
  const sessionAgeMs = (() => {
    const t = parseDbTimestamp(candidate.sessionCreatedAt);
    return t === null ? null : Math.max(0, nowMs - t);
  })();
  return evaluateContextBudget(
    {
      liveContextTokens: telemetry?.liveContextTokens ?? null,
      contextWindow: telemetry?.contextWindow ?? null,
      totalTokens: telemetry?.totalTokens ?? candidate.totalTokens,
      transcriptBytes: telemetry?.transcriptBytes ?? candidate.fileSizeBytes,
      sessionAgeMs,
    },
    resolveContextBudgetConfig()
  );
}

// ── Sweep ───────────────────────────────────────────────────────────────────

export interface HandoffSweepResult {
  evaluated: number;
  warned: number;
  rolloversStarted: number;
  blocked: number;
  continuationPending: number;
  skipped: number;
}

interface RolloverClaim {
  ok: boolean;
  reason?: string;
  checkpoint?: HandoffCheckpointV1;
  checkpointRowId?: string;
  sessionRowId?: string;
}

/**
 * Phase 1 — claim a budget rollover for a task/dession inside a transaction.
 * Produces (or reuses) a valid checkpoint, persists it, marks the task
 * ROLLOVER_REQUESTED and records checkpoint_started/completed. Does NOT end
 * the session (phase 2 re-checks status conditionally).
 */
function claimBudgetRollover(
  candidate: HandoffCandidate,
  nowMs: number,
  reason: string
): RolloverClaim {
  const db = queryOne<{ status: string; updated_at: string }>(
    'SELECT status, updated_at FROM openclaw_sessions WHERE id = ?',
    [candidate.sessionRowId]
  );
  if (!db || db.status !== 'active') return { ok: false, reason: 'session_not_active' };

  const task = queryOne<{ id: string; status: string; metadata: string | null }>(
    'SELECT id, status, metadata FROM tasks WHERE id = ?',
    [candidate.taskId]
  );
  if (!task) return { ok: false, reason: 'task_not_found' };
  if ((SKIP_TASK_STATUSES as readonly string[]).includes(task.status)) {
    return { ok: false, reason: `task_status_${task.status}` };
  }

  // In-flight guard: a rollover for THIS SAME session that already started
  // recently (another sweep is mid-flight). A rollover of a DIFFERENT
  // (previous) session must not block the current one (sequential rollovers).
  const started = lastHandoffActivity(candidate.taskId, 'session_handoff_started');
  if (
    started &&
    started.createdAtMs !== null &&
    nowMs - started.createdAtMs <= HANDOFF_INFLIGHT_GRACE_MS &&
    started.metadata &&
    started.metadata.sessionId === candidate.sessionRowId
  ) {
    return { ok: false, reason: 'rollover_in_flight' };
  }

  // Reuse an existing valid checkpoint when one is present (idempotent).
  let checkpoint: HandoffCheckpointV1;
  let checkpointRowId: string;
  const nextOrdinal = getContinuationIndex(candidate.taskId) + 1;
  const existing = getLatestHandoffCheckpoint(candidate.taskId);
  if (existing && validateHandoffCheckpoint(existing.cp).ok) {
    checkpoint = {
      ...existing.cp,
      identity: {
        ...existing.cp.identity,
        continuationIndex: nextOrdinal,
        timestamp: new Date(nowMs).toISOString(),
      },
      reason,
    };
    checkpointRowId = existing.row.id;
  } else {
    const synthesized = synthesizeHandoffCheckpoint(candidate.taskId, reason, task.status);
    if (!synthesized || !validateHandoffCheckpoint(synthesized).ok) {
      return { ok: false, reason: 'checkpoint_synthesis_failed' };
    }
    checkpoint = { ...synthesized, identity: { ...synthesized.identity, continuationIndex: nextOrdinal } };
    checkpointRowId = '';
  }

  // Persist (fresh row each rollover keeps an auditable chain).
  const row = saveHandoffCheckpointRow({
    taskId: candidate.taskId,
    agentId: candidate.agentId,
    checkpointType: 'auto',
    cp: checkpoint,
  });
  checkpointRowId = row.id;

  // Best-effort: write the canonical markdown into the task workspace.
  if (candidate.taskWorkspacePath) {
    try {
      writeHandoffCheckpointAtomic(candidate.taskWorkspacePath, renderHandoffCheckpoint(checkpoint));
    } catch {
      // file write is best-effort; the DB row is authoritative
    }
  }

  writeHandoffMetadata(candidate.taskId, {
    handoff_status: 'ROLLOVER_REQUESTED',
    handoff_checkpoint_id: checkpointRowId,
    handoff_continuation_index: nextOrdinal,
  });

  logHandoffActivity(
    candidate.taskId,
    'checkpoint_started',
    `Context budget rollover — checkpoint ${checkpointRowId} produced (${checkpoint.generatedBy})`,
    { checkpointId: checkpointRowId, reason, sessionId: candidate.sessionRowId }
  );
  logHandoffActivity(
    candidate.taskId,
    'checkpoint_completed',
    `Checkpoint valid (HANDOFF_CHECKPOINT_V1) — completed ${checkpoint.completed.length}, remaining ${checkpoint.remaining.length}`,
    { checkpointId: checkpointRowId, generatedBy: checkpoint.generatedBy }
  );

  return { ok: true, checkpoint, checkpointRowId, sessionRowId: candidate.sessionRowId };
}

/**
 * Phase 2 — end the old session (conditional) and re-dispatch. The dispatch
 * route injects the bounded continuation context (task metadata
 * ROLLOVER_REQUESTED) and flips the task to ARMED + logs
 * continuation_session_started / checkpoint_resume_verified on success.
 */
async function executeRollover(
  candidate: HandoffCandidate,
  claim: RolloverClaim,
  reason: string,
  deps?: HandoffWatchdogDeps
): Promise<'redispatched' | 'continuation_pending' | 'skipped'> {
  const nowIso = new Date().toISOString();
  logHandoffActivity(
    candidate.taskId,
    'session_handoff_started',
    `Ending session run ${candidate.runNumber} (${reason}) — re-dispatching with bounded continuation context`,
    { sessionId: candidate.sessionRowId, checkpointId: claim.checkpointRowId ?? null, reason }
  );

  // Conditional end: only if still active (a concurrent actor wins → skip).
  const res = run(
    `UPDATE openclaw_sessions
        SET status = 'rotated', ended_at = ?, updated_at = ?, rotation_reason = ?
      WHERE id = ? AND status = 'active'`,
    [nowIso, nowIso, HANDOFF_ROTATION_REASON, candidate.sessionRowId]
  );
  if (res.changes === 0) {
    return 'skipped';
  }

  const redispatch = deps?.redispatch ?? defaultRedispatch;
  let result: RedispatchResult;
  try {
    result = await redispatch(candidate.taskId);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.ok) {
    writeHandoffMetadata(candidate.taskId, {
      handoff_status: 'CONTINUATION_PENDING',
      handoff_checkpoint_id: claim.checkpointRowId ?? undefined,
    });
    logHandoffActivity(
      candidate.taskId,
      'continuation_pending',
      `Fresh session could not start (${result.error ?? 'unknown'}) — checkpoint preserved; retry will inject continuation`,
      { checkpointId: claim.checkpointRowId ?? null, error: result.error ?? null }
    );
    return 'continuation_pending';
  }

  // Success: the dispatch route logs continuation_session_started +
  // checkpoint_resume_verified once the bounded context is actually
  // delivered — single source of truth for resume confirmation (§25).
  return 'redispatched';
}

/**
 * One sweep: evaluate all active pipeline sessions, warn or roll over per the
 * budget contract. Returns the summary counts. Never throws per-candidate
 * (failures are recorded as HANDOFF_BLOCKED / CONTINUATION_PENDING state).
 */
export async function checkHandoffBudgets(deps?: HandoffWatchdogDeps): Promise<HandoffSweepResult> {
  const nowMs = deps?.now ? deps.now() : Date.now();
  const config = resolveContextBudgetConfig();
  const summary: HandoffSweepResult = {
    evaluated: 0,
    warned: 0,
    rolloversStarted: 0,
    blocked: 0,
    continuationPending: 0,
    skipped: 0,
  };

  const candidates = listHandoffCandidates();
  if (candidates.length === 0) return summary;

  let telemetry: Record<string, HandoffTelemetry> | null = null;
  if (deps?.telemetry) {
    try {
      telemetry = await deps.telemetry(candidates);
    } catch {
      telemetry = null;
    }
  }

  for (const candidate of candidates) {
    summary.evaluated += 1;
    try {
      const outcome = processCandidate(candidate, telemetry, nowMs, config, summary, deps);
      if (outcome) await outcome;
    } catch (err) {
      // Fail-closed: a candidate that cannot be processed never silently
      // terminates anything; record HANDOFF_BLOCKED and continue the sweep.
      console.error(`[HandoffWatchdog] candidate failed for task ${candidate.taskId}:`, err);
      try {
        logHandoffActivity(
          candidate.taskId,
          'session_handoff_failed',
          `HANDOFF_BLOCKED: sweep error (${err instanceof Error ? err.message : String(err)}) — session left running`,
          { sessionId: candidate.sessionRowId }
        );
      } catch {
        // best-effort
      }
      summary.blocked += 1;
    }
  }

  return summary;
}

/** Per-candidate evaluation (kept separate so sweep can fail-closed per item). */
function processCandidate(
  candidate: HandoffCandidate,
  telemetry: Record<string, HandoffTelemetry> | null,
  nowMs: number,
  config: ReturnType<typeof resolveContextBudgetConfig>,
  summary: HandoffSweepResult,
  deps?: HandoffWatchdogDeps
): Promise<void> | void {
  // Minimum age guard — a just-dispatched session has fresh counters; do not
  // act on incomplete telemetry.
  const createdMs = parseDbTimestamp(candidate.sessionCreatedAt);
  if (createdMs !== null && nowMs - createdMs < HANDOFF_MIN_SESSION_AGE_MS) {
    summary.skipped += 1;
    return;
  }

  const verdict = evaluateCandidateBudget(candidate, telemetry?.[candidate.sessionRowId] ?? null, nowMs);
  if (verdict.level === 'ok') return;

  if (verdict.level === 'warning') {
    const lastWarn = lastHandoffActivityMs(candidate.taskId, 'context_budget_warning');
    if (lastWarn === null || nowMs - lastWarn >= HANDOFF_WARN_COOLDOWN_MS) {
      logHandoffActivity(
        candidate.taskId,
        'context_budget_warning',
        `Context budget warning (session run ${candidate.runNumber}): ${verdict.reasons.join('; ')}`,
        { sessionId: candidate.sessionRowId, signals: verdict.signals, liveCtxPct: verdict.liveCtxPct }
      );
      broadcastTask(candidate.taskId);
      summary.warned += 1;
    }
    return;
  }

  // rollover_required
  if (!config.autoRolloverEnabled) {
    // Kill-switch: record the warning-class signal only.
    logHandoffActivity(
      candidate.taskId,
      'context_budget_warning',
      `Rollover required but PLATFORM_HANDOFF_AUTO_ROLLOVER=0 (kill-switch) — ${verdict.reasons.join('; ')}`,
      { sessionId: candidate.sessionRowId, signals: verdict.signals, autoRollover: false }
    );
    return;
  }

  const reason = verdict.reasons.join('; ');
  const claim = claimBudgetRollover(candidate, nowMs, reason);
  if (!claim.ok) {
    if (claim.reason && claim.reason !== 'session_not_active' && claim.reason !== 'rollover_in_flight') {
      // Checkpoint could not be produced — DO NOT terminate the session (§26).
      logHandoffActivity(
        candidate.taskId,
        'session_handoff_failed',
        `HANDOFF_BLOCKED: ${claim.reason} — active session left running`,
        { reason: claim.reason, sessionId: candidate.sessionRowId }
      );
      broadcastTask(candidate.taskId);
      summary.blocked += 1;
    } else {
      summary.skipped += 1;
    }
    return;
  }

  return executeRollover(candidate, claim, reason, deps).then((outcome) => {
    if (outcome === 'redispatched') summary.rolloversStarted += 1;
    else if (outcome === 'continuation_pending') summary.continuationPending += 1;
    else summary.skipped += 1;
    broadcastTask(candidate.taskId);
  });
}

function broadcastTask(taskId: string): void {
  try {
    const updated = queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updated) broadcast({ type: 'task_updated', payload: updated as never });
  } catch {
    // UI refresh is best-effort
  }
}

// ── Scheduler bootstrap (same pattern as the other watchdogs) ──────────────

let sweepInFlight: Promise<HandoffSweepResult> | null = null;

/** Start the handoff polling scheduler. No-op in test env. */
export function ensureHandoffWatchdogScheduled(): void {
  if (process.env.NODE_ENV === 'test') return;
  const g = globalThis as unknown as { __mcHandoffWatchdogTimer?: NodeJS.Timeout };
  if (g.__mcHandoffWatchdogTimer) return;
  g.__mcHandoffWatchdogTimer = setInterval(() => {
    if (sweepInFlight) return; // coalesce
    sweepInFlight = checkHandoffBudgets()
      .then((summary) => {
        if (summary.warned + summary.rolloversStarted + summary.blocked + summary.continuationPending > 0) {
          console.log('[HandoffWatchdog] sweep:', JSON.stringify(summary));
        }
        return summary;
      })
      .catch((err) => {
        console.error('[HandoffWatchdog] sweep failed:', err);
        return { evaluated: 0, warned: 0, rolloversStarted: 0, blocked: 0, continuationPending: 0, skipped: 0 };
      })
      .finally(() => {
        sweepInFlight = null;
      }) as Promise<HandoffSweepResult>;
  }, HANDOFF_WATCHDOG_POLL_INTERVAL_MS);
  console.log(
    `[HandoffWatchdog] scheduler started (interval ${HANDOFF_WATCHDOG_POLL_INTERVAL_MS}ms, ` +
      `warn>=${resolveContextBudgetConfig().warnPct}% rollover>=${resolveContextBudgetConfig().rolloverPct}%)`
  );
}

/** Test helper: wait for any in-flight sweep to settle. */
export async function _waitForSweep(): Promise<void> {
  if (sweepInFlight) await sweepInFlight.catch(() => undefined);
}

// Re-export for route/test convenience (kept here so callers import one module).
export { readHandoffMetadata, writeHandoffMetadata, getLatestHandoffCheckpoint };
