// KESULTANAN-FIX-002 — gateway-level abort + idle verification for rotation.
//
// Root cause (MRN-106 double-builder): P013 busy-session rotation only marked
// the old run "rotated" in the MC DB; the gateway session KEPT RUNNING, so the
// old turn and the new run worked the same task in parallel (EADDRINUSE,
// repo write conflicts). This module gives rotation a gateway-level
// abort→verify→create contract:
//
//   1. abort  — stop the old turn (chat.abort) via the internal abort endpoint
//               (least-privilege, dedicated secret) or the WS RPC fallback;
//   2. verify — poll sessions.list until the old key shows no active run and
//               no busy status (timeout-bounded);
//   3. create — only after (1)+(2) succeed may the new session row be created.
//
// If abort or verification fails/times out, rotation MUST be blocked (no new
// session) so the invariant "never two active sessions for the same task"
// holds even at the cost of failover speed.

import type { GatewaySessionInfo } from './session-health';
import type { OpenClawSession } from './types';
import { commitRotationPlan, type DispatchSessionPlan } from './session-health';

export const GATEWAY_ABORT_TIMEOUT_MS_DEFAULT = 20_000;
export const GATEWAY_ABORT_POLL_MS_DEFAULT = 1_000;

/** Minimal OpenClaw gateway client surface this module needs (test-injectable). */
export interface GatewayClientLike {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  listSessions(): Promise<GatewaySessionInfo[]>;
}

export type AbortTransport = 'endpoint' | 'ws' | 'none';

export interface AbortGatewayTurnResult {
  ok: boolean;
  aborted: boolean;
  runIds: string[];
  transport: AbortTransport;
  error?: string;
}

export interface SessionIdleResult {
  idle: boolean;
  status: string | null;
  hasActiveRun: boolean;
  row: GatewaySessionInfo | null;
  /** Set when sessions.list could not be polled (gateway unreachable). */
  error?: string;
}

export interface AbortAndVerifyResult {
  ok: boolean;
  aborted: boolean;
  runIds: string[];
  verifiedIdle: boolean;
  /** Final observed status (null when the row vanished / unknown). */
  status: string | null;
  transport: AbortTransport;
  timeoutMs: number;
  /** Set when the transport itself failed (gateway unreachable, 401/403, …). */
  error?: string;
  /** Set when verification timed out with a still-busy session. */
  timedOut?: boolean;
  /**
   * GLOBAL ODE STALL REMEDIATION (2026-09-18): last gateway row observed during
   * idle verification (null when the row vanished / nothing was running). Used
   * by the zombie escalation to prove a contradictory active-run flag.
   */
  row?: GatewaySessionInfo | null;
}

export interface WaitForSessionIdleParams {
  client: GatewayClientLike;
  /** Gateway session key to watch (e.g. agent:builder:mission-control-…). */
  sessionKey: string;
  /** Optional bare sessionId fallback match (key-spelling drift). */
  sessionId?: string | null;
  timeoutMs?: number;
  verifyIntervalMs?: number;
  /** injectable clock + row source for tests. */
  now?: () => number;
  listSessionsOverride?: () => Promise<GatewaySessionInfo[]>;
}

