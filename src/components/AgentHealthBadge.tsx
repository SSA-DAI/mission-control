'use client';

import { useEffect, useState } from 'react';
import type { SemanticAgentHealthState, AgentActiveTask } from '@/lib/types';

interface AgentHealthBadgeProps {
  displayState: SemanticAgentHealthState;
  reason?: string;
  activeTask?: AgentActiveTask;
  lastActivityAt?: string;
  size?: 'sm' | 'md';
}

/** Color palette per display_state — matches HealthIndicator. */
const stateColors: Record<string, { bg: string; text: string; border: string; label: string }> = {
  idle:                 { bg: 'bg-gray-500/20',     text: 'text-gray-400',      border: 'border-gray-500/30',  label: 'Idle' },
  active_recently:      { bg: 'bg-green-500/20',    text: 'text-green-400',     border: 'border-green-500/30', label: 'Active' },
  working_silently:     { bg: 'bg-cyan-500/20',     text: 'text-cyan-400',      border: 'border-cyan-500/30',  label: 'Working silently' },
  awaiting_reply:       { bg: 'bg-blue-500/20',     text: 'text-blue-400',      border: 'border-blue-500/30',  label: 'Awaiting reply' },
  waiting_for_delivery: { bg: 'bg-amber-500/20',    text: 'text-amber-400',     border: 'border-amber-500/30', label: 'Chat queued' },
  completed_not_surfaced:{ bg: 'bg-amber-500/20',   text: 'text-amber-400',     border: 'border-amber-500/30', label: 'Completed hidden' },
  needs_attention:      { bg: 'bg-yellow-500/20',   text: 'text-yellow-400',    border: 'border-yellow-500/30',label: 'Needs attention' },
  no_heartbeat:         { bg: 'bg-red-500/20',      text: 'text-red-400',       border: 'border-red-500/30',   label: 'No session' },
  genuinely_stuck:      { bg: 'bg-red-500/20',      text: 'text-red-400',       border: 'border-red-500/30',   label: 'Stuck' },
  blocked:              { bg: 'bg-red-500/20',      text: 'text-red-400',       border: 'border-red-500/30',   label: 'Blocked' },
  offline:              { bg: 'bg-gray-600/30',     text: 'text-gray-500',      border: 'border-gray-600/40',  label: 'Offline' },
};

function relativeTime(iso?: string): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function AgentHealthBadge({
  displayState,
  reason,
  activeTask,
  lastActivityAt,
  size = 'sm',
}: AgentHealthBadgeProps) {
  const [now, setNow] = useState(Date.now());
  const config = stateColors[displayState] || stateColors.idle;
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs';

  useEffect(() => {
    // Re-render relative timestamps every 30s
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const tooltip = [reason, activeTask ? `Task: ${activeTask.title} (${activeTask.status})` : null, lastActivityAt ? `Last activity: ${relativeTime(lastActivityAt)}` : null]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      className={`inline-flex items-center gap-1.5 ${textSize} ${config.bg} ${config.text} ${config.border} border rounded-full px-2 py-0.5`}
      title={tooltip}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.text.replace('text-', 'bg-')}`} />
      <span className="uppercase tracking-wide font-medium">{config.label}</span>
      {lastActivityAt && (
        <span className="opacity-60 ml-0.5">{relativeTime(lastActivityAt)}</span>
      )}
    </div>
  );
}

export { stateColors };
export type { AgentHealthBadgeProps };
