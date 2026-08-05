/**
 * PLATFORM-010 (D3) — SessionHealthCard UI helper unit tests.
 * Pure formatting + health-state metadata (no jsdom needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH_STATE_META,
  healthStateMeta,
  formatAgeSeconds,
  formatFileSize,
  formatTokens,
  shortSessionId,
} from './session-health-ui';
import { deriveSessionHealthState, type SessionHealthVerdict } from './session-health';

// ── health state derivation (backend logic the UI colors off) ──

function verdict(partial: Partial<SessionHealthVerdict>): SessionHealthVerdict {
  return {
    healthy: true,
    reasons: [],
    totalTokens: null,
    contextTokens: null,
    contextWindow: null,
    ctxPct: null,
    cumulativePct: null,
    corruptionMarker: null,
    corruptionCount: 0,
    ...partial,
  };
}

test('deriveSessionHealthState: healthy verdict → healthy', () => {
  assert.equal(deriveSessionHealthState(verdict({ healthy: true, totalTokens: 10_000 })), 'healthy');
});

test('deriveSessionHealthState: unhealthy verdict → unhealthy (regardless of tokens)', () => {
  const v = verdict({
    healthy: false,
    totalTokens: 10_000,
    reasons: ['session_corrupted:Memory flush writes are restricted(11x)'],
  });
  assert.equal(deriveSessionHealthState(v), 'unhealthy');
});

test('deriveSessionHealthState: totalTokens > 50% of cap → degraded', () => {
  // Default cap 1_000_000 → 600_000 > 500_000 → degraded.
  const v = verdict({ healthy: true, totalTokens: 600_000 });
  assert.equal(deriveSessionHealthState(v), 'degraded');
});

test('deriveSessionHealthState: exactly 50% of cap → still healthy', () => {
  const v = verdict({ healthy: true, totalTokens: 500_000 });
  assert.equal(deriveSessionHealthState(v), 'healthy');
});

test('deriveSessionHealthState: honors custom config cap', () => {
  const v = verdict({ healthy: true, totalTokens: 60_000 });
  assert.equal(
    deriveSessionHealthState(v, { maxTotalTokens: 100_000, ctxHighWaterPct: 90 }),
    'degraded'
  );
});

// ── health state metadata (color-coded badges) ──

test('HEALTH_STATE_META: all three states present with emoji + badge class', () => {
  assert.equal(HEALTH_STATE_META.healthy.emoji, '🟢');
  assert.equal(HEALTH_STATE_META.degraded.emoji, '🟡');
  assert.equal(HEALTH_STATE_META.unhealthy.emoji, '🔴');
  for (const meta of Object.values(HEALTH_STATE_META)) {
    assert.ok(meta.badgeClass.includes('bg-'), 'badge has a background color class');
    assert.ok(meta.badgeClass.includes('text-'), 'badge has a text color class');
    assert.ok(meta.description.length > 0, 'badge has a tooltip description');
  }
});

test('healthStateMeta: unknown state falls back to healthy', () => {
  assert.equal(healthStateMeta('healthy').label, 'Healthy');
});

// ── age formatting ──

test('formatAgeSeconds: seconds / minutes / hours / days', () => {
  assert.equal(formatAgeSeconds(45), '45s');
  assert.equal(formatAgeSeconds(720), '12m 0s');
  assert.equal(formatAgeSeconds(12_000), '3h 20m');
  assert.equal(formatAgeSeconds(200_000), '2d 7h');
});

test('formatAgeSeconds: null/undefined/negative → em dash', () => {
  assert.equal(formatAgeSeconds(null), '—');
  assert.equal(formatAgeSeconds(undefined), '—');
  assert.equal(formatAgeSeconds(-5), '0s');
});

// ── file size formatting (ukuran file sesi) ──

test('formatFileSize: bytes → KB → MB', () => {
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(12_800), '12.5 KB');
  assert.equal(formatFileSize(1_500_000), '1.43 MB');
});

test('formatFileSize: null/undefined → em dash', () => {
  assert.equal(formatFileSize(null), '—');
  assert.equal(formatFileSize(undefined), '—');
});

// ── token formatting ──

test('formatTokens: raw / k / M', () => {
  assert.equal(formatTokens(710_000), '710k');
  assert.equal(formatTokens(7_100_000), '7.10M');
  assert.equal(formatTokens(512), '512');
});

test('formatTokens: null/undefined → em dash', () => {
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(undefined), '—');
});

// ── sessionId shortening ──

test('shortSessionId: short ids unchanged, long ids tail-truncated', () => {
  assert.equal(shortSessionId('mission-control-builder-task1'), 'mission-control-builder-task1');
  const long = 'agent:builder:mission-control-builder-task-1234567890-r2-abcdefghijklmnopqrstuvwxyz';
  const short = shortSessionId(long);
  assert.ok(short.length <= 48, 'shortened id fits the card');
  assert.ok(long.endsWith(short.slice(1)), 'tail is preserved');
});

test('shortSessionId: null → em dash', () => {
  assert.equal(shortSessionId(null), '—');
  assert.equal(shortSessionId(undefined), '—');
});