export interface AbortGatewayTurnParams {
  client: GatewayClientLike;
  sessionKey: string;
  runId?: string | null;
  /** Force the WS RPC transport even when the internal endpoint is configured. */
  forceWs?: boolean;
  /** Abort via the internal endpoint when the secret is configured. */
  endpointUrl?: string | null;
  endpointSecret?: string | null;
  /** injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface AbortAndVerifyParams extends AbortGatewayTurnParams {
  timeoutMs?: number;
  verifyIntervalMs?: number;
  sessionId?: string | null;
  now?: () => number;
  listSessionsOverride?: () => Promise<GatewaySessionInfo[]>;
}

// ---------------------------------------------------------------------------
// Internal abort endpoint (least-privilege gateway surface)
// ---------------------------------------------------------------------------

/**
 * Resolve the internal abort endpoint URL.
 * Priority: explicit GATEWAY_ABORT_URL → derived from OPENCLAW_GATEWAY_URL
 * (ws://host:port → http://host:port/api/v1/internal/abort) → null.
 */
export function resolveInternalAbortUrl(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const explicit = env.GATEWAY_ABORT_URL;
  if (explicit) return explicit;
  const gatewayUrl = env.OPENCLAW_GATEWAY_URL;
  if (!gatewayUrl) return null;
  try {
    const u = new URL(gatewayUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/api/v1/internal/abort';
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Call the gateway's internal abort endpoint (POST /api/v1/internal/abort).
 * The endpoint requires BOTH the gateway bearer token (route auth) and the
 * dedicated internal-abort secret header; the session key is validated
 * server-side to mission-control-managed keys only.
 */
export async function callInternalAbortEndpoint(params: {
  sessionKey: string;
  runId?: string | null;
  endpointUrl: string;
  gatewayToken?: string;
  endpointSecret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<AbortGatewayTurnResult> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const timeoutMs = params.timeoutMs ?? 10_000;
  if (!params.endpointSecret) {
    return {
      ok: false,
      aborted: false,
      runIds: [],
      transport: 'endpoint',
      error: 'internal abort endpoint secret not configured',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(params.endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(params.gatewayToken ? { Authorization: `Bearer ${params.gatewayToken}` } : {}),
        'x-openclaw-internal-abort-secret': params.endpointSecret,
      },
      body: JSON.stringify({
        sessionKey: params.sessionKey,
        ...(params.runId ? { runId: params.runId } : {}),
      }),
      signal: controller.signal,
    });
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    const record = (payload ?? {}) as Record<string, unknown>;
    if (!res.ok) {
      const message =
        typeof record.error === 'object' && record.error !== null
          ? String((record.error as Record<string, unknown>).message ?? JSON.stringify(record.error))
          : String(record.message ?? `HTTP ${res.status}`);
      return {
        ok: false,
        aborted: false,
        runIds: [],
        transport: 'endpoint',
        error: `internal abort endpoint failed: ${message}`,
      };
    }
    return {
      ok: record.ok === true,
      aborted: record.aborted === true,
      runIds: Array.isArray(record.runIds) ? (record.runIds as string[]) : [],
      transport: 'endpoint',
      ...(record.ok === false
        ? { error: String(record.message ?? 'internal abort endpoint rejected the request') }
        : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      aborted: false,
      runIds: [],
      transport: 'endpoint',
      error: `internal abort endpoint unreachable: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Abort transport
// ---------------------------------------------------------------------------

/**
 * Abort a gateway turn for a session key.
 *
 * Transport selection: the internal endpoint (dedicated secret) is preferred
 * when configured (per planning: least-privilege internal path, no reliance on
 * broad operator.admin over WS); otherwise falls back to the WS RPC
 * chat.abort (the token-backed connection in practice carries operator scopes,
 * and chat.abort is scope-operator.write at the method level).
 */
export async function abortGatewayTurn(params: AbortGatewayTurnParams): Promise<AbortGatewayTurnResult> {
  const endpointUrl = params.endpointUrl ?? resolveInternalAbortUrl();
  const endpointSecret = params.endpointSecret ?? process.env.GATEWAY_ABORT_SECRET ?? '';
  if (!params.forceWs && endpointUrl && endpointSecret) {
    const result = await callInternalAbortEndpoint({
      sessionKey: params.sessionKey,
      runId: params.runId ?? null,
      endpointUrl,
      gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || '',
      endpointSecret,
      fetchImpl: params.fetchImpl,
    });
    if (result.ok) return result;
    // Endpoint failure (unreachable, rejected) → do NOT silently fall through
    // to WS when the endpoint is configured: a rejected abort is a security
    // signal. The caller decides (block rotation) based on this error.
    return result;
  }
  // WS RPC transport.
  try {
    const payload = (await params.client.call('chat.abort', {
      sessionKey: params.sessionKey,
      ...(params.runId ? { runId: params.runId } : {}),
    })) as { ok?: boolean; aborted?: boolean; runIds?: string[] };
    return {
      ok: payload?.ok === true,
      aborted: payload?.aborted === true,
      runIds: Array.isArray(payload?.runIds) ? payload.runIds : [],
      transport: 'ws',
      ...(payload?.ok === false ? { error: 'gateway chat.abort rejected the request' } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, aborted: false, runIds: [], transport: 'ws', error: message };
  }
}

// ---------------------------------------------------------------------------
// Idle verification
// ---------------------------------------------------------------------------

/** Normalize a gateway status for busy comparison. */
function normalizeStatus(status: string | null | undefined): string | null {
  if (!status) return null;
  const norm = status.trim().toLowerCase();
  return norm.length > 0 ? norm : null;
}

/** Busy statuses that mean a turn is still processing (mirrors session-health). */
export const ABORT_BUSY_STATUSES: readonly string[] = [
  'running',
  'processing',
  'queued',
  'pending',
  'busy',
  'blocked',
];

function isBusyStatus(status: string | null | undefined): boolean {
  const norm = normalizeStatus(status);
  return norm !== null && (ABORT_BUSY_STATUSES as readonly string[]).includes(norm);
}

function findGatewayRow(
  rows: GatewaySessionInfo[],
  sessionKey: string,
  sessionId?: string | null
): GatewaySessionInfo | null {
  const key = sessionKey;
  return (
    rows.find(
      g =>
        g.key === key ||
        (sessionId != null && g.sessionId === sessionId) ||
        (g.sessionId != null && g.sessionId === key)
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Zombie active-run detection + force clear (GLOBAL ODE STALL REMEDIATION)
// ---------------------------------------------------------------------------

/**
 * GLOBAL ODE STALL REMEDIATION (2026-09-18): detect a ZOMBIE active-run flag.
 *
 * Observed on the ODE pipeline (2026-09-17): an embedded attempt aborted
 * mid-turn leaves the gateway session reporting `hasActiveRun: true` together
 * with a NON-busy status (`idle`). A real in-flight turn always reports
 * running/processing/queued, so `hasActiveRun === true` + non-busy status is
 * a contradiction — the run flag is stale and no work is happening.
 *
 * The zombie blocked rotation forever: chat.abort was accepted but the idle
 * verification kept seeing hasActiveRun, so dispatch returned 503 and the task
 * could never be re-dispatched (even manually).
 *
 * Conservative on purpose: an unknown/absent status is NOT treated as a
 * zombie, so a genuinely running turn is never force-cleared.
 */
export function isZombieActiveRun(row: GatewaySessionInfo | null | undefined): boolean {
  if (!row) return false;
  if (row.hasActiveRun !== true) return false;
  const status = normalizeStatus(row.status ?? null);
  if (status === null) return false;
  return !isBusyStatus(status);
}

export type ForceClearMethod = 'sessions.delete' | 'sessions.reset';

export interface ForceClearAttempt {
  method: ForceClearMethod;
  ok: boolean;
  error?: string;
}

export interface ForceClearResult {
  ok: boolean;
  /** Method that succeeded, or null when every method failed. */
  method: ForceClearMethod | null;
  attempts: ForceClearAttempt[];
}

/**
 * GLOBAL ODE STALL REMEDIATION (2026-09-18): clear a zombie gateway session.
 *
 * Escalation used only after chat.abort + idle verification failed AND the row
 * was proven contradictory (see isZombieActiveRun). `sessions.delete` removes
 * the key outright (the idle probe then reports "row absent" = idle);
 * `sessions.reset` is the fallback when delete is unavailable/unauthorized.
 *
 * Fail-closed: when no method succeeds the caller keeps rotation blocked.
 */
export async function forceClearGatewaySession(params: {
  client: GatewayClientLike;
  sessionKey: string;
}): Promise<ForceClearResult> {
  const attempts: ForceClearAttempt[] = [];
  const methods: ForceClearMethod[] = ['sessions.delete', 'sessions.reset'];
  for (const method of methods) {
    try {
      await params.client.call(method, { key: params.sessionKey });
      attempts.push({ method, ok: true });
      return { ok: true, method, attempts };
    } catch (err) {
      attempts.push({ method, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: false, method: null, attempts };
}

/**
 * Poll sessions.list until the target session shows no active run and no busy
 * status. A missing row counts as idle (nothing is running for that key).
 */
export async function waitForSessionIdle(
  params: WaitForSessionIdleParams
): Promise<SessionIdleResult> {
  const timeoutMs = params.timeoutMs ?? GATEWAY_ABORT_TIMEOUT_MS_DEFAULT;
  const intervalMs = params.verifyIntervalMs ?? GATEWAY_ABORT_POLL_MS_DEFAULT;
  const now = params.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const listRows =
    params.listSessionsOverride ??
    (async () => {
      try {
        return await params.client.listSessions();
      } catch {
        return null as unknown as GatewaySessionInfo[];
      }
    });

  let row: GatewaySessionInfo | null = null;
  let status: string | null = null;
  let hasActiveRun = false;
  let lastError: unknown = null;
  // Defense-in-depth: cap total polls so a non-advancing injected clock (or a
  // stuck listSessions) can never turn this into an infinite loop.
  const maxPolls = Math.max(2, Math.ceil(timeoutMs / Math.max(1, intervalMs)) + 2);
  let polls = 0;

  for (;;) {
    polls += 1;
    let rows: GatewaySessionInfo[] | null = null;
    try {
      rows = await listRows();
    } catch (err) {
      lastError = err;
      rows = null;
    }
    if (Array.isArray(rows)) {
      row = findGatewayRow(rows, params.sessionKey, params.sessionId);
      hasActiveRun = row?.hasActiveRun === true;
      status = normalizeStatus(row?.status ?? null);
      if (!row) {
        // Row absent → nothing running under that key → idle.
        return { idle: true, status: null, hasActiveRun: false, row: null };
      }
      if (!hasActiveRun && !isBusyStatus(status)) {
        return { idle: true, status, hasActiveRun: false, row };
      }
    }
    if (now() >= deadline || polls >= maxPolls) {
      return {
        idle: false,
        status,
        hasActiveRun,
        row,
        ...(lastError ? { error: `sessions.list failed during idle verification: ${String(lastError)}` } : {}),
      };
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Combined abort → verify
// ---------------------------------------------------------------------------

/**
 * Abort the old turn and verify the session reached idle. This is the
 * gateway-level half of the rotation contract; the caller (dispatch) must
 * only create the new session row after this returns ok.
 */
export async function abortAndVerifySessionIdle(
  params: AbortAndVerifyParams
): Promise<AbortAndVerifyResult> {
  const timeoutMs = params.timeoutMs ?? GATEWAY_ABORT_TIMEOUT_MS_DEFAULT;
  const abortResult = await abortGatewayTurn(params);
  if (!abortResult.ok) {
    return {
      ok: false,
      aborted: false,
      runIds: [],
      verifiedIdle: false,
      status: null,
      transport: abortResult.transport,
      timeoutMs,
      error: abortResult.error ?? 'abort failed',
    };
  }
  const idle = await waitForSessionIdle({
    client: params.client,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    timeoutMs,
    verifyIntervalMs: params.verifyIntervalMs,
    now: params.now,
    listSessionsOverride: params.listSessionsOverride,
  });
  return {
    ok: idle.idle,
    aborted: abortResult.aborted,
    runIds: abortResult.runIds,
    verifiedIdle: idle.idle,
    status: idle.status,
    transport: abortResult.transport,
    timeoutMs,
    row: idle.row,
    ...(idle.idle
      ? {}
      : {
          timedOut: true,
          error:
            idle.error ??
            `session still busy after ${timeoutMs}ms abort wait (status=${idle.status ?? 'unknown'})`,
        }),
  };
}

// ---------------------------------------------------------------------------
// Rotation orchestration (abort → verify → create)
// ---------------------------------------------------------------------------

/**
 * KESULTANAN-FIX-002: full abort→verify→create rotation. Takes the rotation
 * plan produced by `planDispatchSession`, aborts + verifies the OLD gateway
 * turn, then commits the new session row — or BLOCKS (returns blocked=true,
 * no DB writes) when the abort cannot be confirmed. Callers must surface the
 * blocked outcome (503 + no new session) to preserve the invariant that no
 * two sessions are ever active for the same task.
 */
export async function rotateDispatchSessionWithAbort(params: {
  plan: DispatchSessionPlan;
  client: GatewayClientLike;
  oldSessionId?: string | null;
  timeoutMs?: number;
  verifyIntervalMs?: number;
  forceBlockOnFailure?: boolean;
  /** Force the WS RPC transport even when the internal endpoint is configured (tests). */
  forceWs?: boolean;
  /** observed old gateway row from the pre-rotation sessions.list poll. */
  oldRow?: GatewaySessionInfo | null;
  now?: () => number;
  /**
   * GLOBAL ODE STALL REMEDIATION (2026-09-18): allow the zombie self-heal
   * escalation (force-clear + re-verify) when abort/verify could not confirm
   * idle. Defaults to true; tests may disable it. Set false to restore the
   * strict pre-fix behaviour (always block).
   */
  allowZombieForceClear?: boolean;
  /** Idle re-verification budget after a successful force-clear. Default 5s. */
  zombieRecheckTimeoutMs?: number;
}): Promise<{
  session: OpenClawSession | null;
  abortResult: AbortAndVerifyResult | null;
  blocked: boolean;
  blockedReason: string | null;
  /** GLOBAL ODE STALL REMEDIATION: set when the zombie escalation ran. */
  zombieDetected?: boolean;
  forcedClear?: ForceClearResult | null;
}> {
  if (params.plan.action !== 'rotate') {
    // create / reuse — nothing to abort.
    return {
      session: commitRotationPlan(params.plan),
      abortResult: null,
      blocked: false,
      blockedReason: null,
    };
  }
  const abortResult = await abortAndVerifySessionIdle({
    client: params.client,
    sessionKey: params.plan.gatewayKey,
    sessionId: params.oldSessionId ?? null,
    timeoutMs: params.timeoutMs,
    verifyIntervalMs: params.verifyIntervalMs,
    forceWs: params.forceWs,
    now: params.now,
  });
  const guard = rotationAbortGuard({
    reasons: params.plan.rotationReasons,
    gatewayKey: params.plan.gatewayKey,
    abortResult,
    oldRow: params.oldRow,
    forceBlockOnFailure: params.forceBlockOnFailure,
  });

  // GLOBAL ODE STALL REMEDIATION (2026-09-18): zombie self-heal.
  //
  // abort → verify failed, so rotation would be blocked and the task would
  // park forever. If the observed gateway row is CONTRADICTORY (active run
  // flag + non-busy status) it is a zombie: no work is happening, only a stale
  // flag is holding the key. Clear the key, re-verify idle, then rotate.
  // The no-overlap invariant still holds: the key is gone before the new
  // session is created. Any doubt (unknown status, clear failed, still busy)
  // keeps the original block.
  let proceed = guard.proceed;
  let blockedReason = guard.blockedReason;
  let zombieDetected = false;
  let forcedClear: ForceClearResult | null = null;
  if (!proceed && params.allowZombieForceClear !== false) {
    zombieDetected =
      isZombieActiveRun(abortResult.row) || isZombieActiveRun(params.oldRow ?? null);
    if (zombieDetected) {
      forcedClear = await forceClearGatewaySession({
        client: params.client,
        sessionKey: params.plan.gatewayKey,
      });
      if (forcedClear.ok) {
        const recheck = await waitForSessionIdle({
          client: params.client,
          sessionKey: params.plan.gatewayKey,
          sessionId: params.oldSessionId ?? null,
          timeoutMs: params.zombieRecheckTimeoutMs ?? 5_000,
          verifyIntervalMs: params.verifyIntervalMs,
          now: params.now,
        });
        if (recheck.idle) {
          proceed = true;
          blockedReason = null;
        } else {
          blockedReason = `${guard.blockedReason ?? 'rotation blocked'} — zombie force-clear (${forcedClear.method}) did not verify idle (status=${recheck.status ?? 'unknown'})`;
        }
      } else {
        blockedReason = `${guard.blockedReason ?? 'rotation blocked'} — zombie force-clear failed (${forcedClear.attempts
          .map(a => `${a.method}:${a.error ?? 'ok'}`)
          .join(', ')})`;
      }
    }
  }

  if (!proceed) {
    return {
      session: null,
      abortResult,
      blocked: true,
      blockedReason,
      zombieDetected,
      forcedClear,
    };
  }
  // abort → verify OK (directly or after zombie force-clear) → create the
  // fresh session row.
  return {
    session: commitRotationPlan(params.plan),
    abortResult,
    blocked: false,
    blockedReason: null,
    zombieDetected,
    forcedClear,
  };
}

// ---------------------------------------------------------------------------
// Rotation decision guard (pure)
// ---------------------------------------------------------------------------

/**
 * Gateway-level guard used by dispatch before rotating away from a session
 * that may still be running. Returns the abort/verify verdict plus a flag
 * whether rotation is SAFE to proceed.
 *
 * Rotation is BLOCKED (proceed=false) when:
 *  - the reason is a busy_session rotation AND abort/verify failed or timed
 *    out (invariant: never two active sessions for the same task); or
 *  - the old gateway row showed an active run AND it could not be confirmed
 *    idle.
 *
 * For non-busy rotations with no active run on the old key, a failed probe
 * only warns (proceed=true) so availability is not degraded by a gateway
 * hiccup — there is no running turn to double with.
 */
export function rotationAbortGuard(params: {
  /** rotation reasons that triggered the rotation (session_busy:* = busy). */
  reasons: string[];
  /** old gateway session key (may be null when no previous gateway session). */
  gatewayKey: string | null;
  abortResult: AbortAndVerifyResult | null;
  /** observed old gateway row (from the pre-rotation sessions.list poll). */
  oldRow?: GatewaySessionInfo | null;
  forceBlockOnFailure?: boolean;
}): { proceed: boolean; blockedReason: string | null } {
  const busyRotation = (params.reasons ?? []).some(r => r.startsWith('session_busy'));
  const oldHadActiveRun = params.oldRow?.hasActiveRun === true;

  if (!params.gatewayKey) return { proceed: true, blockedReason: null };
  if (params.forceBlockOnFailure) {
    return params.abortResult && params.abortResult.ok
      ? { proceed: true, blockedReason: null }
      : {
          proceed: false,
          blockedReason:
            params.abortResult?.error ??
            'previous gateway session could not be confirmed idle before rotation',
        };
  }
  if (busyRotation || oldHadActiveRun) {
    return params.abortResult && params.abortResult.ok
      ? { proceed: true, blockedReason: null }
      : {
          proceed: false,
          blockedReason:
            params.abortResult?.error ??
            `previous gateway session still busy (${params.abortResult?.status ?? 'unknown'}); abort failed or timed out — rotation blocked to prevent double execution`,
        };
  }
  return { proceed: true, blockedReason: null };
}
