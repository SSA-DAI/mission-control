import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTokenRateAlertThreshold,
  recordTokenSample,
  evaluateTokenRateAlert,
  resetTokenRateTrackers,
  tokenRateTrackerCount,
  DEFAULT_TOKEN_RATE_ALERT,
  DEFAULT_WINDOW_MS,
} from './token-rate-alert';

test.afterEach(() => {
  resetTokenRateTrackers();
});

test('resolveTokenRateAlertThreshold: defaults to 1M', () => {
  assert.equal(resolveTokenRateAlertThreshold({} as unknown as NodeJS.ProcessEnv), DEFAULT_TOKEN_RATE_ALERT);
});

test('resolveTokenRateAlertThreshold: honors env override', () => {
  assert.equal(
    resolveTokenRateAlertThreshold({ TOKEN_RATE_ALERT: '500000' } as unknown as NodeJS.ProcessEnv),
    500_000
  );
});

test('resolveTokenRateAlertThreshold: invalid env falls back to default', () => {
  assert.equal(
    resolveTokenRateAlertThreshold({ TOKEN_RATE_ALERT: 'banana' } as unknown as NodeJS.ProcessEnv),
    DEFAULT_TOKEN_RATE_ALERT
  );
  assert.equal(
    resolveTokenRateAlertThreshold({ TOKEN_RATE_ALERT: '-100' } as unknown as NodeJS.ProcessEnv),
    DEFAULT_TOKEN_RATE_ALERT
  );
});

test('recordTokenSample: stores samples and increments tracker count', () => {
  resetTokenRateTrackers();
  assert.equal(tokenRateTrackerCount(), 0);

  recordTokenSample('task-1', 'agent-1', 100_000);
  recordTokenSample('task-1', 'agent-1', 200_000);
  recordTokenSample('task-2', 'agent-2', 50_000);

  assert.equal(tokenRateTrackerCount(), 2);
});

test('evaluateTokenRateAlert: null when no samples', () => {
  const result = evaluateTokenRateAlert('task-x', 'agent-x', 'Test Agent');
  assert.equal(result, null);
});

test('evaluateTokenRateAlert: null when only 1 sample (need delta)', () => {
  recordTokenSample('task-1', 'agent-1', 100_000);
  const result = evaluateTokenRateAlert('task-1', 'agent-1', 'Test Agent');
  assert.equal(result, null);
});

test('evaluateTokenRateAlert: below threshold → no alert', () => {
  recordTokenSample('task-1', 'agent-1', 100_000);
  recordTokenSample('task-1', 'agent-1', 500_000); // delta 400k < 1M
  const result = evaluateTokenRateAlert('task-1', 'agent-1', 'Test Agent', {
    threshold: 1_000_000,
    windowMs: 10 * 60 * 1000,
    cooldownMs: 0,
  });
  assert.ok(result !== null);
  assert.equal(result!.rateTotal, 400_000);
  assert.equal(result!.alertFired, false);
});

test('evaluateTokenRateAlert: above threshold → alert fired', () => {
  recordTokenSample('task-1', 'agent-1', 0);
  recordTokenSample('task-1', 'agent-1', 7_100_000); // delta 7.1M > 1M — MRN-104 pattern
  const result = evaluateTokenRateAlert('task-1', 'agent-1', 'Test Agent', {
    threshold: 1_000_000,
    windowMs: 10 * 60 * 1000,
    cooldownMs: 0,
  });
  assert.ok(result !== null);
  assert.equal(result!.rateTotal, 7_100_000);
  assert.ok(result!.alertFired, 'alert must fire when threshold exceeded');
  assert.ok(result!.rateTokensPerMinute > 0);
});

