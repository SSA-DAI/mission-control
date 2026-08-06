/**
 * PLATFORM-020 — Auto-answer loop engine tests (time-budget based).
 *
 * Regression scenarios from PLATFORM-009 (stall_code=max_iterations on a
 * healthy-but-slow planning):
 *  1. Slow-but-progress planning → completes within the time budget (no
 *     premature stall on iteration count).
 *  2. Stuck planning → stalls on TIME BUDGET exhaustion, not max_iterations.
 *  3. max_iterations=50 stays as a hard ceiling (safety net) for fast
 *     no-progress loops.
 *  4. Time budget is checked BEFORE max_iterations (ordering).
 *  5. AUTO_ANSWER_TIMEOUT_MS env parsing with 10-minute fallback.
 *  6. Every progress entry carries elapsed ms (progress visibility).
 *
 * The engine is deterministic: `iterate` is a mock agent, `now()` is an
 * injected fake clock — no real sleeps, no real gateway needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runAutoAnswerLoop,
  getAutoAnswerTimeoutMs,
  DEFAULT_AUTO_ANSWER_TIMEOUT_MS,
  MAX_AUTO_ANSWER_ITERATIONS,
  type AutoAnswerProgressEntry,
} from './auto-answer-loop';

/** Injectable fake clock — advance() simulates the passage of real time. */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// ── 1. regression: slow-but-progress → completes, no premature stall ────────

test('slow-but-progress planning completes within time budget (no premature stall)', async () => {
  const clock = makeClock();
  let calls = 0;
  const progress: AutoAnswerProgressEntry[] = [];

  const outcome = await runAutoAnswerLoop({
    timeoutMs: 600_000, // 10 menit — sama seperti default
    maxIterations: MAX_AUTO_ANSWER_ITERATIONS,
    now: clock.now,
    onProgress: (entry) => progress.push(entry),
    iterate: async () => {
      calls++;
      clock.advance(15_000); // agent lambat: 15 detik per iterasi, tapi selalu progress
      if (calls >= 3) {
        return { kind: 'complete', log: { action: 'complete_detected' } };
      }
      return {
        kind: 'continue',
        note: 'Apakah scope cukup jelas?',
        log: { action: 'answered_question', questionSnippet: 'Apakah scope cukup jelas?', recommended: 'B' },
      };
    },
  });

  assert.equal(outcome.outcome, 'complete', 'healthy-but-slow planning must complete, not stall');
  assert.equal(calls, 3);
  assert.equal((outcome as { iterations: number }).iterations, 3);

  // Progress visibility: every iteration logged with elapsed ms.
  assert.equal(progress.length, 3, 'one progress entry per iteration');
  for (const entry of progress) {
    assert.equal(typeof entry.elapsedMs, 'number');
    assert.ok(entry.elapsedMs >= 0);
  }
  assert.equal(progress[1].action, 'answered_question');
  assert.equal(progress[1].questionSnippet, 'Apakah scope cukup jelas?');
});

// ── 2. stuck planning → time budget stall, NOT max_iterations ───────────────

test('stuck planning stalls on time budget exhaustion, not on max_iterations', async () => {
  const clock = makeClock();
  let calls = 0;

  const outcome = await runAutoAnswerLoop({
    timeoutMs: 10_000, // budget kecil agar test cepat
    maxIterations: MAX_AUTO_ANSWER_ITERATIONS,
    now: clock.now,
    iterate: async () => {
      calls++;
      clock.advance(3_000); // agent lambat dan tidak pernah progress
      return { kind: 'continue', note: 'Pertanyaan macet', log: { action: 'waiting_response' } };
    },
  });

  assert.equal(outcome.outcome, 'stall');
  assert.equal(outcome.code, 'time_budget_exhausted');
  assert.ok((outcome as { iterations: number }).iterations < 50, 'budget must fire long before max_iterations');
  assert.ok(outcome.reason.includes('menit'), 'reason must state the budget in minutes');
  assert.ok(outcome.reason.includes('Pertanyaan macet'), 'reason must surface the remaining question');
  assert.ok(outcome.reason.includes('Lanjutkan manual'), 'reason must suggest continuing manually');
});

// ── 3. max_iterations = 50 hard ceiling (safety net) ────────────────────────

