/**
 * PLATFORM-008 — Session lifecycle & honest token metrics
 *
 * Health-check + rotation for pipeline dispatch sessions.
 *
 * Why: MRN-104 (2026-08-05) — run-1 burned 7.1M cumulative tokens / 718% in 12
 * minutes and retry re-used the same bloated session (reusedExistingSession),
 * re-injecting the whole history on every call (quadratic cost).
 *
 * Rules (env-driven thresholds):
 *   - PLATFORM_SESSION_MAX_TOTAL_TOKENS   default 1_000_000 — cumulative run cap
 *   - PLATFORM_SESSION_CTX_HIGH_WATER_PCT default 90        — % of the model
 *     context window considered "live context too full" (used when a live
 *     context estimate is available; otherwise the live estimate falls back to
 *     the transcript tail).
 *
 * A session is UNHEALTHY (→ rotate to a NEW session key, never reuse) when:
 *   1. the DB row is not 'active' (previous run failed / blocked / completed), or
 *   2. cumulative totalTokens > maxTotalTokens, or
 *   3. live context estimate > contextWindow * ctxHighWaterPct / 100.
 */

import { queryOne, queryAll, run } from '@/lib/db';
import type { OpenClawSession } from '@/lib/types';

export const SESSION_HEALTH_VERSION = 'session-health/v1';

export const DEFAULT_MAX_TOTAL_TOKENS = 1_000_000;
export const DEFAULT_CTX_HIGH_WATER_PCT = 90;

export interface SessionHealthConfig {
  /** Cumulative-token cap per run (env PLATFORM_SESSION_MAX_TOTAL_TOKENS). */
  maxTotalTokens: number;
  /** High-water mark for live context as % of the model context window (env PLATFORM_SESSION_CTX_HIGH_WATER_PCT). */
  ctxHighWaterPct: number;
}

/**
 * Subset of the OpenClaw gateway `sessions.list` row we consume.
 * NOTE: the gateway fills `contextTokens` with the model context WINDOW when no
 * live estimate is stored, so callers must pass `liveContextTokens` (a real
 * estimate) separately to avoid the misleading totalTokens/window "ctx %".
 */
export interface GatewaySessionInfo {
  key?: string;
  sessionId?: string;
  status?: string;
  totalTokens?: number | null;
  totalTokensFresh?: boolean;
  contextTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  model?: string | null;
  modelProvider?: string | null;
  compactionCheckpointCount?: number | null;
  startedAt?: number | null;
  endedAt?: number | null;
  runtimeMs?: number | null;
}

export interface SessionHealthVerdict {
  healthy: boolean;
  reasons: string[];
  /** Cumulative run tokens (kumulatif run). */
  totalTokens: number | null;
  /** Live context estimate (tokens currently in the model context). */
  contextTokens: number | null;
  /** Model context window in tokens. */
  contextWindow: number | null;
  /** Honest ctx % = live context / window * 100. null when no live estimate. */
  ctxPct: number | null;
  /** Informational only — cumulative / window. NEVER displayed as "ctx %". */
  cumulativePct: number | null;
}

/** Resolve env-driven thresholds with safe defaults. */
export function resolveSessionHealthConfig(
  env: NodeJS.ProcessEnv = process.env
): SessionHealthConfig {
  const rawMax = env.PLATFORM_SESSION_MAX_TOTAL_TOKENS;
  const rawPct = env.PLATFORM_SESSION_CTX_HIGH_WATER_PCT;

  const parsedMax = rawMax ? Number(rawMax) : NaN;
  const parsedPct = rawPct ? Number(rawPct) : NaN;

  return {
    maxTotalTokens:
      Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : DEFAULT_MAX_TOTAL_TOKENS,
    ctxHighWaterPct:
      Number.isFinite(parsedPct) && parsedPct > 0 && parsedPct <= 100 ? parsedPct : DEFAULT_CTX_HIGH_WATER_PCT,
  };
}

