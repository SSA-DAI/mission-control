/**
 * PLATFORM-010 (D3) — SessionHealthCard UI helpers.
 *
 * Pure formatting + health-state metadata shared by the SessionHealthCard
 * component. Kept dependency-free so it can be unit-tested with the repo's
 * node:test runner (no jsdom needed).
 */

import type { SessionHealthState } from './session-health';

export interface HealthStateMeta {
  label: string;
  emoji: string;
  /** Tailwind classes for the color-coded badge. */
  badgeClass: string;
  /** Tooltip / detail text. */
  description: string;
}

export const HEALTH_STATE_META: Record<SessionHealthState, HealthStateMeta> = {
  healthy: {
    label: 'Healthy',
    emoji: '🟢',
    badgeClass: 'bg-green-500/10 text-green-400 border-green-500/40',
    description: 'Sesi sehat — aman untuk dipakai / di-reuse.',
  },
  degraded: {
    label: 'Degraded',
    emoji: '🟡',
    badgeClass: 'bg-amber-500/10 text-amber-300 border-amber-500/40',
    description: 'Sesi mendekati batas (token kumulatif > 50% cap) — pertimbangkan rotasi.',
  },
  unhealthy: {
    label: 'Unhealthy',
    emoji: '🔴',
    badgeClass: 'bg-red-500/10 text-red-400 border-red-500/40',
    description: 'Sesi rusak (status gagal / marker memory-flush / token cap terlampaui) — jangan reuse, rotasi otomatis.',
  },
};

export function healthStateMeta(state: SessionHealthState): HealthStateMeta {
  return HEALTH_STATE_META[state] ?? HEALTH_STATE_META.healthy;
}

/** Human-readable age: '45s', '12m', '3h 20m', '2d 4h'. */
export function formatAgeSeconds(ageSeconds: number | null | undefined): string {
  if (ageSeconds === null || ageSeconds === undefined || !Number.isFinite(ageSeconds)) return '—';
  const total = Math.max(0, Math.floor(ageSeconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Human-readable file size: '12.3 KB', '1.2 MB'. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** Human-readable tokens: '1.2M', '350k'. */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** Short sessionId for display (tail of the gateway key). */
export function shortSessionId(sessionId: string | null | undefined): string {
  if (!sessionId) return '—';
  if (sessionId.length <= 48) return sessionId;
  return `…${sessionId.slice(-44)}`;
}