test('max_iterations hard ceiling catches fast no-progress loops (safety net)', async () => {
  const clock = makeClock();
  let calls = 0;

  const outcome = await runAutoAnswerLoop({
    timeoutMs: 3_600_000, // budget 1 jam — iteration ceiling must fire first
    maxIterations: MAX_AUTO_ANSWER_ITERATIONS,
    now: clock.now,
    iterate: async () => {
      calls++;
      return { kind: 'continue', log: { action: 'idle' } }; // super cepat, tanpa progress
    },
  });

  assert.equal(outcome.outcome, 'stall');
  assert.equal(outcome.code, 'max_iterations');
  assert.equal(calls, 50, 'loop must be cut exactly at the hard ceiling');
  assert.equal((outcome as { iterations: number }).iterations, 50);
  assert.ok(outcome.reason.includes('50'));
});

// ── 4. ordering: time budget checked before max_iterations ─────────────────

test('time budget check precedes max_iterations (ordering)', async () => {
  const clock = makeClock();

  const outcome = await runAutoAnswerLoop({
    timeoutMs: 2_500,
    maxIterations: 50,
    now: clock.now,
    iterate: async () => {
      clock.advance(1_000); // 1 detik per iterasi, tidak pernah complete
      return { kind: 'continue', log: { action: 'tick' } };
    },
  });

  assert.equal(outcome.outcome, 'stall');
  assert.equal(outcome.code, 'time_budget_exhausted');
  // iterasi 1..3 jalan (elapsed 1000/2000/3000), iterasi 4 diblokir budget.
  assert.equal((outcome as { iterations: number }).iterations, 3);
  assert.ok((outcome as { elapsedMs: number }).elapsedMs >= 2_500);
});

// ── 5. env parsing: AUTO_ANSWER_TIMEOUT_MS fallback ─────────────────────────

test('AUTO_ANSWER_TIMEOUT_MS env parsing: unset/invalid → 600000 fallback, valid → parsed', () => {
  assert.equal(getAutoAnswerTimeoutMs({}), DEFAULT_AUTO_ANSWER_TIMEOUT_MS);
  assert.equal(getAutoAnswerTimeoutMs({ AUTO_ANSWER_TIMEOUT_MS: '' }), DEFAULT_AUTO_ANSWER_TIMEOUT_MS);
  assert.equal(getAutoAnswerTimeoutMs({ AUTO_ANSWER_TIMEOUT_MS: '0' }), DEFAULT_AUTO_ANSWER_TIMEOUT_MS);
  assert.equal(getAutoAnswerTimeoutMs({ AUTO_ANSWER_TIMEOUT_MS: '-5' }), DEFAULT_AUTO_ANSWER_TIMEOUT_MS);
  assert.equal(getAutoAnswerTimeoutMs({ AUTO_ANSWER_TIMEOUT_MS: 'abc' }), DEFAULT_AUTO_ANSWER_TIMEOUT_MS);
  assert.equal(getAutoAnswerTimeoutMs({ AUTO_ANSWER_TIMEOUT_MS: '300000' }), 300_000);
  assert.equal(getAutoAnswerTimeoutMs({ AUTO_ANSWER_TIMEOUT_MS: '  450000  ' }), 450_000);
});

// ── 6. iterate throw → unexpected_error stall, log preserved ────────────────

test('iterate throw → unexpected_error stall with progress log preserved', async () => {
  const clock = makeClock();
  const progress: AutoAnswerProgressEntry[] = [];

  const outcome = await runAutoAnswerLoop({
    timeoutMs: 600_000,
    maxIterations: MAX_AUTO_ANSWER_ITERATIONS,
    now: clock.now,
    onProgress: (entry) => progress.push(entry),
    iterate: async ({ iteration }) => {
      if (iteration === 1) {
        return { kind: 'continue', log: { action: 'ok' } };
      }
      throw new Error('boom');
    },
  });

  assert.equal(outcome.outcome, 'stall');
  assert.equal(outcome.code, 'unexpected_error');
  assert.ok(outcome.reason.includes('boom'));
  assert.equal(progress.length, 2, 'entry for iteration 1 + unexpected_error entry');
  assert.equal(progress[1].action, 'unexpected_error');
});

// ── 7. explicit stall from iterate passes through with reason ───────────────

test('iterate-returned stall passes through with its code and reason', async () => {
  const outcome = await runAutoAnswerLoop({
    timeoutMs: 600_000,
    maxIterations: 50,
    iterate: async () => ({
      kind: 'stall',
      code: 'invalid_json',
      reason: 'Planning agent response is not valid JSON (iteration 1)',
      log: { action: 'invalid_json' },
    }),
  });

  assert.equal(outcome.outcome, 'stall');
  assert.equal(outcome.code, 'invalid_json');
  assert.ok(outcome.reason.includes('not valid JSON'));
  assert.equal((outcome as { iterations: number }).iterations, 1);
});