/** Rough token estimate: ~4 chars per token (English/JSON mix). */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/**
 * Estimate live context from a bounded transcript tail (chat.history rows).
 * The gateway's `chat.history` returns message entries with a `content` field;
 * we sum serialized content length / 4 as a cheap, honest fallback when the
 * session store has no live `contextTokens` estimate.
 */
export function estimateLiveContextFromHistory(history: unknown[] | null | undefined): number | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  let chars = 0;
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const content = rec.content;
    if (typeof content === 'string') chars += content.length;
    else if (content !== undefined && content !== null) {
      try {
        chars += JSON.stringify(content).length;
      } catch {
        // ignore unserializable entries
      }
    }
  }
  if (chars <= 0) return null;
  return estimateTokensFromChars(chars);
}

/**
 * Pure health evaluation — unit-testable without a gateway.
 *
 * @param dbSession      the mission-control openclaw_sessions row (status/tokens)
 * @param gatewayInfo    optional gateway sessions.list row for the same session key
 * @param estimatedContextTokens optional live-context estimate (transcript tail)
 * @param contextWindow  model context window in tokens. When known, a gateway
 *                       `contextTokens` equal to the window is recognized as a
 *                       fallback (not live usage) and ignored for the high-water
 *                       check — preventing false-positive rotations.
 * @param config         env-driven thresholds
 */
export function evaluateSessionHealth(params: {
  dbSession?: Pick<OpenClawSession, 'status' | 'total_tokens' | 'run_number'> | null;
  gatewayInfo?: GatewaySessionInfo | null;
  estimatedContextTokens?: number | null;
  contextWindow?: number | null;
  config?: SessionHealthConfig;
}): SessionHealthVerdict {
  const config = params.config ?? resolveSessionHealthConfig();
  const reasons: string[] = [];

  const dbTotal = params.dbSession?.total_tokens ?? null;
  const gatewayTotal =
    typeof params.gatewayInfo?.totalTokens === 'number' && Number.isFinite(params.gatewayInfo.totalTokens)
      ? params.gatewayInfo.totalTokens
      : null;
  // Prefer gateway truth (live counters), fall back to DB snapshot.
  const totalTokens = gatewayTotal ?? dbTotal;

  const gatewayCtx =
    typeof params.gatewayInfo?.contextTokens === 'number' && Number.isFinite(params.gatewayInfo.contextTokens)
      ? params.gatewayInfo.contextTokens
      : null;
  const contextWindow = params.contextWindow ?? null;
  // The gateway fills `contextTokens` with the model window when no live
  // estimate is stored. Only trust it as live when we know the window and the
  // values differ (or when a real transcript-tail estimate was provided).
  const explicitEstimate =
    typeof params.estimatedContextTokens === 'number' && Number.isFinite(params.estimatedContextTokens)
      ? params.estimatedContextTokens
      : null;
  const gatewayFallback =
    contextWindow !== null && gatewayCtx !== null && gatewayCtx === contextWindow;
  const contextTokens = explicitEstimate ?? (gatewayFallback ? null : gatewayCtx);

  const ctxPct =
    contextTokens !== null && contextWindow !== null && contextWindow > 0
      ? Math.round((contextTokens / contextWindow) * 100)
      : null;
  const cumulativePct =
    totalTokens !== null && contextWindow !== null && contextWindow > 0
      ? Math.round((totalTokens / contextWindow) * 100)
      : null;

  // 1. Previous run failed / blocked / completed → never reuse.
  if (params.dbSession && params.dbSession.status !== 'active') {
    reasons.push(`session_status:${params.dbSession.status}`);
  }

  // 1b. Gateway-side status (the gateway marks runs done/failed/running).
  // A gateway status outside the live set means the previous run ended — the
  // session must not be reused even if the DB row is stale.
  const gwStatus = params.gatewayInfo?.status;
  if (typeof gwStatus === 'string' && gwStatus.trim().length > 0 && !['active', 'running'].includes(gwStatus)) {
    reasons.push(`gateway_status:${gwStatus}`);
  }

  // 2. Cumulative token cap.
  if (totalTokens !== null && totalTokens > config.maxTotalTokens) {
    reasons.push(`total_tokens_exceeded:${totalTokens}>${config.maxTotalTokens}`);
  }

  // 3. Live context high-water (only when a live estimate exists).
  if (
    contextTokens !== null &&
    contextWindow !== null &&
    contextWindow > 0 &&
    contextTokens > (contextWindow * config.ctxHighWaterPct) / 100
  ) {
    reasons.push(`ctx_high_water:${contextTokens}>${Math.round((contextWindow * config.ctxHighWaterPct) / 100)}`);
  }

  return {
    healthy: reasons.length === 0,
    reasons,
    totalTokens,
    contextTokens,
    contextWindow,
    ctxPct,
    cumulativePct,
  };
}

