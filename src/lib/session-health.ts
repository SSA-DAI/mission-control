/**
 * PLATFORM-010 — Session lifecycle, honest metrics, memory-flush guard
 * (builds on PLATFORM-008)
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
 *   3. live context estimate > contextWindow * ctxHighWaterPct / 100, or
 *   4. recent session messages contain memory-flush/sandbox/restricted markers
 *      (PLATFORM-010 A4 — the exact MRN-104 failure mode).
 */

import { queryOne, queryAll, run } from '@/lib/db';
import type { OpenClawSession } from '@/lib/types';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const SESSION_HEALTH_VERSION = 'session-health/v2';

// ── PLATFORM-010 (A4): memory-flush / sandbox marker detection ──

/**
 * Known markers that indicate a session has entered memory-flush or sandbox-
 * restricted mode (MRN-104 failure pattern). The agent's tool calls fail with
 * these messages and the session is irrecoverably damaged.
 */
export const UNHEALTHY_SESSION_MARKERS = [
  'Path escapes sandbox root',
  'Memory flush writes are restricted',
  'sandbox root',
  'Memory flush',
  'restricted',
] as const;

/**
 * Scan recent session messages (from chat.history) for memory-flush / sandbox
 * markers. Returns the first matched marker + context if found, null otherwise.
 */
export function detectSessionCorruptionMarkers(
  historyMessages: Array<{ role?: string; content?: unknown }> | null | undefined
): { marker: string; count: number; firstOccurrence: string } | null {
  if (!Array.isArray(historyMessages) || historyMessages.length === 0) return null;

  let count = 0;
  let firstMarker = '';
  let firstContext = '';

  for (const msg of historyMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const rec = msg as Record<string, unknown>;
    let contentStr = '';
    if (typeof rec.content === 'string') {
      contentStr = rec.content;
    } else if (rec.content !== undefined && rec.content !== null) {
      try {
        contentStr = JSON.stringify(rec.content);
      } catch { continue; }
    }
    if (!contentStr) continue;

    for (const marker of UNHEALTHY_SESSION_MARKERS) {
      if (contentStr.includes(marker)) {
        count++;
        if (!firstMarker) {
          firstMarker = marker;
          firstContext = contentStr.length > 200 ? contentStr.slice(0, 200) + '...' : contentStr;
        }
        break; // count once per message
      }
    }
  }

  if (count === 0) return null;
  return { marker: firstMarker, count, firstOccurrence: firstContext };
}

/** Quick-scan a single message string for corruption markers (local checks). */
export function containsUnhealthyMarker(text: string | null | undefined): boolean {
  if (!text) return false;
  return UNHEALTHY_SESSION_MARKERS.some(m => text.includes(m));
}

// ── PLATFORM-010 (D3): session file size + UI health state ──

/**
 * Estimate the session file size (bytes) from a chat.history transcript.
 * The gateway stores sessions as JSONL of serialized messages, so summing the
 * UTF-8 byte length of each message's content is an honest, cheap proxy for
 * "ukuran file sesi" without filesystem access to the gateway.
 */
export function estimateFileSizeFromHistory(history: unknown[] | null | undefined): number | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  let bytes = 0;
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const content = rec.content;
    if (typeof content === 'string') {
      bytes += Buffer.byteLength(content, 'utf8');
    } else if (content !== undefined && content !== null) {
      try {
        bytes += Buffer.byteLength(JSON.stringify(content), 'utf8');
      } catch {
        // ignore unserializable entries
      }
    }
  }
  return bytes > 0 ? bytes : null;
}

/** Persist the estimated transcript file size onto a session row (D3). */
export function recordSessionFileSize(sessionId: string, fileSizeBytes: number | null | undefined): void {
  if (typeof fileSizeBytes !== 'number' || !Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) return;
  run(
    `UPDATE openclaw_sessions SET file_size_bytes = ?, updated_at = ? WHERE id = ?`,
    [Math.floor(fileSizeBytes), new Date().toISOString(), sessionId]
  );
}

export type SessionHealthState = 'healthy' | 'degraded' | 'unhealthy';

