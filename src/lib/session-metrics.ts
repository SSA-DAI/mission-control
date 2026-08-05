/**
 * PLATFORM-008 (D1) — honest session metrics for the sessions list / UI.
 *
 * Splits "context hidup" (live context tokens / model window) from "kumulatif
 * run" (cumulative totalTokens). The gateway's `sessions.list` fills
 * `contextTokens` with the model window when no live estimate is stored — we
 * detect that fallback (raw == window) and, for Mission Control pipeline
 * sessions, estimate live context from a bounded transcript tail
 * (`chat.history`) instead. Cumulative totals are reported as a separate
 * number, never disguised as a context percentage.
 */

import { getOpenClawClient } from '@/lib/openclaw/client';
import {
  buildModelWindowMap,
  enrichGatewaySessionMetrics,
  estimateLiveContextFromHistory,
  isMissionControlSessionKey,
  type GatewayModelInfo,
  type GatewaySessionInfo,
} from '@/lib/session-health';

/** Cap transcript-tail fetches per list call (perf guard, D1 fallback). */
export const MAX_TRANSCRIPT_TAIL_FETCHES = 10;

export interface EnrichedGatewaySession extends GatewaySessionInfo {
  ctxPct: number | null;
  cumulativeRunPct: number | null;
  contextWindowTokens: number | null;
  liveContextTokens: number | null;
  totalTokens: number | null;
}

/** Resolve model context window for a gateway session row via the catalog. */
export function resolveSessionModelWindow(
  session: GatewaySessionInfo,
  modelWindowMap: Record<string, number>
): number | null {
  const ref = session.modelProvider && session.model
    ? `${session.modelProvider}/${session.model}`
    : session.model;
  if (!ref) return null;
  return modelWindowMap[ref.toLowerCase()] ?? null;
}

/**
 * Enrich a gateway sessions.list payload with honest per-session metrics.
 * Falls back to transcript-tail estimates for Mission Control pipeline sessions
 * that lack live context counters (bounded, best-effort).
 */
export async function enrichGatewaySessions(
  sessions: GatewaySessionInfo[] | null | undefined
): Promise<EnrichedGatewaySession[]> {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];

  let modelWindowMap: Record<string, number> = {};
  try {
    const client = getOpenClawClient();
    const models = (await client.listModels()) as unknown as GatewayModelInfo[];
    modelWindowMap = buildModelWindowMap(models);
  } catch {
    // best-effort — without the catalog, the row's own contextTokens is used
  }

  const enriched: EnrichedGatewaySession[] = [];
  let tailFetches = 0;

  for (const session of sessions) {
    const window = resolveSessionModelWindow(session, modelWindowMap);
    const rawCtx =
      typeof session.contextTokens === 'number' && Number.isFinite(session.contextTokens)
        ? session.contextTokens
        : null;
    const windowFallbackUsed = rawCtx !== null && window !== null && rawCtx === window;

    // Live estimate: prefer the row value; else bounded transcript tail.
    let liveContextTokens = windowFallbackUsed ? null : rawCtx;
    if (
      liveContextTokens === null &&
      windowFallbackUsed &&
      isMissionControlSessionKey(session.key) &&
      tailFetches < MAX_TRANSCRIPT_TAIL_FETCHES &&
      session.key
    ) {
      tailFetches += 1;
      try {
        const client = getOpenClawClient();
        const history = await client.getSessionHistory(session.key);
        const est = estimateLiveContextFromHistory(history);
        if (est !== null) liveContextTokens = est;
      } catch {
        // best-effort
      }
    }

    const metrics = enrichGatewaySessionMetrics(session, window, liveContextTokens);
    enriched.push({ ...session, ...metrics });
  }

  return enriched;
}