/**
 * Build a NEW gateway session key for a rotated run.
 *
 * The `uniqueSuffix` (short uuid) guarantees the gateway key is fresh even when
 * a previous rotation already used the same run number — reusing a gateway key
 * would re-inject the old transcript (the reusedExistingSession failure mode).
 */
export function buildRotatedSessionKey(agentName: string, taskId: string, runNumber: number, uniqueSuffix?: string): string {
  const slug = agentName.toLowerCase().replace(/\s+/g, '-');
  const suffix = uniqueSuffix || Math.random().toString(36).slice(2, 10);
  return `mission-control-${slug}-${taskId}-r${Math.max(1, runNumber)}-${suffix}`;
}

/** Mark an existing session row as rotated (audit trail, no delete). */
export function markSessionRotated(sessionId: string, reason: string): void {
  const now = new Date().toISOString();
  run(
    `UPDATE openclaw_sessions
     SET status = 'rotated', ended_at = ?, updated_at = ?
     WHERE id = ? AND status = 'active'`,
    [now, now, sessionId]
  );
  console.info(`[SessionHealth] Marked session ${sessionId} rotated (${reason})`);
}

/** Persist honest token counters onto a session row (A2). */
export function recordSessionTokens(sessionId: string, totals: {
  totalTokens?: number | null;
  contextTokens?: number | null;
  runNumber?: number;
}): void {
  const patch: string[] = ['updated_at = ?'];
  const params: unknown[] = [new Date().toISOString()];
  if (typeof totals.totalTokens === 'number' && Number.isFinite(totals.totalTokens)) {
    patch.push('total_tokens = ?');
    params.push(Math.floor(totals.totalTokens));
  }
  if (typeof totals.contextTokens === 'number' && Number.isFinite(totals.contextTokens)) {
    patch.push('context_tokens = ?');
    params.push(Math.floor(totals.contextTokens));
  }
  if (typeof totals.runNumber === 'number' && Number.isFinite(totals.runNumber)) {
    patch.push('run_number = ?');
    params.push(Math.floor(totals.runNumber));
  }
  params.push(sessionId);
  run(`UPDATE openclaw_sessions SET ${patch.join(', ')} WHERE id = ?`, params);
}

export interface DispatchSessionResolution {
  session: OpenClawSession;
  /** true when a NEW session key was created because the old one was unhealthy */
  rotated: boolean;
  /** reasons that triggered rotation (empty when not rotated) */
  rotationReasons: string[];
  /** health verdict of the pre-existing session (null when none existed) */
  verdict: SessionHealthVerdict | null;
  reusedExistingSession: boolean;
  runNumber: number;
}

export interface ResolveDispatchSessionParams {
  taskId: string;
  agentId: string;
  agentName: string;
  /** gateway sessions.list rows keyed by sessionKey (may be empty on gateway hiccup) */
  gatewaySessions?: GatewaySessionInfo[];
  /** pre-resolved live context estimates keyed by sessionKey (transcript tail) */
  contextEstimates?: Record<string, number | null>;
  /** model context window for the session's model (fallback detection) */
  contextWindow?: number | null;
  /** existing active DB session for (agent, task); caller may pass null to force create */
  existingSession?: OpenClawSession | null;
  /** prefix used to build the gateway session key (e.g. agent:builder:) */
  sessionKeyPrefix: string;
  /** env config override (tests) */
  config?: SessionHealthConfig;
}

