/**
 * AWANFLEET Open Design — Frontend Authority status card (work item §22).
 *
 * Minimal bounded extension to the workspace view: shows the Open Design
 * binding + sync state for the current workspace. Read-only; all mutation
 * happens through the adapter / API.
 */
import { useEffect, useState } from 'react';

interface FrontendAuthority {
  autensa_workspace_id: string;
  provider: string | null;
  open_design_project_id: string | null;
  sync_state: string;
  current_design_version: string | null;
  implemented_design_version: string | null;
  git_commit: string | null;
  development_deployment: string | null;
  latest_design_work_item: string | null;
  latest_implementation_work_item: string | null;
}

const SYNC_STATE_COLORS: Record<string, string> = {
  NO_DESIGN: 'bg-mc-bg-secondary text-mc-text-secondary border-mc-border',
  DRAFT: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  DESIGN_READY: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
  IMPLEMENTATION_PENDING: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
  IMPLEMENTING: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
  TESTING: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
  REVIEWING: 'bg-violet-500/10 text-violet-400 border-violet-500/30',
  SYNCED: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  DESIGN_DRIFT: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  BLOCKED: 'bg-red-500/10 text-red-400 border-red-500/30',
};

export function FrontendAuthorityCard({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<FrontendAuthority | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/frontend-authority?workspace=${encodeURIComponent(workspaceId)}`);
        if (res.ok) {
          const json = await res.json();
          if (!cancelled) setData(json);
        } else if (!cancelled) {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (error) return null; // silent — non-critical UI
  if (!data) return null;

  const state = data.sync_state || 'NO_DESIGN';
  const color = SYNC_STATE_COLORS[state] || SYNC_STATE_COLORS.NO_DESIGN;

  const synced =
    data.sync_state === 'SYNCED' ||
    (data.current_design_version &&
      data.current_design_version === data.implemented_design_version &&
      data.development_deployment);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-mc-border bg-mc-bg-secondary/60 px-3 py-2 text-xs">
      <div className="flex flex-col">
        <span className="text-mc-text-secondary">Frontend Authority</span>
        <span className={`mt-0.5 inline-flex w-fit items-center rounded-md border px-1.5 py-0.5 font-medium ${color}`}>
          {state}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 text-mc-text-secondary">
        {data.provider && <span>provider: {data.provider}</span>}
        {data.open_design_project_id && <span className="font-mono">{data.open_design_project_id}</span>}
        {data.current_design_version && (
          <span>design: <span className="font-mono">{data.current_design_version}</span></span>
        )}
        {data.implemented_design_version && (
          <span>impl: <span className="font-mono">{data.implemented_design_version}</span></span>
        )}
        {data.development_deployment && <span>dev: {data.development_deployment}</span>}
        {!data.open_design_project_id && <span>not bound</span>}
      </div>
    </div>
  );
}
