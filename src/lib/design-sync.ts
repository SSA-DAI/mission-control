/**
 * AWANFLEET Open Design — design sync state + concurrency helpers.
 *
 * State machine (work item §9):
 *   NO_DESIGN → DRAFT → DESIGN_READY → IMPLEMENTATION_PENDING → IMPLEMENTING
 *     → TESTING → REVIEWING → SYNCED
 *   DESIGN_DRIFT: authority advanced beyond implemented version.
 *   BLOCKED: any blocking failure.
 *
 * Core invariant: SYNCED ⟺ (Open Design current authority == Git implemented == Dev deployed).
 *
 * Concurrency (work item §18):
 *   global max design jobs: 10
 *   per-project mutating design jobs: 1
 *   read-only analysis may run concurrently.
 */
import { getDb } from '@/lib/db';

export const DESIGN_SYNC_STATES = [
  'NO_DESIGN', 'DRAFT', 'DESIGN_READY', 'IMPLEMENTATION_PENDING', 'IMPLEMENTING',
  'TESTING', 'REVIEWING', 'SYNCED', 'DESIGN_DRIFT', 'BLOCKED',
] as const;
export type DesignSyncState = typeof DESIGN_SYNC_STATES[number];

export const FRONTEND_WORK_ITEM_TYPES = [
  'FRONTEND_DESIGN_CREATE', 'FRONTEND_DESIGN_REVISION', 'FRONTEND_IMPLEMENTATION', 'FRONTEND_DESIGN_SYNC',
] as const;
export type FrontendWorkItemType = typeof FRONTEND_WORK_ITEM_TYPES[number];

// Concurrency controls (configurable via env; defaults per work item §18)
const GLOBAL_MAX_DESIGN_JOBS = parseInt(process.env.OD_GLOBAL_MAX_DESIGN_JOBS || '10', 10);
const PER_PROJECT_MUTATING = 1;

interface DesignJob {
  taskId: string;
  autensaWorkspaceId: string;
  openDesignProjectId: string;
  type: FrontendWorkItemType;
  mutating: boolean;
}

/**
 * Acquire a design job slot. Returns { ok: true } or { ok: false, reason }.
 * Mutating design jobs: at most PER_PROJECT_MUTATING per open-design project AND
 * at most GLOBAL_MAX_DESIGN_JOBS across all projects.
 * Read-only analysis jobs: only the global cap applies (may run concurrently).
 */
export function acquireDesignJobSlot(job: DesignJob): { ok: boolean; reason?: string } {
  const db = getDb();
  const now = Date.now();

  // Count in-flight (non-terminal) design jobs from tasks metadata.
  const activeRows = db.prepare(
    `SELECT metadata FROM tasks
     WHERE metadata LIKE '%"frontend_work_item_type"%'
       AND status NOT IN ('done','inbox','menunggu_keputusan_manusia')`
  ).all() as { metadata: string | null }[];

  let globalActive = 0;
  let projectMutating = 0;

  for (const row of activeRows) {
    if (!row.metadata) continue;
    try {
      const meta = JSON.parse(row.metadata);
      if (!meta.frontend_work_item_type) continue;
      const isMutating = meta.frontend_work_item_type !== 'FRONTEND_DESIGN_SYNC_READONLY' &&
        ['FRONTEND_DESIGN_CREATE','FRONTEND_DESIGN_REVISION','FRONTEND_IMPLEMENTATION','FRONTEND_DESIGN_SYNC']
          .includes(meta.frontend_work_item_type);
      globalActive += 1;
      if (isMutating && meta.open_design_project_id === job.openDesignProjectId) {
        projectMutating += 1;
      }
    } catch {
      // malformed metadata — skip
    }
  }

  if (globalActive >= GLOBAL_MAX_DESIGN_JOBS) {
    return { ok: false, reason: `global design job cap reached (${GLOBAL_MAX_DESIGN_JOBS})` };
  }
  if (job.mutating && projectMutating >= PER_PROJECT_MUTATING) {
    return { ok: false, reason: `per-project mutating design job already active for ${job.openDesignProjectId}` };
  }
  return { ok: true };
}

/**
 * Transition a workspace's design sync state with validation.
 * Returns the new row.
 */
export function transitionDesignSyncState(
  autensaWorkspaceId: string,
  next: DesignSyncState,
  opts?: {
    currentDesignVersion?: string;
    implementedDesignVersion?: string;
    gitCommit?: string;
    developmentDeployment?: string;
    workItemId?: string;
    isImplementation?: boolean;
  }
) {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM frontend_design_authority WHERE autensa_workspace_id = ?'
  ).get(autensaWorkspaceId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`OPEN_DESIGN_PROJECT_NOT_BOUND: no binding for workspace ${autensaWorkspaceId}`);
  }
  if (!DESIGN_SYNC_STATES.includes(next)) {
    throw new Error(`DESIGN_RESULT_INVALID: unknown sync state ${next}`);
  }

  const updates: string[] = ['sync_state = ?', "updated_at = datetime('now')"];
  const values: unknown[] = [next];

  if (opts?.currentDesignVersion !== undefined) { updates.push('current_design_version = ?'); values.push(opts.currentDesignVersion); }
  if (opts?.implementedDesignVersion !== undefined) { updates.push('implemented_design_version = ?'); values.push(opts.implementedDesignVersion); }
  if (opts?.gitCommit !== undefined) { updates.push('git_commit = ?'); values.push(opts.gitCommit); }
  if (opts?.developmentDeployment !== undefined) { updates.push('development_deployment = ?'); values.push(opts.developmentDeployment); }
  if (opts?.workItemId !== undefined) {
    updates.push(opts.isImplementation ? 'latest_implementation_work_item = ?' : 'latest_design_work_item = ?');
    values.push(opts.workItemId);
  }

  values.push(autensaWorkspaceId);
  db.prepare(`UPDATE frontend_design_authority SET ${updates.join(', ')} WHERE autensa_workspace_id = ?`).run(...values);

  return db.prepare('SELECT * FROM frontend_design_authority WHERE autensa_workspace_id = ?').get(autensaWorkspaceId);
}

/**
 * Compute sync state from the three-way invariant.
 * Invariant (work item §9): OpenDesign authority == Git implemented == Dev deployed ⟹ SYNCED.
 * If authority advanced beyond implemented ⟹ DESIGN_DRIFT.
 */
export function computeDesignSyncState(opts: {
  authorityVersion?: string | null;
  implementedVersion?: string | null;
  developmentDeployment?: string | null;
}): DesignSyncState {
  const { authorityVersion, implementedVersion, developmentDeployment } = opts;
  if (!authorityVersion) return 'NO_DESIGN';
  if (!implementedVersion) return 'DESIGN_READY';
  if (authorityVersion !== implementedVersion) return 'DESIGN_DRIFT';
  if (!developmentDeployment) return 'IMPLEMENTATION_PENDING';
  return 'SYNCED';
}

/** Parse task metadata JSON safely. */
export function taskMetadata(task: { metadata?: string | null }): Record<string, unknown> {
  if (!task.metadata) return {};
  try {
    return JSON.parse(task.metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const DESIGN_CONCURRENCY = {
  globalMax: GLOBAL_MAX_DESIGN_JOBS,
  perProjectMutating: PER_PROJECT_MUTATING,
};