/**
 * Core dispatch decision (A1): reuse the existing session only when it is
 * healthy; otherwise rotate to a NEW session key. Healthy sessions are never
 * churned. Returns the resolved session plus rotation diagnostics.
 */
export function resolveDispatchSession(params: ResolveDispatchSessionParams): DispatchSessionResolution {
  const config = params.config ?? resolveSessionHealthConfig();
  const { taskId, agentId, agentName, sessionKeyPrefix } = params;

  const runNumber = params.existingSession?.run_number ?? 1;

  if (!params.existingSession) {
    // No previous session — create the first run.
    const session = createDispatchSessionRow({
      taskId,
      agentId,
      agentName,
      runNumber: 1,
    });
    return {
      session,
      rotated: false,
      rotationReasons: [],
      verdict: null,
      reusedExistingSession: false,
      runNumber: 1,
    };
  }

  const existingKey = `${sessionKeyPrefix}${params.existingSession.openclaw_session_id}`;
  const gatewayInfo =
    params.gatewaySessions?.find(g => g.key === existingKey || g.sessionId === params.existingSession?.openclaw_session_id) ?? null;
  const estimatedContextTokens = params.contextEstimates?.[existingKey] ?? null;

  const verdict = evaluateSessionHealth({
    dbSession: params.existingSession,
    gatewayInfo,
    estimatedContextTokens,
    contextWindow: params.contextWindow ?? null,
    config,
  });

  if (verdict.healthy) {
    // Healthy → reuse, no churn.
    return {
      session: params.existingSession,
      rotated: false,
      rotationReasons: [],
      verdict,
      reusedExistingSession: true,
      runNumber,
    };
  }

  // Unhealthy → rotate to a NEW session key (never reuse bloated/failed sessions).
  const nextRun = runNumber + 1;
  markSessionRotated(params.existingSession.id, verdict.reasons.join('; '));
  const session = createDispatchSessionRow({
    taskId,
    agentId,
    agentName,
    runNumber: nextRun,
    rotatedFrom: params.existingSession.id,
    rotationReason: verdict.reasons.join('; '),
  });

  return {
    session,
    rotated: true,
    rotationReasons: verdict.reasons,
    verdict,
    reusedExistingSession: false,
    runNumber: nextRun,
  };
}

