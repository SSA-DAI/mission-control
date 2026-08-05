/**
 * SessionsList Component
 * Displays OpenClaw sub-agent + pipeline sessions for a task.
 *
 * PLATFORM-008 (D1): honest token metrics — "Kumulatif run" (cumulative
 * totalTokens) is displayed separately from live context; rotation and token
 * warnings are surfaced with a suggested rotation action.
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { Bot, CheckCircle, Circle, XCircle, Trash2, Check, AlertTriangle, RefreshCw } from 'lucide-react';

interface SessionWithAgent {
  id: string;
  agent_id: string | null;
  openclaw_session_id: string;
  channel: string | null;
  status: string;
  session_type: string;
  task_id: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  total_tokens?: number | null;
  context_tokens?: number | null;
  run_number?: number | null;
  rotated_from?: string | null;
  rotation_reason?: string | null;
  agent_name?: string;
  agent_avatar_emoji?: string;
}

interface SessionActivity {
  activity_type: string;
  message: string;
  created_at: string;
}

interface SessionsListProps {
  taskId: string;
}

function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function SessionsList({ taskId }: SessionsListProps) {
  const [sessions, setSessions] = useState<SessionWithAgent[]>([]);
  const [warnings, setWarnings] = useState<SessionActivity[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/subagent`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
      const actRes = await fetch(`/api/tasks/${taskId}/activities`);
      if (actRes.ok) {
        const acts: SessionActivity[] = await actRes.json();
        setWarnings(
          acts.filter(
            (a) =>
              a.activity_type === 'session_token_warning' ||
              a.activity_type === 'session_rotated'
          ).slice(0, 5)
        );
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'active':
        return <Circle className="w-4 h-4 text-green-500 fill-current animate-pulse" />;
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-mc-accent" />;
      case 'rotated':
        return <RefreshCw className="w-4 h-4 text-amber-500" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-500" />;
      default:
        return <Circle className="w-4 h-4 text-mc-text-secondary" />;
    }
  };

  const formatDuration = (start: string, end?: string | null) => {
    const startTime = new Date(start).getTime();
    const endTime = end ? new Date(end).getTime() : Date.now();
    const duration = endTime - startTime;

    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  const handleMarkComplete = async (sessionId: string) => {
    try {
      const res = await fetch(`/api/openclaw/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          ended_at: new Date().toISOString(),
        }),
      });
      if (res.ok) {
        loadSessions();
      }
    } catch (error) {
      console.error('Failed to mark session complete:', error);
    }
  };

  const handleDelete = async (sessionId: string) => {
    if (!confirm('Delete this sub-agent session?')) return;
    try {
      const res = await fetch(`/api/openclaw/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        loadSessions();
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-mc-text-secondary">Loading sessions...</div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-mc-text-secondary">
        <div className="text-4xl mb-2">🤖</div>
        <p>No sub-agent sessions yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* PLATFORM-008 (A2): token / rotation warnings */}
      {warnings.length > 0 && (
        <div className="p-3 bg-amber-500/10 border border-amber-500/40 rounded-lg space-y-1">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 text-sm text-amber-300">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                {w.message}{' '}
                <span className="text-amber-400/70">
                  (rotation suggested — a fresh session key prevents re-injecting old context)
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      {sessions.map((session) => (
        <div
          key={session.id}
          className="flex gap-3 p-3 bg-mc-bg rounded-lg border border-mc-border"
        >
          {/* Agent Avatar */}
          <div className="flex-shrink-0">
            {session.agent_avatar_emoji ? (
              <span className="text-2xl">{session.agent_avatar_emoji}</span>
            ) : (
              <Bot className="w-8 h-8 text-mc-accent" />
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Agent name and status */}
            <div className="flex items-center gap-2 mb-1">
              {getStatusIcon(session.status)}
              <span className="font-medium text-mc-text">
                {session.agent_name || 'Sub-Agent'}
              </span>
              <span className="text-xs text-mc-text-secondary capitalize">
                {session.status}
              </span>
              {session.run_number && session.run_number > 1 && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-mc-bg-tertiary text-mc-text-secondary">
                  run #{session.run_number}
                </span>
              )}
            </div>

            {/* Session ID */}
            <div className="text-xs text-mc-text-secondary font-mono mb-2 truncate">
              Session: {session.openclaw_session_id}
            </div>

            {/* PLATFORM-008 (D1): honest token metrics — cumulative run shown
                separately from live context. */}
            {(session.total_tokens || session.context_tokens) ? (
              <div className="flex items-center gap-3 text-xs mb-1">
                <span className="px-1.5 py-0.5 rounded bg-mc-bg-tertiary">
                  Kumulatif run: <span className="font-mono text-mc-text">{formatTokens(session.total_tokens)} tok</span>
                </span>
                <span className="px-1.5 py-0.5 rounded bg-mc-bg-tertiary">
                  Ctx hidup: <span className="font-mono text-mc-text">{session.context_tokens ? `${formatTokens(session.context_tokens)} tok` : 'n/a'}</span>
                </span>
              </div>
            ) : null}

            {/* Rotation reason */}
            {session.status === 'rotated' && session.rotation_reason && (
              <div className="text-xs text-amber-400 mb-1 truncate" title={session.rotation_reason}>
                Rotated: {session.rotation_reason}
              </div>
            )}

            {/* Duration and timestamps */}
            <div className="flex items-center gap-3 text-xs text-mc-text-secondary">
              <span>
                Duration: {formatDuration(session.created_at, session.ended_at)}
              </span>
              <span>•</span>
              <span>Started {formatTimestamp(session.created_at)}</span>
            </div>

            {/* Channel */}
            {session.channel && (
              <div className="mt-2 text-xs text-mc-text-secondary">
                Channel: <span className="font-mono">{session.channel}</span>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col gap-1">
            {session.status === 'active' && (
              <button
                onClick={() => handleMarkComplete(session.openclaw_session_id)}
                className="p-1.5 hover:bg-mc-bg-tertiary rounded text-green-500"
                title="Mark as complete"
              >
                <Check className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => handleDelete(session.openclaw_session_id)}
              className="p-1.5 hover:bg-mc-bg-tertiary rounded text-red-500"
              title="Delete session"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
