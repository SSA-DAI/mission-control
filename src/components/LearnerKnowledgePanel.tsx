'use client';

/**
 * PLATFORM-004b: learner knowledge panel — lists knowledge entries written for
 * a task (the learner gate evidence). Used in the task modal overview.
 */

import { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface KnowledgeEntry {
  id: string;
  task_id: string | null;
  category: string;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  created_at: string;
}

interface LearnerKnowledgePanelProps {
  taskId: string;
  workspaceId: string;
}

const CATEGORY_EMOJI: Record<string, string> = {
  failure: '❌',
  fix: '🛠️',
  pattern: '🔁',
  checklist: '📋',
};

export function LearnerKnowledgePanel({ taskId, workspaceId }: LearnerKnowledgePanelProps) {
  const [entries, setEntries] = useState<KnowledgeEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/knowledge?task_id=${encodeURIComponent(taskId)}`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: KnowledgeEntry[]) => {
        if (!cancelled) setEntries(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, workspaceId]);

  return (
    <div className="p-3 bg-mc-bg rounded-lg border border-mc-border">
      <h4 className="text-sm font-medium text-mc-text mb-2 flex items-center gap-2">
        <BookOpen className="w-4 h-4 text-mc-accent" />
        Learner Knowledge
        {entries && entries.length > 0 && (
          <span className="text-xs px-1.5 py-0.5 bg-mc-accent-green/10 text-mc-accent-green rounded border border-mc-accent-green/30">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'} — gate satisfied
          </span>
        )}
      </h4>

      {entries === null ? (
        <p className="text-xs text-mc-text-secondary">Loading...</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-mc-text-secondary">
          {taskId ? 'No knowledge entries yet. The learner gate keeps this task from reaching done until the Learner writes ≥1 entry.' : 'No knowledge entries for this task.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li key={e.id} className="p-2 bg-mc-bg-tertiary/60 rounded border border-mc-border/40">
              <div className="flex items-center gap-2">
                <span className="text-sm">{CATEGORY_EMOJI[e.category] || '📝'}</span>
                <span className="text-xs font-medium text-mc-text flex-1 truncate" title={e.title}>
                  {e.title}
                </span>
                <span className="text-[10px] text-mc-text-secondary whitespace-nowrap">
                  {(e.confidence * 100).toFixed(0)}% · {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                </span>
              </div>
              <p className="text-[11px] text-mc-text-secondary mt-1 line-clamp-2">{e.content}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
