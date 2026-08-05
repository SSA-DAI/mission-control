/**
 * PLATFORM-010 (D3) — Task session health snapshot.
 *
 * Assembles the data behind GET /api/tasks/[id]/planning/health: per-session
 * health state (healthy 🟢 / degraded 🟡 / unhealthy 🔴), sessionId, run number,
 * age, totalTokens, session file size, and rotation history — plus recent
 * token-rate / rotation alerts from the activity feed.
 *
 * The assembly is a pure-ish lib function with injectable gateway providers so
 * it can be integration-tested against a scratch DB without a live gateway
 * (the gateway only enriches; DB-only fallback keeps the UI truthful).
 */

import { queryAll } from '@/lib/db';
import {
  evaluateSessionHealth,
  detectSessionCorruptionMarkers,
  deriveSessionHealthState,
  estimateFileSizeFromHistory,
  resolveSessionHealthConfig,
  type GatewaySessionInfo,
  type SessionHealthState,
} from '@/lib/session-health';

export const HEALTH_ALERT_TYPES = [
  'token_rate_alert',
  'session_rotated',
  'session_unhealthy',
  'session_corrupted',
] as const;

export interface TaskSessionHealthRow {
  id: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_avatar_emoji: string | null;
  agent_session_key_prefix: string | null;
  openclaw_session_id: string;
  status: string;
  session_type: string;
  total_tokens: number | null;
  context_tokens: number | null;
  run_number: number | null;
  file_size_bytes: number | null;
  rotated_from: string | null;
  rotation_reason: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface SessionHealthCardData {
  id: string;
  sessionId: string;
  agentId: string | null;
  agentName: string | null;
  agentAvatarEmoji: string | null;
  runNumber: number;
  status: string;
  health: SessionHealthState;
  healthReasons: string[];
  /** Umur sesi in seconds (from created_at to now / ended_at). */
  ageSeconds: number;
  totalTokens: number | null;
  contextTokens: number | null;
  ctxPct: number | null;
  /** Ukuran file sesi (estimated transcript bytes). */
  fileSizeBytes: number | null;
  corruptionMarker: string | null;
  rotatedFrom: string | null;
  rotationReason: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface SessionRotationInfo {
  sessionId: string;
  agentName: string | null;
  runNumber: number;
  reason: string;
  rotatedAt: string;
}

export interface SessionAlertInfo {
  activityType: string;
  message: string;
  createdAt: string;
}

export interface TaskSessionHealthSnapshot {
  taskId: string;
  generatedAt: string;
  gatewayReachable: boolean;
  sessions: SessionHealthCardData[];
  rotations: SessionRotationInfo[];
  alerts: SessionAlertInfo[];
}

export interface TaskSessionHealthProviders {
  /** Gateway sessions.list rows (best-effort; null/throw → DB-only). */
  listGatewaySessions?: () => Promise<GatewaySessionInfo[]>;
  /** Gateway chat.history for a session key (best-effort). */
  getHistory?: (sessionKey: string) => Promise<unknown[]>;
}

function ageSeconds(createdAt: string, endedAt: string | null, nowMs: number): number {
  const start = new Date(createdAt).getTime();
  if (!Number.isFinite(start)) return 0;
  const end = endedAt ? new Date(endedAt).getTime() : nowMs;
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}

/** Find the gateway row for a DB session (match by key suffix or sessionId). */
function findGatewayRow(
  gatewaySessions: GatewaySessionInfo[],
  row: TaskSessionHealthRow
): GatewaySessionInfo | null {
  const keySuffix = row.openclaw_session_id;
  return (
    gatewaySessions.find(g => g.key?.endsWith(keySuffix)) ??
    gatewaySessions.find(g => g.sessionId === keySuffix) ??
    null
  );
}

/**
 * Build the task session-health snapshot.
 *
 * @param taskId task id
 * @param providers optional gateway providers (enrichment only)
 * @param nowMs wall-clock override for deterministic tests
 */
export async function buildTaskSessionHealth(
  taskId: string,
  providers?: TaskSessionHealthProviders,
  nowMs?: number
): Promise<TaskSessionHealthSnapshot> {
  const now = nowMs ?? Date.now();

  const rows = queryAll<TaskSessionHealthRow>(
    `SELECT
       s.id, s.agent_id, s.openclaw_session_id, s.status, s.session_type,
       s.total_tokens, s.context_tokens, s.run_number, s.file_size_bytes,
       s.rotated_from, s.rotation_reason, s.created_at, s.updated_at, s.ended_at,
       a.name AS agent_name,
       a.avatar_emoji AS agent_avatar_emoji,
       a.session_key_prefix AS agent_session_key_prefix
     FROM openclaw_sessions s
     LEFT JOIN agents a ON s.agent_id = a.id
     WHERE s.task_id = ? AND s.session_type IN ('subagent', 'persistent')
     ORDER BY s.created_at DESC`,
    [taskId]
  );

  // ── gateway enrichment (best-effort) ──
  let gatewaySessions: GatewaySessionInfo[] = [];
  let gatewayReachable = true;
  try {
    gatewaySessions = (await providers?.listGatewaySessions?.()) ?? [];
  } catch {
    gatewayReachable = false;
  }

  // Live transcript for the LATEST session: fresh file size + corruption scan.
  let liveHistory: unknown[] | null = null;
  let liveHistoryKey: string | null = null;
  const latest = rows[0];
  if (latest) {
    const latestKey = latest.agent_session_key_prefix
      ? `${latest.agent_session_key_prefix}${latest.openclaw_session_id}`
      : latest.openclaw_session_id;
    try {
      const history = await providers?.getHistory?.(latestKey);
      if (Array.isArray(history) && history.length > 0) {
        liveHistory = history;
        liveHistoryKey = latestKey;
      }
    } catch {
      // best-effort — history may fail for never-used keys
    }
  }

  const config = resolveSessionHealthConfig();
  const liveFileSize = liveHistory ? estimateFileSizeFromHistory(liveHistory) : null;
  const liveCorruption = liveHistory ? detectSessionCorruptionMarkers(liveHistory as Array<{ role?: string; content?: unknown }>) : null;

  const sessions: SessionHealthCardData[] = rows.map(row => {
    const gatewayInfo = findGatewayRow(gatewaySessions, row);
    const isLive = liveHistoryKey !== null &&
      (gatewayInfo?.key?.endsWith(row.openclaw_session_id) || row.openclaw_session_id === latest?.openclaw_session_id);
    const corruptionMarkers = isLive ? liveCorruption : null;

    const verdict = evaluateSessionHealth({
      dbSession: row as any,
      gatewayInfo,
      estimatedContextTokens: null,
      contextWindow: null,
      config,
      corruptionMarkers,
    });

    return {
      id: row.id,
      sessionId: row.openclaw_session_id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      agentAvatarEmoji: row.agent_avatar_emoji,
      runNumber: row.run_number ?? 1,
      status: row.status,
      health: deriveSessionHealthState(verdict, config),
      healthReasons: verdict.reasons,
      ageSeconds: ageSeconds(row.created_at, row.ended_at, now),
      totalTokens: verdict.totalTokens,
      contextTokens: verdict.contextTokens,
      ctxPct: verdict.ctxPct,
      fileSizeBytes: isLive && liveFileSize !== null ? liveFileSize : row.file_size_bytes ?? null,
      corruptionMarker: verdict.corruptionMarker,
      rotatedFrom: row.rotated_from,
      rotationReason: row.rotation_reason,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    };
  });

  const rotations: SessionRotationInfo[] = rows
    // Rotation HISTORY = superseded sessions only. The current active session
    // carries `rotated_from` as a pointer, but it is not itself a rotation.
    .filter(r => r.status === 'rotated' || (r.rotated_from !== null && r.status !== 'active' && r.status !== 'completed'))
    .map(r => ({
      sessionId: r.openclaw_session_id,
      agentName: r.agent_name,
      runNumber: r.run_number ?? 1,
      reason: r.rotation_reason || `status:${r.status}`,
      rotatedAt: r.updated_at ?? r.created_at,
    }));

  const activityRows = queryAll<{ activity_type: string; message: string; created_at: string }>(
    `SELECT activity_type, message, created_at
     FROM task_activities
     WHERE task_id = ? AND activity_type IN (${HEALTH_ALERT_TYPES.map(() => '?').join(',')})
     ORDER BY created_at DESC
     LIMIT 10`,
    [taskId, ...HEALTH_ALERT_TYPES]
  );

  const alerts: SessionAlertInfo[] = activityRows.map(a => ({
    activityType: a.activity_type,
    message: a.message,
    createdAt: a.created_at,
  }));

  return {
    taskId,
    generatedAt: new Date(now).toISOString(),
    gatewayReachable,
    sessions,
    rotations,
    alerts,
  };
}