test('evaluateTokenRateAlert: cooldown prevents duplicate alerts', () => {
  recordTokenSample('task-1', 'agent-1', 0);
  recordTokenSample('task-1', 'agent-1', 2_000_000);

  // First call: should fire.
  const r1 = evaluateTokenRateAlert('task-1', 'agent-1', 'Test Agent', {
    threshold: 1_000_000,
    windowMs: 10 * 60 * 1000,
    cooldownMs: 60_000, // 1 minute cooldown
  });
  assert.ok(r1!.alertFired);

  // Immediately add another sample — still within cooldown.
  recordTokenSample('task-1', 'agent-1', 3_000_000);
  const r2 = evaluateTokenRateAlert('task-1', 'agent-1', 'Test Agent', {
    threshold: 1_000_000,
    windowMs: 10 * 60 * 1000,
    cooldownMs: 60_000,
  });
  assert.equal(r2!.alertFired, false, 'cooldown must prevent duplicate alert');
});

test('evaluateTokenRateAlert: old samples purged from sliding window', () => {
  // Time-travel: inject explicit timestamps so a >window sample exists.
  // All 3 samples recorded within the same real millisecond (Date.now()) would
  // all satisfy timestamp >= cutoff and NOT be purged — the old test asserted
  // null but got { rateTotal: 200, alertFired: true }. Real time-travel via
  // injected timestamps + nowMs makes the purge deterministic.
  const now = 1_000_000;
  recordTokenSample('task-1', 'agent-1', 0, now - 60_000); // old — outside 1ms window
  recordTokenSample('task-1', 'agent-1', 100, now);        // in window
  recordTokenSample('task-1', 'agent-1', 200, now);        // in window

  // With a 1ms window, the first sample must be purged. The rate then reflects
  // ONLY the in-window delta (200 - 100 = 100), not the full 0→200 span.
  const result = evaluateTokenRateAlert('task-1', 'agent-1', 'Test Agent', {
    threshold: 100,
    windowMs: 1,
    cooldownMs: 0,
    nowMs: now,
  });
  assert.ok(result !== null, 'in-window samples remain after purge');
  assert.equal(result!.rateTotal, 100, 'delta counts only in-window samples');
  assert.equal(result!.alertFired, false, '100 is not > threshold 100');
});

test('evaluateTokenRateAlert: null when purge leaves <2 in-window samples', () => {
  const now = 1_000_000;
  recordTokenSample('task-1', 'agent-1', 0, now - 60_000); // purged
  recordTokenSample('task-1', 'agent-1', 100, now);        // only 1 remains

  const result = evaluateTokenRateAlert('task-1', 'agent-1', 'Test Agent', {
    threshold: 50,
    windowMs: 1,
    cooldownMs: 0,
    nowMs: now,
  });
  // After purging old samples we have < 2 → null (cannot compute a delta).
  assert.equal(result, null);
});

test('evaluateTokenRateAlert: cooldown uses injected nowMs', () => {
  const t0 = 1_000_000;
  recordTokenSample('task-1', 'agent-1', 0, t0);
  recordTokenSample('task-1', 'agent-1', 2_000_000, t0 + 1_000);

  const r1 = evaluateTokenRateAlert('task-1', 'agent-1', 'Test Agent', {
    threshold: 1_000_000,
    windowMs: 10 * 60 * 1000,
    cooldownMs: 60_000,
    nowMs: t0 + 2_000,
  });
  assert.ok(r1!.alertFired, 'alert fires when threshold exceeded');

  // Immediately after (within cooldown) — no second alert.
  recordTokenSample('task-1', 'agent-1', 3_000_000, t0 + 3_000);
  const r2 = evaluateTokenRateAlert('task-1', 'agent-1', 'Test Agent', {
    threshold: 1_000_000,
    windowMs: 10 * 60 * 1000,
    cooldownMs: 60_000,
    nowMs: t0 + 4_000,
  });
  assert.equal(r2!.alertFired, false, 'cooldown must prevent duplicate alert');
});

test('resetTokenRateTrackers: clears all trackers', () => {
  recordTokenSample('a', 'b', 1);
  assert.equal(tokenRateTrackerCount(), 1);
  resetTokenRateTrackers();
  assert.equal(tokenRateTrackerCount(), 0);
});
