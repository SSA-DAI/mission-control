/**
 * PLATFORM-010 (D2) — Token rate alert for Mission Control pipeline sessions.
 *
 * Tracks cumulative token consumption per session using a sliding window.
 * When the rate exceeds a configurable threshold (TOKEN_RATE_ALERT env var),
 * the alert is pushed to the task activity feed + status_reason.
 *
 * Design:
 * - Sliding window of WINDOW_MS (default 10 minutes)
 * - Threshold from TOKEN_RATE_ALERT env var (default 1_000_000 tokens)
 * - In-memory tracker (per-process; resets on restart)
 * - Alert fires once per window per (task, agent) to avoid spam
 */

import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { broadcast } from '@/lib/events';

export const DEFAULT_TOKEN_RATE_ALERT = 1_000_000; // 1M tokens
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000;   // 10 minutes
export const ALERT_COOLDOWN_MS = 2 * 60 * 1000;     // 2 min between alerts per session

interface RateSample {
  tokens: number;
  timestampMs: number;
}

interface SessionRateTracker {
  samples: RateSample[];
  lastAlertMs: number;
}

/** In-memory rate trackers keyed by "taskId:agentId". */
const trackers = new Map<string, SessionRateTracker>();

function trackerKey(taskId: string, agentId: string): string {
  return `${taskId}:${agentId}`;
}

/** Resolve alert threshold from env with safe defaults. */
export function resolveTokenRateAlertThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TOKEN_RATE_ALERT;
  if (!raw) return DEFAULT_TOKEN_RATE_ALERT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOKEN_RATE_ALERT;
  return Math.floor(parsed);
}

/**
 * Record a token sample for the session. Call this whenever you have a fresh
 * totalTokens reading (e.g. from the gateway sessions.list or after a health
 * check).
 *
 * @param timestampMs optional wall-clock override — used by tests to simulate
 * time travel so sliding-window purge behavior is deterministic.
 */
export function recordTokenSample(
  taskId: string,
  agentId: string,
  totalTokens: number,
  timestampMs?: number
): void {
  const key = trackerKey(taskId, agentId);
  let tracker = trackers.get(key);
  if (!tracker) {
    tracker = { samples: [], lastAlertMs: 0 };
    trackers.set(key, tracker);
  }
  tracker.samples.push({ tokens: totalTokens, timestampMs: timestampMs ?? Date.now() });
}

/**
 * Evaluate the sliding-window token rate and fire an alert if the threshold
 * is exceeded. Returns the current rate, or null if there aren't enough
 * samples. Does NOT fire an alert if we're within the cooldown period.
 */
export function evaluateTokenRateAlert(
  taskId: string,
  agentId: string,
  agentName: string,
  config?: {
    threshold?: number;
    windowMs?: number;
    cooldownMs?: number;
    /** Wall-clock override (tests) — defaults to Date.now(). */
    nowMs?: number;
  }
): {
  rateTotal: number;
  rateTokensPerMinute: number;
  threshold: number;
  alertFired: boolean;
} | null {
  const key = trackerKey(taskId, agentId);
  const tracker = trackers.get(key);
  if (!tracker || tracker.samples.length < 2) return null;

  const threshold = config?.threshold ?? resolveTokenRateAlertThreshold();
  const windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
  const cooldownMs = config?.cooldownMs ?? ALERT_COOLDOWN_MS;
  const now = config?.nowMs ?? Date.now();

  // Purge old samples outside the sliding window.
  const cutoff = now - windowMs;
  tracker.samples = tracker.samples.filter(s => s.timestampMs >= cutoff);
  if (tracker.samples.length < 2) return null;

  // Rate = delta tokens in the window.
  const oldest = tracker.samples[0];
  const newest = tracker.samples[tracker.samples.length - 1];
  const rateTotal = newest.tokens - oldest.tokens;
  const rateTokensPerMinute = Math.round(rateTotal / (windowMs / 60_000));

  // Alert only if threshold exceeded and cooldown has passed.
  let alertFired = false;
  if (rateTotal > threshold && (now - tracker.lastAlertMs) > cooldownMs) {
    tracker.lastAlertMs = now;
    alertFired = true;

    const alertMessage =
      `⚠️ TOKEN RATE ALERT: ${agentName} consumed ${rateTotal.toLocaleString('en-US')} tokens ` +
      `in the last ${windowMs / 60_000} minutes (rate ${rateTokensPerMinute.toLocaleString('en-US')} tok/min). ` +
      `Threshold: ${threshold.toLocaleString('en-US')} tokens. Task may be flailing in an unhealthy session.`;

    console.warn(`[TokenRateAlert] ${alertMessage}`);

    // Push to activity feed (best-effort — won't fail the caller).
    try {
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          uuidv4(),
          taskId,
          agentId,
          'token_rate_alert',
          alertMessage,
          JSON.stringify({
            rate_total: rateTotal,
            rate_tokens_per_minute: rateTokensPerMinute,
            threshold,
            window_ms: windowMs,
            samples: tracker.samples.length,
          }),
        ]
      );
    } catch {
      // Foreign key or DB issue — the alert is best-effort.
    }

    // Set status_reason on the task (best-effort).
    try {
      run(
        `UPDATE tasks SET status_reason = ?, updated_at = datetime('now') WHERE id = ?`,
        [`TOKEN_RATE_ALERT: ${rateTokensPerMinute.toLocaleString('en-US')} tok/min (${rateTotal.toLocaleString('en-US')} in ${windowMs / 60_000}m)`, taskId]
      );
    } catch {
      // best-effort
    }

    // Broadcast so UI updates live.
    try {
      broadcast({
        type: 'task_updated' as any,
        payload: {
          id: taskId,
          status_reason: `TOKEN_RATE_ALERT: ${rateTokensPerMinute.toLocaleString('en-US')} tok/min`,
        } as any,
      });
    } catch {
      // best-effort
    }
  }

  return { rateTotal, rateTokensPerMinute, threshold, alertFired };
}

/** Reset trackers (for testing). */
export function resetTokenRateTrackers(): void {
  trackers.clear();
}

/** Get the number of trackers (for testing). */
export function tokenRateTrackerCount(): number {
  return trackers.size;
}