/**
 * PLATFORM-010 (D3): derive the UI health state from a health verdict.
 *
 * - unhealthy 🔴: the session must NOT be reused (failed/blocked status, token
 *   cap exceeded, memory-flush/sandbox corruption markers, …)
 * - degraded 🟡: still usable but approaching limits — cumulative tokens > 50%
 *   of the max-total-token cap (the UI developer contract: "token rate > 50%
 *   threshold")
 * - healthy 🟢: everything nominal
 */
export function deriveSessionHealthState(
  verdict: Pick<SessionHealthVerdict, 'healthy' | 'totalTokens'>,
  config?: SessionHealthConfig
): SessionHealthState {
  const cfg = config ?? resolveSessionHealthConfig();
  if (!verdict.healthy) return 'unhealthy';
  if (verdict.totalTokens !== null && verdict.totalTokens > cfg.maxTotalTokens / 2) return 'degraded';
  return 'healthy';
}

export const DEFAULT_MAX_TOTAL_TOKENS = 1_000_000;
export const DEFAULT_CTX_HIGH_WATER_PCT = 90;

/**
 * PLATFORM-013: gateway statuses that mean a turn is STILL PROCESSING on the
 * target session (busy). In OpenClaw 2026.7 the gateway uses 'running' from
 * run start until termination; 'processing'/'queued'/'pending' cover other
 * gateway versions and queued-turn states. Reusing a session in any of these
 * states risks EmbeddedAttemptSessionTakeoverError → must rotate.
 */
export const BUSY_SESSION_STATUSES = [
  'running',
  'processing',
  'queued',
  'pending',
  'busy',
  'blocked',
] as const;

/** Gateway statuses that mean the previous run ENDED (P008: never reuse). */
export const TERMINAL_SESSION_STATUSES = [
  'done',
  'failed',
  'killed',
  'timeout',
  'stopped',
  'error',
] as const;

/**
 * Local sessions.json fallback freshness window (ms). Used ONLY when the
 * gateway poll is unavailable and the local record carries no explicit status
 * field — the local file alone cannot prove busy-ness, so we err on the safe
 * side (rotate) when the last interaction is inside this window.
 */
