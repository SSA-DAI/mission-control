/**
 * PLATFORM-020 — Auto-answer loop engine (time-budget based).
 *
 * Replaces the old fixed `max_iterations = 10` gate that caused false stalls
 * (PLATFORM-009: stall_code=max_iterations on a healthy-but-slow planning).
 * Iteration counts do not reflect real elapsed time, so the PRIMARY stall gate
 * is now a wall-clock time budget (AUTO_ANSWER_TIMEOUT_MS, default 10 min).
 * `max_iterations` stays as a SECONDARY hard ceiling (50) to catch infinite
 * loops if the timer/budget logic ever fails.
 *
 * The engine is framework-agnostic and deterministic under tests: the caller
 * supplies the `iterate` callback (one iteration of real work) and may inject
 * a `now()` clock. Every iteration emits a progress entry (iteration number,
 * action, question answered, elapsed ms) via `onProgress`.
 */

export const MAX_AUTO_ANSWER_ITERATIONS = 50;
export const DEFAULT_AUTO_ANSWER_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Resolve the time budget from env. Unset / empty / invalid / non-positive
 * values fall back to the 10-minute default (backward-compatible).
 */
export function getAutoAnswerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTO_ANSWER_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_AUTO_ANSWER_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[Auto-Answer] Invalid AUTO_ANSWER_TIMEOUT_MS="${raw}" — falling back to ${DEFAULT_AUTO_ANSWER_TIMEOUT_MS}ms`
    );
    return DEFAULT_AUTO_ANSWER_TIMEOUT_MS;
  }
  return parsed;
}

export interface AutoAnswerProgressEntry {
  iteration: number;
  action: string;
  questionSnippet?: string;
  recommended?: string;
  elapsedMs: number;
}

/** Fields describing what happened in one iteration (merged with elapsedMs). */
export interface AutoAnswerIterationLog {
  action: string;
  questionSnippet?: string;
  recommended?: string;
}

export type AutoAnswerIterationResult =
  | { kind: 'complete'; payload?: unknown; log?: AutoAnswerIterationLog }
  | { kind: 'continue'; note?: string; log?: AutoAnswerIterationLog }
  | { kind: 'stall'; code: string; reason: string; log?: AutoAnswerIterationLog };

export interface AutoAnswerLoopOptions {
  /** Hard iteration ceiling (secondary safety net). Default 50. */
  maxIterations?: number;
  /** Primary wall-clock budget in ms. Default 10 minutes. */
  timeoutMs?: number;
  /** Injectable clock (default Date.now) — deterministic tests. */
  now?: () => number;
  iterate: (ctx: { iteration: number; elapsedMs: number }) => Promise<AutoAnswerIterationResult>;
  onProgress?: (entry: AutoAnswerProgressEntry) => void;
}

export type AutoAnswerLoopOutcome =
  | { outcome: 'complete'; iterations: number; elapsedMs: number; payload?: unknown }
  | {
      outcome: 'stall';
      code: string;
      reason: string;
      iterations: number;
      elapsedMs: number;
      lastNote?: string;
    };

function buildBudgetExhaustedReason(
  timeoutMs: number,
  elapsedMs: number,
  iterations: number,
  lastNote?: string
): string {
  const minutes = (timeoutMs / 60_000).toFixed(1);
  const seconds = Math.round(elapsedMs / 1000);
  let reason =
    `Auto-answer time budget (${timeoutMs} ms / ${minutes} menit) exhausted after ${iterations} iterasi ` +
    `(${seconds}s berjalan) — planning belum complete`;
  if (lastNote) {
    reason += `. Pertanyaan tersisa: "${lastNote}"`;
  }
  reason += '. Lanjutkan manual: buka task dan jawab pertanyaan planning secara langsung, atau periksa sesi planning agent.';
  return reason;
}

/**
 * Run the auto-answer loop.
 *
 * Gates (checked in order, before each iteration):
 *  1. Time budget exhausted  → stall `time_budget_exhausted` (PRIMARY)
 *  2. `iterate` returns stall → caller stall (invalid response, send failure, …)
 *  3. `iterate` returns complete → success
 *  4. Iteration ceiling hit   → stall `max_iterations` (SECONDARY safety net)
 */
export async function runAutoAnswerLoop(opts: AutoAnswerLoopOptions): Promise<AutoAnswerLoopOutcome> {
  const maxIterations = opts.maxIterations ?? MAX_AUTO_ANSWER_ITERATIONS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AUTO_ANSWER_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const start = now();
  let lastNote: string | undefined;

  const emit = (entry: AutoAnswerProgressEntry): void => {
    if (opts.onProgress) opts.onProgress(entry);
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const elapsedMs = now() - start;

    // PRIMARY gate: wall-clock time budget. A healthy-but-slow planning must
    // never be killed on iteration count before its time budget runs out.
    if (elapsedMs >= timeoutMs) {
      const reason = buildBudgetExhaustedReason(timeoutMs, elapsedMs, iteration - 1, lastNote);
      emit({ iteration, action: 'time_budget_exhausted', elapsedMs });
      return {
        outcome: 'stall',
        code: 'time_budget_exhausted',
        reason,
        iterations: iteration - 1,
        elapsedMs,
        lastNote,
      };
    }

    let result: AutoAnswerIterationResult;
    try {
      result = await opts.iterate({ iteration, elapsedMs });
    } catch (err) {
      const reason = `Auto-answer failed: ${(err as Error).message}`;
      emit({ iteration, action: 'unexpected_error', elapsedMs: now() - start });
      return { outcome: 'stall', code: 'unexpected_error', reason, iterations: iteration, elapsedMs: now() - start };
    }

    const afterMs = now() - start;

    if (result.kind === 'complete') {
      emit({ iteration, elapsedMs: afterMs, action: result.log?.action ?? 'complete' });
      return { outcome: 'complete', iterations: iteration, elapsedMs: afterMs, payload: result.payload };
    }

    if (result.kind === 'stall') {
      emit({ iteration, elapsedMs: afterMs, action: result.log?.action ?? 'stalled' });
      return {
        outcome: 'stall',
        code: result.code,
        reason: result.reason,
        iterations: iteration,
        elapsedMs: afterMs,
        lastNote,
      };
    }

    // continue — remember the pending question so a later budget stall can
    // surface "sisa pertanyaan" in its message.
    if (result.note) lastNote = result.note;
    emit({
      iteration,
      elapsedMs: afterMs,
      action: result.log?.action ?? 'continue',
      questionSnippet: result.log?.questionSnippet ?? result.note,
      recommended: result.log?.recommended,
    });
  }

  const elapsedMs = now() - start;
  const reason =
    `Auto-answer reached max iterations (${maxIterations}) without completing planning — ` +
    'menunggu keputusan manusia. Lanjutkan manual: buka task dan jawab pertanyaan planning secara langsung, atau periksa sesi planning agent.';
  emit({ iteration: maxIterations, elapsedMs, action: 'max_iterations' });
  return { outcome: 'stall', code: 'max_iterations', reason, iterations: maxIterations, elapsedMs, lastNote };
}
