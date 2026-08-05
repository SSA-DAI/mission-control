/**
 * SessionHealthCard — PLATFORM-010 (D3)
 *
 * Task-level session health summary: current sessionId, run number, health
 * state (healthy 🟢 / degraded 🟡 / unhealthy 🔴) with color-coded badge +
 * tooltip, umur sesi, totalTokens, ukuran file sesi, dan riwayat rotasi.
 * Auto-refresh every 30s (color-coded health + auto-refresh constraint).
 *
 * Data source: GET /api/tasks/[id]/planning/health (planning health endpoint).
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Clock,
  Database,
  FileText,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { healthStateMeta, formatAgeSeconds, formatFileSize, formatTokens, shortSessionId } from '@/lib/session-health-ui';
import type { SessionHealthState } from '@/lib/session-health';

export interface SessionHealthCardSession {
  id: string;
  sessionId: string;
  agentId: string | null;
  agentName: string | null;
  agentAvatarEmoji: string | null;
  runNumber: number;
  status: string;
  health: SessionHealthState;
  healthReasons: string[];
  ageSeconds: number;
  totalTokens: number | null;
  contextTokens: number | null;
  ctxPct: number | null;
  fileSizeBytes: number | null;
  corruptionMarker: string | null;
  rotatedFrom: string | null;
  rotationReason: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface SessionHealthCardRotation {
  sessionId: string;
  agentName: string | null;
  runNumber: number;
  reason: string;
  rotatedAt: string;
}

export interface SessionHealthCardAlert {
  activityType: string;
  message: string;
  createdAt: string;
}

export interface SessionHealthCardProps {
  taskId: string;
  /** Auto-refresh interval in ms (default 30s per spec). */
  refreshMs?: number;
}

const DEFAULT_REFRESH_MS = 30_000;