export const LOCAL_SESSION_BUSY_FRESHNESS_MS = 5 * 60 * 1000;

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
  /** PLATFORM-013: gateway sessions.list row includes active-turn state. */
  hasActiveRun?: boolean;
  activeRunIds?: string[];
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
  /** PLATFORM-010 A4: corruption markers detected in session messages. */
  corruptionMarker: string | null;
  corruptionCount: number;
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
  /** PLATFORM-010 A4: pre-scanned corruption marker result from session history. */
  corruptionMarkers?: ReturnType<typeof detectSessionCorruptionMarkers>;
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

  // 1b+1c. PLATFORM-013: gateway-side status semantics (OpenClaw 2026.7).
  // The gateway marks a session 'running' from the moment a run STARTS until
  // it terminates (done/failed/killed/timeout) — so 'running' is the live
  // busy signal: the previous turn is STILL PROCESSING. Reusing a session
  // while a turn is in flight throws EmbeddedAttemptSessionTakeoverError
  // (P009 live stall: VERIFY dispatched into the tester session while its
  // turn was running, task silent 15+ min). Any busy status → rotate with
  // session_busy:<status>. Terminal/non-idle statuses (done/failed/killed/…)
  // mean the previous run ENDED → never reuse (P008, unchanged). Only
  // 'active'/'idle' gateway statuses (or an absent row) keep the session
  // reusable — that is the 'idle session is reused' contract.
  const gwStatus = params.gatewayInfo?.status;
  const gwStatusNorm = typeof gwStatus === 'string' ? gwStatus.trim().toLowerCase() : '';
  if (params.gatewayInfo?.hasActiveRun === true) {
    reasons.push('session_busy:active_run');
  } else if (gwStatusNorm && (BUSY_SESSION_STATUSES as readonly string[]).includes(gwStatusNorm)) {
    reasons.push(`session_busy:${gwStatusNorm}`);
  } else if (gwStatusNorm && !['active', 'idle'].includes(gwStatusNorm)) {
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

  // 4. PLATFORM-010 A4: memory-flush / sandbox corruption markers in session.
  const corruptionMarker = params.corruptionMarkers?.marker ?? null;
  const corruptionCount = params.corruptionMarkers?.count ?? 0;
  if (corruptionMarker) {
    reasons.push(`session_corrupted:${corruptionMarker}(${corruptionCount}x)`);
  }

  return {
    healthy: reasons.length === 0,
    reasons,
    totalTokens,
    contextTokens,
    contextWindow,
    ctxPct,
    cumulativePct,
    corruptionMarker,
    corruptionCount,
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
     SET status = 'rotated', ended_at = ?, updated_at = ?, rotation_reason = ?
     WHERE id = ? AND status = 'active'`,
    [now, now, reason, sessionId]
  );
  console.info(`[SessionHealth] Marked session ${sessionId} rotated (${reason})`);
}

// ---------------------------------------------------------------------------
// PLATFORM-013 — busy-session detection & explicit rotation
// ---------------------------------------------------------------------------

/**
 * Error markers produced by the gateway when a message is sent to a session
 * whose turn is still processing (the P009 stall signature). Matched case-
 * insensitively so small casing differences across gateway versions still hit.
 */
export const BUSY_SESSION_ERROR_MARKERS = [
  'EmbeddedAttemptSessionTakeoverError',
  'session file changed while embedded prompt lock was released',
  'prompt lock was released',
  'session is busy',
  'session busy',
  'already processing',
  'turn already active',
  'another turn is active',
  'session takeover',
];

/**
 * Pure detector: does a chat.send error mean the target session is busy?
 * Unit-testable without a gateway.
 */
export function isBusySessionError(message: string | null | undefined): boolean {
  if (!message) return false;
  const hay = message.toLowerCase();
  return BUSY_SESSION_ERROR_MARKERS.some(marker => hay.includes(marker.toLowerCase()));
}

// ── PLATFORM-013: isSessionBusy — hybrid pre-reuse check ──

/** Shape of a record inside the gateway's per-agent sessions/sessions.json. */
export interface LocalSessionRecord {
  status?: string | null;
  sessionId?: string | null;
  lastInteractionAt?: number | null;
  updatedAt?: number | null;
  sessionStartedAt?: number | null;
}

export interface SessionBusyResult {
  /** true → the target session must NOT be reused (rotate instead). */
  busy: boolean;
  /** e.g. 'busy_session:running' (gateway/local status) or 'busy_session:active_run'. */
  reason?: string;
  /** observed gateway/local status (null when unknown). */
  status?: string | null;
  /** where the decision came from: local sessions.json, gateway poll, or none. */
  source: 'sessions.json' | 'gateway' | 'none';
}

/**
 * Parse a gateway sessions.json file (per-agent: OPENCLAW_HOME/agents/<id>/sessions/sessions.json).
 * Returns null when the file is missing/unreadable/unparsable — callers then
 * fall through to the gateway poll (or the safe-side default).
 */
export function readLocalSessionsFile(
  filePath: string | null | undefined
): Record<string, LocalSessionRecord> | null {
  if (!filePath) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, LocalSessionRecord>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the per-agent gateway sessions.json path.
 *
 * Priority: explicit OPENCLAW_AGENTS_DIR override → OPENCLAW_HOME/.openclaw/
 * agents/<gatewayAgentId>/sessions/sessions.json → ~/.openclaw/... When
 * Mission Control runs in a different container than the gateway (no
 * filesystem access), this returns a path that simply won't exist —
 * readLocalSessionsFile returns null and the gateway poll is used instead.
 */
export function resolveLocalSessionsPath(
  gatewayAgentId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (!gatewayAgentId) return null;
  const safeId = gatewayAgentId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;
  const rel = path.join('agents', safeId, 'sessions', 'sessions.json');
  const explicit = env.OPENCLAW_AGENTS_DIR;
  if (explicit) return path.join(explicit, safeId, 'sessions', 'sessions.json');
  const home = env.OPENCLAW_HOME || os.homedir();
  const underDotOpenclaw = path.join(home, '.openclaw', rel);
  if (fs.existsSync(underDotOpenclaw)) return underDotOpenclaw;
  const bare = path.join(home, rel);
  return fs.existsSync(bare) ? bare : underDotOpenclaw;
}

/**
 * PLATFORM-013: pre-reuse busy check — hybrid detection.
 *
 * 1. Local sessions.json fast path: a record with an explicit `status` field
 *    decides by status alone (busy iff status ∈ BUSY_SESSION_STATUSES).
 * 2. If the local record has no status field (OpenClaw 2026.7 sessions.json
 *    stores no status), fall through to the gateway sessions.list rows.
 * 3. Gateway path (authoritative): busy iff hasActiveRun === true or status ∈
 *    BUSY_SESSION_STATUSES. Terminal statuses (done/failed/…) are NOT busy —
 *    P008 rotation handles them separately.
 * 4. Safe side when the gateway is unreachable AND no status is available
 *    locally: a record with lastInteractionAt inside the freshness window is
 *    treated as busy (rotating is cheaper than a takeover-error stall).
 *
 * Status-only threshold per planning decision: no timestamp heuristics are
 * used when a status is available — timestamps only back the unreachable-
 * gateway fallback.
 */
export function isSessionBusy(params: {
  /** gateway session key to check (e.g. agent:tester:mission-control-…). */
  sessionKey: string;
  /** pre-fetched gateway sessions.list rows (null/undefined = poll unavailable). */
  gatewaySessions?: GatewaySessionInfo[] | null;
  /** parsed sessions.json (fast path). Takes precedence over localSessionsPath. */
  localSessions?: Record<string, LocalSessionRecord> | null;
  /** sessions.json path to read when localSessions is not provided. */
  localSessionsPath?: string | null;
  /** fallback freshness window for the unreachable-gateway case. */
  freshnessMs?: number;
  /** injectable clock for tests. */
  now?: number;
}): SessionBusyResult {
  const now = params.now ?? Date.now();
  const freshnessMs = params.freshnessMs ?? LOCAL_SESSION_BUSY_FRESHNESS_MS;
  const local =
    params.localSessions ??
    (params.localSessionsPath ? readLocalSessionsFile(params.localSessionsPath) : null);
  const localRecord = local?.[params.sessionKey] ?? null;

  const statusDecision = (status: string | null | undefined, source: SessionBusyResult['source']): SessionBusyResult | null => {
    if (!status) return null;
    const norm = status.trim().toLowerCase();
    if ((BUSY_SESSION_STATUSES as readonly string[]).includes(norm)) {
      return { busy: true, reason: `busy_session:${norm}`, status: norm, source };
    }
    return { busy: false, status: norm, source };
  };

  // 1. Local fast path — only when the record carries an explicit status.
  if (localRecord && typeof localRecord.status === 'string' && localRecord.status.trim()) {
    const decided = statusDecision(localRecord.status, 'sessions.json');
    if (decided) return decided;
  }

  // 2+3. Gateway path (authoritative busy signal).
  // Match by key, by bare sessionId, or by the local record's sessionId
  // (handles key-spelling drift between the local store and the poll). The
  // sessionId clauses must only fire when a real id exists — undefined ===
  // undefined would match the first row for every key.
  const matchLocalSessionId = localRecord?.sessionId
    ? (g: GatewaySessionInfo) => g.sessionId === localRecord.sessionId
    : null;
  const gatewayRow = params.gatewaySessions
    ? (params.gatewaySessions.find(
        g =>
          g.key === params.sessionKey ||
          (g.sessionId != null && g.sessionId === params.sessionKey) ||
          (matchLocalSessionId ? matchLocalSessionId(g) : false)
      ) ?? null)
    : null;
  if (gatewayRow) {
    if (gatewayRow.hasActiveRun === true) {
      return { busy: true, reason: 'busy_session:active_run', status: gatewayRow.status ?? 'running', source: 'gateway' };
    }
    const decided = statusDecision(gatewayRow.status, 'gateway');
    if (decided) return decided;
    // Terminal/unknown status on a known gateway row → not busy (P008 handles).
    return { busy: false, status: gatewayRow.status ?? null, source: 'gateway' };
  }

  // 4. Gateway unreachable + no local status → safe side: recent local
  // interaction is treated as busy (avoid the takeover-error stall).
  if (localRecord) {
    const lastAt = localRecord.lastInteractionAt ?? localRecord.updatedAt ?? null;
    if (typeof lastAt === 'number' && Number.isFinite(lastAt) && now - lastAt < freshnessMs) {
      return { busy: true, reason: 'busy_session:recent_interaction', source: 'sessions.json' };
    }
    return { busy: false, status: localRecord.status ?? null, source: 'sessions.json' };
  }

  return { busy: false, status: null, source: 'none' };
}

/**
 * Rotation-reason label for activity/event metadata. Busy-triggered rotations
 * surface as `busy_session` (spec); everything else uses the first reason.
 */
export function rotationReasonLabel(reasons: string[] | null | undefined): string {
  if (!Array.isArray(reasons) || reasons.length === 0) return 'unhealthy';
  if (reasons.some(r => r.startsWith('session_busy'))) return 'busy_session';
  return reasons[0];
}

/**
 * Explicitly rotate (agent, task) to a fresh session key after a busy/takeover
 * failure or any caller-side rotation trigger. Marks the previous row rotated
 * and creates the next run row — the same semantics resolveDispatchSession
 * uses for unhealthy sessions, exposed for post-send auto-recovery.
 */
export function rotateToFreshSession(params: {
  taskId: string;
  agentId: string;
  agentName: string;
  previousSession: OpenClawSession;
  reason: string;
}): { session: OpenClawSession; runNumber: number } {
  const nextRun = (params.previousSession.run_number ?? 1) + 1;
  markSessionRotated(params.previousSession.id, params.reason);
  const session = createDispatchSessionRow({
    taskId: params.taskId,
    agentId: params.agentId,
    agentName: params.agentName,
    runNumber: nextRun,
    rotatedFrom: params.previousSession.id,
    rotationReason: params.reason,
  });
  return { session, runNumber: nextRun };
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
  /** PLATFORM-010 A4: pre-scanned corruption markers keyed by sessionKey */
  corruptionMarkersBySession?: Record<string, ReturnType<typeof detectSessionCorruptionMarkers>>;
  /** model context window for the session's model (fallback detection) */
  contextWindow?: number | null;
  /** existing active DB session for (agent, task); caller may pass null to force create */
  existingSession?: OpenClawSession | null;
  /** prefix used to build the gateway session key (e.g. agent:builder:) */
  sessionKeyPrefix: string;
  /** PLATFORM-013: pre-reuse busy check result (isSessionBusy). When busy,
   *  the session is treated as unhealthy and rotated even if every other
   *  health signal is nominal. */
  busyOverride?: SessionBusyResult | null;
  /** env config override (tests) */
  config?: SessionHealthConfig;
}

/**
 * Core dispatch decision (A1): reuse the existing session only when it is
 * healthy; otherwise rotate to a NEW session key. Healthy sessions are never
 * churned. Returns the resolved session plus rotation diagnostics.
 *
 * KESULTANAN-FIX-002: this helper is now a thin wrapper over
 * `planDispatchSession` + `commitRotationPlan` so callers that need to abort
 * the OLD gateway turn before creating the new session (abort→verify→create)
 * can use the two-step flow instead of this atomic one.
 */
export function resolveDispatchSession(params: ResolveDispatchSessionParams): DispatchSessionResolution {
  const planned = planDispatchSession(params);
  const session = commitRotationPlan(planned);
  return {
    session,
    rotated: planned.rotationReasons.length > 0,
    rotationReasons: planned.rotationReasons,
    verdict: planned.verdict,
    reusedExistingSession: planned.action === 'reuse',
    runNumber: planned.runNumber,
  };
}

export interface DispatchSessionPlan {
  action: 'create' | 'reuse' | 'rotate';
  taskId: string;
  agentId: string;
  agentName: string;
  /** existing session (reuse) — set when action === 'reuse'. */
  session?: OpenClawSession;
  /** previous session to mark rotated (rotate) — set when action === 'rotate'. */
  previousSession?: OpenClawSession;
  /** next run number for the NEW session row. */
  runNumber: number;
  /** reasons that triggered rotation (empty for create/reuse). */
  rotationReasons: string[];
  /** health verdict of the pre-existing session (null when none existed). */
  verdict: SessionHealthVerdict | null;
  /** gateway key of the session that MUST be idle before a new session is
   *  created (rotate: the old key; create: the new key; reuse: the existing
   *  key). Callers abort+verify this key before committing a rotation. */
  gatewayKey: string;
}

/**
 * KESULTANAN-FIX-002: pure rotation DECISION (no DB writes). Returns the
 * plan; callers run abort→verify on `gatewayKey` when the plan says 'rotate',
 * then commit with `commitRotationPlan`. Splitting decision from commit lets
 * the busy-session rotation block (fail) when the old gateway turn cannot be
 * aborted/confirmed idle — the root cause of the MRN-106 double-builder.
 */
export function planDispatchSession(params: ResolveDispatchSessionParams): DispatchSessionPlan {
  const config = params.config ?? resolveSessionHealthConfig();
  const { taskId, agentId, agentName, sessionKeyPrefix } = params;

  const runNumber = params.existingSession?.run_number ?? 1;

  if (!params.existingSession) {
    // No previous session — create the first run.
    const openclawSessionId = `mission-control-${agentName.toLowerCase().replace(/\s+/g, '-')}-${taskId}`;
    return {
      action: 'create',
      taskId,
      agentId,
      agentName,
      runNumber: 1,
      rotationReasons: [],
      verdict: null,
      gatewayKey: `${sessionKeyPrefix}${openclawSessionId}`,
    };
  }

  const existingKey = `${sessionKeyPrefix}${params.existingSession.openclaw_session_id}`;
  const gatewayInfo =
    params.gatewaySessions?.find(g => g.key === existingKey || g.sessionId === params.existingSession?.openclaw_session_id) ?? null;
  const estimatedContextTokens = params.contextEstimates?.[existingKey] ?? null;
  const corruptionMarkers = params.corruptionMarkersBySession?.[existingKey] ?? null;

  const verdict = evaluateSessionHealth({
    dbSession: params.existingSession,
    gatewayInfo,
    estimatedContextTokens,
    contextWindow: params.contextWindow ?? null,
    config,
    corruptionMarkers,
  });

  // PLATFORM-013: a busy pre-reuse check overrides the verdict — a session
  // whose turn is still processing must rotate even when DB row + token
  // counters look healthy (P009 takeover-error stall).
  const effectiveVerdict: SessionHealthVerdict = params.busyOverride?.busy
    ? {
        ...verdict,
        healthy: false,
        reasons: [...verdict.reasons, params.busyOverride.reason ?? 'session_busy:unknown'],
      }
    : verdict;

  if (effectiveVerdict.healthy) {
    // Healthy → reuse, no churn.
    return {
      action: 'reuse',
      taskId,
      agentId,
      agentName,
      session: params.existingSession,
      runNumber,
      rotationReasons: [],
      verdict: effectiveVerdict,
      gatewayKey: existingKey,
    };
  }

  // Unhealthy → rotate to a NEW session key (never reuse bloated/failed/busy sessions).
  return {
    action: 'rotate',
    taskId,
    agentId,
    agentName,
    previousSession: params.existingSession,
    runNumber: runNumber + 1,
    rotationReasons: effectiveVerdict.reasons,
    verdict: effectiveVerdict,
    gatewayKey: existingKey,
  };
}

/**
 * KESULTANAN-FIX-002: commit a rotation plan to the DB (mark previous
 * rotated + create the next run row). Only call AFTER the old gateway turn is
 * confirmed idle (abort→verify→create contract).
 */
export function commitRotationPlan(plan: DispatchSessionPlan): OpenClawSession {
  if (plan.action === 'create') {
    return createDispatchSessionRow({
      taskId: plan.taskId,
      agentId: plan.agentId,
      agentName: plan.agentName,
      runNumber: 1,
    });
  }
  if (plan.action === 'reuse') {
    return plan.session!;
  }
  // rotate
  const reason = plan.rotationReasons.join('; ');
  markSessionRotated(plan.previousSession!.id, reason);
  return createDispatchSessionRow({
    taskId: plan.taskId,
    agentId: plan.agentId,
    agentName: plan.agentName,
    runNumber: plan.runNumber,
    rotatedFrom: plan.previousSession!.id,
    rotationReason: reason,
  });
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