function createDispatchSessionRow(params: {
  taskId: string;
  agentId: string;
  agentName: string;
  runNumber: number;
  rotatedFrom?: string;
  rotationReason?: string;
}): OpenClawSession {
  const sessionId = crypto.randomUUID();
  const openclawSessionId =
    params.runNumber <= 1
      ? `mission-control-${params.agentName.toLowerCase().replace(/\s+/g, '-')}-${params.taskId}`
      : buildRotatedSessionKey(params.agentName, params.taskId, params.runNumber);

  const now = new Date().toISOString();
  run(
    `INSERT INTO openclaw_sessions
       (id, agent_id, openclaw_session_id, task_id, channel, status, session_type, total_tokens, context_tokens, run_number, rotated_from, rotation_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', 'persistent', 0, 0, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      params.agentId,
      openclawSessionId,
      params.taskId,
      'mission-control',
      params.runNumber,
      params.rotatedFrom ?? null,
      params.rotationReason ?? null,
      now,
      now,
    ]
  );

  const session = queryOne<OpenClawSession>('SELECT * FROM openclaw_sessions WHERE id = ?', [sessionId]);
  if (!session) {
    throw new Error('Failed to create agent session row');
  }
  return session;
}

/** Get the most recent session rows for a task (newest first). */
export function getTaskSessions(taskId: string): OpenClawSession[] {
  return queryAll<OpenClawSession>(
    `SELECT * FROM openclaw_sessions WHERE task_id = ? ORDER BY created_at DESC`,
    [taskId]
  );
}

/** Latest previous run's cumulative tokens for a task (A2 warning source). */
export function getPreviousRunTotalTokens(taskId: string, agentId: string, currentSessionId?: string): number | null {
  const row = queryOne<{ total_tokens: number | null }>(
    `SELECT total_tokens FROM openclaw_sessions
     WHERE task_id = ? AND agent_id = ? AND id != ?
     ORDER BY created_at DESC LIMIT 1`,
    [taskId, agentId, currentSessionId ?? '']
  );
  return row?.total_tokens ?? null;
}

// ---------------------------------------------------------------------------
// D1 — HONEST METRICS
// ---------------------------------------------------------------------------

/** Gateway model catalog entry shape (models.list). */
export interface GatewayModelInfo {
  id?: string;
  provider?: string;
  contextWindow?: number;
}

/** Build provider/model → context window map for honest ctx% denominators. */
export function buildModelWindowMap(models: GatewayModelInfo[] | null | undefined): Record<string, number> {
  const map: Record<string, number> = {};
  if (!Array.isArray(models)) return map;
  for (const m of models) {
    if (typeof m.contextWindow !== 'number' || !Number.isFinite(m.contextWindow) || m.contextWindow <= 0) continue;
    if (typeof m.id === 'string' && m.id) map[m.id.toLowerCase()] = m.contextWindow;
    if (typeof m.provider === 'string' && m.provider && typeof m.id === 'string' && m.id) {
      map[`${m.provider.toLowerCase()}/${m.id.toLowerCase()}`] = m.contextWindow;
    }
  }
  return map;
}

/**
 * Honest per-session metrics (D1): ctx% from LIVE context only; cumulative
 * totalTokens reported separately — never disguised as a percentage of the
 * window (the MRN-104 718% failure mode).
 *
 * The gateway fills `contextTokens` with the model window when no live estimate
 * is stored; pass `modelWindow` so we can detect and drop that fallback.
 */
export function enrichGatewaySessionMetrics(
  session: GatewaySessionInfo,
  modelWindow: number | null,
  liveContextOverride?: number | null
): {
  ctxPct: number | null;
  cumulativeRunPct: number | null;
  contextWindowTokens: number | null;
  liveContextTokens: number | null;
  totalTokens: number | null;
} {
  const totalTokens =
    typeof session.totalTokens === 'number' && Number.isFinite(session.totalTokens) ? session.totalTokens : null;
  const rawCtx =
    typeof session.contextTokens === 'number' && Number.isFinite(session.contextTokens) ? session.contextTokens : null;
  // The gateway falls back to the model window when no live estimate exists.
  const windowFallbackUsed = rawCtx !== null && modelWindow !== null && rawCtx === modelWindow;
  const liveContextTokens =
    typeof liveContextOverride === 'number' && Number.isFinite(liveContextOverride)
      ? liveContextOverride
      : windowFallbackUsed
        ? null
        : rawCtx;
  const contextWindowTokens = modelWindow ?? rawCtx;

  const ctxPct =
    liveContextTokens !== null && contextWindowTokens !== null && contextWindowTokens > 0
      ? Math.round((liveContextTokens / contextWindowTokens) * 100)
      : null;
  const cumulativeRunPct =
    totalTokens !== null && contextWindowTokens !== null && contextWindowTokens > 0
      ? Math.round((totalTokens / contextWindowTokens) * 100)
      : null;

  return { ctxPct, cumulativeRunPct, contextWindowTokens, liveContextTokens, totalTokens };
}

/** Session keys owned by the Mission Control pipeline (agent:role:mission-control-*). */
export function isMissionControlSessionKey(key: string | undefined | null): boolean {
  return typeof key === 'string' && key.includes(':mission-control-');
}