export function SessionHealthCard({ taskId, refreshMs = DEFAULT_REFRESH_MS }: SessionHealthCardProps) {
  const [sessions, setSessions] = useState<SessionHealthCardSession[]>([]);
  const [rotations, setRotations] = useState<SessionHealthCardRotation[]>([]);
  const [alerts, setAlerts] = useState<SessionHealthCardAlert[]>([]);
  const [gatewayReachable, setGatewayReachable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/health`, { cache: 'no-store' });
      if (!res.ok) {
        setError(`Health endpoint ${res.status}`);
        return;
      }
      const data = await res.json();
      setSessions(data.sessions ?? []);
      setRotations(data.rotations ?? []);
      setAlerts(data.alerts ?? []);
      setGatewayReachable(data.gatewayReachable !== false);
      setError(null);
    } catch (err) {
      setError((err as Error).message || 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
    // PLATFORM-010 (D3): auto-refresh every 30s.
    const interval = setInterval(load, refreshMs);
    return () => clearInterval(interval);
  }, [load, refreshMs]);

  if (loading) {
    return (
      <div className="p-3 bg-mc-bg rounded-lg border border-mc-border flex items-center gap-2 text-sm text-mc-text-secondary">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading session health…
      </div>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <div className="p-3 bg-mc-bg rounded-lg border border-mc-border flex items-center gap-2 text-sm text-mc-accent-red">
        <XCircle className="w-4 h-4 flex-shrink-0" />
        Session health unavailable: {error}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="p-3 bg-mc-bg rounded-lg border border-mc-border text-sm text-mc-text-secondary">
        No pipeline sessions yet.
      </div>
    );
  }

  const current = sessions[0]; // newest session (ORDER BY created_at DESC)

  return (
    <div className="space-y-2">
      {/* ── alert strip: token-rate / rotation alerts from the activity feed ── */}
      {alerts.length > 0 && (
        <div className="p-2.5 bg-red-500/10 border border-red-500/40 rounded-lg space-y-1">
          {alerts.slice(0, 3).map((a, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-red-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span className="min-w-0">
                {a.message}
                <span className="text-red-400/60 ml-1">({new Date(a.createdAt).toLocaleString()})</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── current session health ── */}
      <div className="p-3 bg-mc-bg rounded-lg border border-mc-border space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-lg">{current.agentAvatarEmoji ?? '🤖'}</span>
          <span className="font-medium text-mc-text">
            {current.agentName || 'Agent'}
          </span>
          {current.runNumber > 1 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-mc-bg-tertiary text-mc-text-secondary">
              run #{current.runNumber}
            </span>
          )}
          {/* Color-coded health badge with tooltip */}
          <span
            title={`${healthStateMeta(current.health).description}${
              current.healthReasons.length > 0 ? '\n' + current.healthReasons.join('\n') : ''
            }`}
            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${healthStateMeta(current.health).badgeClass} cursor-help`}
          >
            {healthStateMeta(current.health).emoji} {healthStateMeta(current.health).label}
          </span>
          <span className="text-xs text-mc-text-secondary capitalize">({current.status})</span>
          {!gatewayReachable && (
            <span
              title="OpenClaw gateway tidak terjangkau — data berasal dari DB (bisa basi)."
              className="text-xs text-mc-text-secondary cursor-help"
            >
              ⚠️ gateway offline
            </span>
          )}
        </div>

        {/* SessionId */}
        <div className="text-xs text-mc-text-secondary font-mono truncate" title={current.sessionId}>
          Session: {shortSessionId(current.sessionId)}
        </div>

        {/* Health reasons (unhealthy/degraded detail) */}
        {current.health !== 'healthy' && current.healthReasons.length > 0 && (
          <div className="flex items-start gap-1.5 text-xs text-mc-accent-red">
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span className="font-mono break-all">{current.healthReasons.join('; ')}</span>
          </div>
        )}

        {/* Metrics row: umur · tokens · file size */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-mc-text-secondary">
          <span className="inline-flex items-center gap-1" title="Umur sesi">
            <Clock className="w-3.5 h-3.5" />
            Umur: <span className="font-mono text-mc-text">{formatAgeSeconds(current.ageSeconds)}</span>
          </span>
          <span className="inline-flex items-center gap-1" title="Kumulatif token sesi">
            <Activity className="w-3.5 h-3.5" />
            Tokens: <span className="font-mono text-mc-text">{formatTokens(current.totalTokens)}</span>
            {current.ctxPct !== null && (
              <span className="text-mc-text-secondary">(ctx {current.ctxPct}%)</span>
            )}
          </span>
          <span
            className="inline-flex items-center gap-1"
            title="Ukuran file sesi (estimasi transcript dari chat.history)"
          >
            <FileText className="w-3.5 h-3.5" />
            File: <span className="font-mono text-mc-text">{formatFileSize(current.fileSizeBytes)}</span>
          </span>
          <span className="inline-flex items-center gap-1" title="Mulai sesi">
            <Database className="w-3.5 h-3.5" />
            Mulai: <span className="font-mono text-mc-text">{new Date(current.createdAt).toLocaleString()}</span>
          </span>
        </div>
      </div>

      {/* ── rotation history ── */}
      {rotations.length > 0 && (
        <div className="p-3 bg-mc-bg rounded-lg border border-mc-border">
          <div className="text-xs font-medium text-mc-text-secondary mb-1.5 flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Riwayat rotasi sesi ({rotations.length})
          </div>
          <ul className="space-y-1">
            {rotations.map((r, i) => (
              <li key={i} className="text-xs text-mc-text-secondary flex items-start gap-1.5">
                <RefreshCw className="w-3 h-3 mt-0.5 flex-shrink-0 text-amber-500" />
                <span className="min-w-0">
                  <span className="font-mono text-mc-text">{shortSessionId(r.sessionId)}</span>
                  {' — '}
                  {r.reason}
                  <span className="text-mc-text-secondary/70"> ({new Date(r.rotatedAt).toLocaleString()})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default SessionHealthCard;
