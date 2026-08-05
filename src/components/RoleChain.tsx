'use client';

/**
 * PLATFORM-004b: handshake role chain renderer.
 * Renders main → builder → tester → reviewer → verifier → (learner hook) with
 * a per-role status badge. `compact` is used on kanban task cards, `full` in
 * the task modal.
 */

import type { RoleChainNode } from '@/lib/types';

const STATUS_DOT: Record<RoleChainNode['status'], string> = {
  done: 'bg-mc-accent-green',
  active: 'bg-mc-accent-yellow animate-pulse',
  pending: 'bg-mc-text-secondary/40',
  failed: 'bg-mc-accent-red',
};

const STATUS_LABEL: Record<RoleChainNode['status'], string> = {
  done: 'done',
  active: 'active',
  pending: 'pending',
  failed: 'failed',
};

const STATUS_TEXT: Record<RoleChainNode['status'], string> = {
  done: 'text-mc-accent-green',
  active: 'text-mc-accent-yellow',
  pending: 'text-mc-text-secondary',
  failed: 'text-mc-accent-red',
};

interface RoleChainProps {
  chain?: RoleChainNode[] | null;
  knowledgeCount?: number;
  variant?: 'compact' | 'full';
  className?: string;
}

export function RoleChain({ chain, knowledgeCount = 0, variant = 'compact', className = '' }: RoleChainProps) {
  if (!chain || chain.length === 0) return null;

  if (variant === 'compact') {
    return (
      <div className={`flex items-center gap-1 flex-wrap ${className}`} title={chain.map(n => `${n.label} (${n.agentName || n.role}): ${STATUS_LABEL[n.status]}`).join(' · ')}>
        {chain.map((node, i) => (
          <span key={node.role} className="inline-flex items-center gap-1">
            {i > 0 && <span className="text-mc-text-secondary/40 text-[9px]">→</span>}
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-mc-bg-tertiary/60 border border-mc-border/40" title={`${node.label}${node.agentName ? ` — ${node.agentName}` : ''}: ${STATUS_LABEL[node.status]}`}>
              <span className="text-[11px] leading-none">{node.emoji}</span>
              <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[node.status]}`} />
              {node.role === 'learner' && knowledgeCount > 0 && (
                <span className="text-[9px] text-mc-text-secondary font-medium">{knowledgeCount}</span>
              )}
            </span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className={`space-y-1.5 ${className}`}>
      {chain.map((node, i) => (
        <div key={node.role} className="flex items-center gap-2">
          <div className="flex flex-col items-center">
            <span className={`w-2 h-2 rounded-full ${STATUS_DOT[node.status]}`} />
            {i < chain.length - 1 && <span className="w-px h-2 bg-mc-border/60" />}
          </div>
          <span className="text-sm w-6 text-center">{node.emoji}</span>
          <span className="text-sm font-medium text-mc-text w-24 flex-shrink-0">{node.label}</span>
          <span className={`text-xs flex-1 truncate ${STATUS_TEXT[node.status]}`}>
            {node.agentName || (node.role === 'learner' ? 'hook' : '—')}
          </span>
          <span className={`text-[10px] uppercase tracking-wide ${STATUS_TEXT[node.status]}`}>{STATUS_LABEL[node.status]}</span>
          {node.role === 'learner' && knowledgeCount > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 bg-mc-accent-green/10 text-mc-accent-green rounded border border-mc-accent-green/30">
              {knowledgeCount} knowledge
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
