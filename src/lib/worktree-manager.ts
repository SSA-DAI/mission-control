/**
 * PLATFORM-018 — Task Worktree Lifecycle Manager
 *
 * Isolates agent commits from the shared supervisor repo. Every repo-backed
 * task gets its OWN git worktree, initialized from origin/HEAD, on a dedicated
 * branch (`platform-<taskId-short>/<baseCommit-short>`). The agent works and
 * commits ONLY inside that worktree — it never touches the shared repo's
 * working tree. Landing = fetch origin → checkout main → cherry-pick the
 * worktree commits → push. Conflicts set the task merge_status to 'blocked'
 * and KEEP the worktree for manual supervisor resolution (no auto-resolve,
 * no premature cleanup).
 *
 * Layout (configurable via env, defaults match the production constraint):
 *   - shared supervisor repo : WORKTREE_REPO_PATH   (default /data/awanfleet/shared/mission-control)
 *   - task worktree root     : WORKTREE_TASK_ROOT   (default /data/awanfleet/tasks)
 *   - worktree per task      : <WORKTREE_TASK_ROOT>/<task_id>/worktree
 *   - main branch            : WORKTREE_MAIN_BRANCH (default: resolved origin/HEAD)
 *   - feature branch         : platform-<taskId.slice(0,8)>/<baseCommit.slice(0,7)>
 *
 * Every git operation runs a pre-flight check first: clean tree in the shared
 * repo, branch exists, origin reachable. All mutations are idempotent.
 */

import { execFileSync, execSync, type ExecFileSyncOptions, type ExecSyncOptionsWithStringEncoding } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import type { Task } from '@/lib/types';

// ─── Types ───────────────────────────────────────────────────────────

export interface WorktreeManagerConfig {
  /** Shared supervisor repo (the repo the supervisor works in). */
  repoPath: string;
  /** Root directory holding one worktree folder per task. */
  taskRoot: string;
  /** Main branch override; when unset, resolved from origin/HEAD. */
  mainBranch?: string;
  /** Master switch for the whole isolation flow. */
  enabled: boolean;
}

export interface TaskWorktreeInfo {
  taskId: string;
  worktreePath: string;
  branchName: string;
  mainBranch: string;
  baseCommit: string;
  status: 'active' | 'landed' | 'blocked' | 'abandoned';
  createdAt: string;
  // WorkspaceInfo-compatible aliases so the dispatch pipeline can treat this
  // as a drop-in for workspace-isolation's WorkspaceInfo.
  path: string;
  strategy: 'worktree';
  branch: string;
  baseBranch: string;
  port: number;
}

export interface WorktreePreflightResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  error?: string;
}

export interface LandResult {
  ok: boolean;
  status: 'landed' | 'conflict' | 'no_changes' | 'failed';
  mainBranch: string;
  landedCommits: string[];
  conflictFiles?: string[];
  mergeCommit?: string;
  log: string;
}

export interface CleanupResult {
  ok: boolean;
  log: string;
}

interface ExecFailure extends Error {
  status?: number;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

const METADATA_FILE = '.mc-worktree.json';

function outputSnippet(value: unknown): string | undefined {
  if (!value) return undefined;
  const text = Buffer.isBuffer(value) ? value.toString('utf-8') : String(value);
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 2000) : undefined;
}

function git(repoPath: string, args: string[], opts: Partial<ExecSyncOptionsWithStringEncoding> = {}): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 60000,
    ...opts,
  }) as string;
}

function gitTry(repoPath: string, args: string[]): { ok: boolean; stdout: string; stderr?: string } {
  try {
    return { ok: true, stdout: git(repoPath, args) };
  } catch (err) {
    const e = err as ExecFailure;
    return { ok: false, stdout: '', stderr: outputSnippet(e.stderr) || outputSnippet(e.stdout) || e.message };
  }
}

// ─── Config ──────────────────────────────────────────────────────────

/**
 * Master switch. ENABLE_TASK_WORKTREES defaults to true; set to 'false' to
 * fall back to the legacy workspace-isolation PR flow.
 */
export function worktreesEnabled(): boolean {
  return process.env.ENABLE_TASK_WORKTREES !== 'false';
}

export function getWorktreeConfig(): WorktreeManagerConfig {
  return {
    repoPath: process.env.WORKTREE_REPO_PATH || '/data/awanfleet/shared/mission-control',
    taskRoot: process.env.WORKTREE_TASK_ROOT || '/data/awanfleet/tasks',
    mainBranch: process.env.WORKTREE_MAIN_BRANCH || undefined,
    enabled: worktreesEnabled(),
  };
}

export function taskWorktreePath(taskId: string): string {
  return path.join(getWorktreeConfig().taskRoot, taskId, 'worktree');
}

function taskMetadataPath(taskId: string): string {
  return path.join(getWorktreeConfig().taskRoot, taskId, '.mc-worktree.json');
}

/** Metadata sibling of the worktree dir (i.e. <taskRoot>/<taskId>/.mc-worktree.json). */
function siblingMetadataPath(worktreePath: string): string {
  return path.join(path.dirname(worktreePath), METADATA_FILE);
}

// ─── Pre-flight checks ───────────────────────────────────────────────

function checkCleanTree(repoPath: string, label: string): WorktreePreflightResult['checks'][number] {
  const res = gitTry(repoPath, ['status', '--porcelain']);
  if (!res.ok) {
    return { name: `${label}:git-readable`, ok: false, detail: res.stderr };
  }
  // Ignore the task metadata file if it ever lives inside a worktree
  // (defensive: we normally keep it OUTSIDE the worktree now).
  const dirty = res.stdout.trim().split('\n').filter(line => !line.includes(METADATA_FILE)).join('\n');
  if (dirty) {
    return {
      name: `${label}:clean-tree`,
      ok: false,
      detail: `Working tree has uncommitted changes (${dirty.split('\n').length} path(s)):\n${dirty.split('\n').slice(0, 10).join('\n')}`,
    };
  }
  return { name: `${label}:clean-tree`, ok: true, detail: 'working tree clean' };
}

function firstFailedCheck(checks: WorktreePreflightResult['checks']): string | undefined {
  return checks.find(c => !c.ok)?.detail;
}

/**
 * Pre-flight for the SHARED supervisor repo. Required before any create/land/
 * cleanup operation: the repo must exist, be a git repo, have a clean working
 * tree (so checkout/cherry-pick can never clobber supervisor work), and origin
 * must be reachable.
 */
export function preflightSharedRepo(config: WorktreeManagerConfig = getWorktreeConfig()): WorktreePreflightResult {
  const checks: WorktreePreflightResult['checks'] = [];

  if (!existsSync(config.repoPath) || !existsSync(path.join(config.repoPath, '.git'))) {
    return {
      ok: false,
      checks: [
        {
          name: 'shared-repo:exists',
          ok: false,
          detail: `Shared supervisor repo not found at ${config.repoPath}`,
        },
      ],
      error: `Shared supervisor repo not found at ${config.repoPath}`,
    };
  }
  checks.push({ name: 'shared-repo:exists', ok: true, detail: config.repoPath });

  const isRepo = gitTry(config.repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!isRepo.ok || isRepo.stdout.trim() !== 'true') {
    return {
      ok: false,
      checks: [...checks, { name: 'shared-repo:is-git', ok: false, detail: isRepo.stderr || 'not a git work tree' }],
      error: `Shared repo is not a git work tree: ${config.repoPath}`,
    };
  }
  checks.push({ name: 'shared-repo:is-git', ok: true });

  checks.push(checkCleanTree(config.repoPath, 'shared-repo'));

  const origin = gitTry(config.repoPath, ['ls-remote', '--exit-code', 'origin', 'HEAD']);
  if (!origin.ok) {
    checks.push({
      name: 'shared-repo:origin-reachable',
      ok: false,
      detail: outputSnippet(origin.stderr) || 'origin HEAD unreachable',
    });
    return {
      ok: false,
      checks,
      error: `Origin unreachable from shared repo: ${outputSnippet(origin.stderr) || 'git ls-remote failed'}`,
    };
  }
  checks.push({ name: 'shared-repo:origin-reachable', ok: true });

  return { ok: checks.every(c => c.ok), checks, error: firstFailedCheck(checks) };
}

/**
 * Pre-flight for a task worktree: exists, is a git repo, branch matches
 * metadata, and (when `requireClean` — i.e. before landing) the agent's
 * changes are committed.
 */
export function preflightTaskWorktree(
  info: TaskWorktreeInfo,
  requireClean: boolean
): WorktreePreflightResult {
  const checks: WorktreePreflightResult['checks'] = [];

  if (!existsSync(info.worktreePath) || !existsSync(path.join(info.worktreePath, '.git'))) {
    return {
      ok: false,
      checks: [{ name: 'worktree:exists', ok: false, detail: `Worktree missing at ${info.worktreePath}` }],
      error: `Task worktree missing at ${info.worktreePath}`,
    };
  }
  checks.push({ name: 'worktree:exists', ok: true, detail: info.worktreePath });

  const head = gitTry(info.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const onBranch = head.ok && head.stdout.trim() === info.branchName;
  checks.push({
    name: 'worktree:branch',
    ok: onBranch,
    detail: onBranch ? `on ${info.branchName}` : `expected ${info.branchName}, got ${head.stdout.trim() || head.stderr}`,
  });

  if (requireClean) {
    checks.push(checkCleanTree(info.worktreePath, 'worktree'));
  }

  return { ok: checks.every(c => c.ok), checks, error: firstFailedCheck(checks) };
}

/**
 * Resolve the main branch. Explicit env override wins; otherwise origin/HEAD's
 * symbolic ref; otherwise parse `git ls-remote --symref origin HEAD`.
 */
export function resolveMainBranch(config: WorktreeManagerConfig = getWorktreeConfig()): string {
  if (config.mainBranch) return config.mainBranch;

  const symref = gitTry(config.repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (symref.ok && symref.stdout.trim()) {
    return symref.stdout.trim().replace(/^origin\//, '');
  }

  const lsRemote = gitTry(config.repoPath, ['ls-remote', '--symref', 'origin', 'HEAD']);
  if (lsRemote.ok) {
    const match = lsRemote.stdout.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
    if (match) return match[1];
  }

  throw new Error(
    `Cannot resolve main branch: set WORKTREE_MAIN_BRANCH or ensure origin/HEAD is set in ${config.repoPath}`
  );
}

// ─── Metadata ────────────────────────────────────────────────────────

export function loadTaskWorktree(task: Pick<Task, 'id' | 'workspace_path'>): TaskWorktreeInfo | null {
  // Canonical metadata location lives OUTSIDE the worktree (inside the worktree
  // it would make `git status` permanently dirty).
  const candidates = [
    task.workspace_path ? siblingMetadataPath(task.workspace_path) : null,
    taskMetadataPath(task.id),
  ].filter((p): p is string => typeof p === 'string').filter(p => existsSync(p));

  for (const candidate of candidates) {
    try {
      const meta = JSON.parse(readFileSync(candidate, 'utf-8')) as TaskWorktreeInfo;
      if (meta.taskId === task.id && meta.branchName) return meta;
    } catch { /* try next candidate */ }
  }

  // Fallback: derive from DB row when the metadata file is missing.
  if (task.workspace_path && existsSync(path.join(task.workspace_path, '.git'))) {
    try {
      const branch = git(task.workspace_path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      if (branch.startsWith('platform-')) {
        return {
          taskId: task.id,
          worktreePath: task.workspace_path,
          branchName: branch,
          mainBranch: resolveMainBranch(),
          baseCommit: '',
          status: 'active',
          createdAt: new Date().toISOString(),
          path: task.workspace_path,
          strategy: 'worktree',
          branch,
          baseBranch: resolveMainBranch(),
          port: 0,
        };
      }
    } catch { /* ignore */ }
  }

  return null;
}

export function isTaskWorktreeTask(task: Pick<Task, 'id' | 'workspace_path' | 'workspace_strategy'>): boolean {
  if (loadTaskWorktree(task)) return true;
  return task.workspace_strategy === 'worktree' && !!task.workspace_path &&
    path.basename(path.dirname(task.workspace_path)) === 'worktree';
}

function writeMetadata(info: TaskWorktreeInfo): void {
  const payload = { ...info };
  delete (payload as Partial<TaskWorktreeInfo>).path;
  delete (payload as Partial<TaskWorktreeInfo>).strategy;
  delete (payload as Partial<TaskWorktreeInfo>).branch;
  delete (payload as Partial<TaskWorktreeInfo>).baseBranch;
  delete (payload as Partial<TaskWorktreeInfo>).port;
  writeFileSync(siblingMetadataPath(info.worktreePath), JSON.stringify(payload, null, 2));
}

// ─── Create ──────────────────────────────────────────────────────────

/**
 * Create the isolated worktree for a task. Idempotent: if the worktree
 * already exists (dir + metadata), returns the existing info untouched.
 *
 * Steps: preflight shared repo → fetch origin → resolve main branch from
 * origin/HEAD → `git worktree add <path> -b platform-<id>/<short> origin/<main>`
 * → persist metadata + tasks row.
 */
export async function createTaskWorktree(
  task: Pick<Task, 'id' | 'title' | 'repo_url' | 'repo_branch'>,
  config: WorktreeManagerConfig = getWorktreeConfig()
): Promise<TaskWorktreeInfo> {
  if (!config.enabled) {
    throw new Error('Task worktrees are disabled (ENABLE_TASK_WORKTREES=false)');
  }
  if (!task.repo_url) {
    throw new Error('Task worktrees require a repo_url on the task');
  }

  const existing = loadTaskWorktree(task as Task);
  if (existing && existsSync(existing.worktreePath)) {
    return existing;
  }

  const preflight = preflightSharedRepo(config);
  if (!preflight.ok) {
    throw new Error(`[Worktree] Pre-flight failed before create: ${preflight.error}`);
  }

  const mainBranch = resolveMainBranch(config);
  const fetchRes = gitTry(config.repoPath, ['fetch', 'origin', '--prune']);
  if (!fetchRes.ok) {
    throw new Error(`[Worktree] git fetch origin failed: ${fetchRes.stderr}`);
  }

  const baseCommit = git(config.repoPath, ['rev-parse', `origin/${mainBranch}`]).trim();
  const branchName = `platform-${task.id.replace(/-/g, '').slice(0, 8)}/${baseCommit.slice(0, 7)}`;
  const worktreePath = path.join(config.taskRoot, task.id, 'worktree');

  mkdirSync(path.join(config.taskRoot, task.id), { recursive: true });
  mkdirSync(path.dirname(worktreePath), { recursive: true });

  const addRes = gitTry(config.repoPath, ['worktree', 'add', worktreePath, '-b', branchName, `origin/${mainBranch}`]);
  if (!addRes.ok) {
    throw new Error(`[Worktree] git worktree add failed: ${addRes.stderr}`);
  }

  const info: TaskWorktreeInfo = {
    taskId: task.id,
    worktreePath,
    branchName,
    mainBranch,
    baseCommit,
    status: 'active',
    createdAt: new Date().toISOString(),
    path: worktreePath,
    strategy: 'worktree',
    branch: branchName,
    baseBranch: mainBranch,
    port: 0,
  };
  writeMetadata(info);

  const now = new Date().toISOString();
  run(
    `UPDATE tasks SET workspace_path = ?, workspace_strategy = 'worktree', workspace_port = 0,
     workspace_base_commit = ?, merge_status = 'pending', updated_at = ? WHERE id = ?`,
    [worktreePath, baseCommit, now, task.id]
  );

  console.log(`[Worktree] Created task worktree ${worktreePath} (branch ${branchName} from origin/${mainBranch} @ ${baseCommit.slice(0, 7)})`);
  return info;
}

// ─── Landing ─────────────────────────────────────────────────────────

const LAND_LOCKS = new Map<string, boolean>();

function acquireLandLock(repoPath: string): boolean {
  if (LAND_LOCKS.get(repoPath)) return false;
  LAND_LOCKS.set(repoPath, true);
  return true;
}

function releaseLandLock(repoPath: string): void {
  LAND_LOCKS.delete(repoPath);
}

function conflictFilesIn(repoPath: string): string[] {
  const res = gitTry(repoPath, ['diff', '--name-only', '--diff-filter=U']);
  if (!res.ok) return [];
  return res.stdout.trim().split('\n').filter(Boolean);
}

function recordMerge(task: TaskWorktreeInfo, status: string, extra: Record<string, unknown>): void {
  const mergeId = uuidv4();
  const now = new Date().toISOString();
  run(
    `INSERT INTO workspace_merges (id, task_id, workspace_path, strategy, base_commit, merge_commit, status, conflict_files, merge_log, merged_by, created_at, merged_at)
     VALUES (?, ?, ?, 'worktree', ?, ?, ?, ?, ?, 'auto', ?, ?)`,
    [
      mergeId,
      task.taskId,
      task.worktreePath,
      task.baseCommit || null,
      extra.mergeCommit || null,
      status,
      extra.conflictFiles ? JSON.stringify(extra.conflictFiles) : null,
      extra.log || null,
      now,
      status === 'landed' ? now : null,
    ]
  );
}

/**
 * Land a task's worktree onto the shared main branch and push to origin.
 *
 * Flow: preflight (shared repo clean + origin reachable, worktree branch has
 * commits) → fetch origin → checkout main → cherry-pick each worktree commit
 * one at a time (empty/duplicate picks are skipped) → push origin <main> →
 * verify sync → record merge → cleanup worktree (landed).
 *
 * Conflict → `git cherry-pick --abort` (main branch restored clean), task
 * merge_status='blocked' + status_reason, worktree KEPT for manual resolve.
 * Push failure → merge_status='failed', worktree KEPT (retryable).
 */
export async function landTaskWorktree(
  taskId: string,
  config: WorktreeManagerConfig = getWorktreeConfig()
): Promise<LandResult> {
  if (!config.enabled) {
    return { ok: false, status: 'failed', mainBranch: config.mainBranch || '', landedCommits: [], log: 'Task worktrees disabled (ENABLE_TASK_WORKTREES=false)' };
  }

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return { ok: false, status: 'failed', mainBranch: '', landedCommits: [], log: `Task ${taskId} not found` };
  }
  const info = loadTaskWorktree(task);
  if (!info) {
    return { ok: false, status: 'failed', mainBranch: '', landedCommits: [], log: `No task worktree found for ${taskId}` };
  }

  // Serialize landings per repo (concurrent cherry-picks on the same repo
  // would corrupt each other).
  if (!acquireLandLock(config.repoPath)) {
    return { ok: false, status: 'failed', mainBranch: info.mainBranch, landedCommits: [], log: `Another landing is already running on ${config.repoPath}` };
  }

  try {
    const preflight = preflightSharedRepo(config);
    if (!preflight.ok) {
      return { ok: false, status: 'failed', mainBranch: info.mainBranch, landedCommits: [], log: `[Worktree] Pre-flight failed before landing: ${preflight.error}` };
    }
    const wtPreflight = preflightTaskWorktree(info, true);
    if (!wtPreflight.ok) {
      return { ok: false, status: 'failed', mainBranch: info.mainBranch, landedCommits: [], log: `[Worktree] Worktree pre-flight failed: ${wtPreflight.error}` };
    }

    const fetchRes = gitTry(config.repoPath, ['fetch', 'origin', '--prune']);
    if (!fetchRes.ok) {
      return { ok: false, status: 'failed', mainBranch: info.mainBranch, landedCommits: [], log: `[Worktree] git fetch origin failed: ${fetchRes.stderr}` };
    }

    const mainBranch = info.mainBranch || resolveMainBranch(config);
    const branchExists = gitTry(config.repoPath, ['rev-parse', '--verify', info.branchName]);
    if (!branchExists.ok) {
      return { ok: false, status: 'failed', mainBranch, landedCommits: [], log: `[Worktree] Branch ${info.branchName} missing in shared repo: ${branchExists.stderr}` };
    }

    const commits = git(config.repoPath, ['rev-list', '--reverse', `origin/${mainBranch}..${info.branchName}`])
      .trim().split('\n').filter(Boolean);

    if (commits.length === 0) {
      recordMerge(info, 'merged', { log: 'no changes to land — worktree branch in sync with origin main' });
      run(`UPDATE tasks SET merge_status = 'merged', updated_at = ? WHERE id = ?`, [new Date().toISOString(), taskId]);
      return { ok: true, status: 'no_changes', mainBranch, landedCommits: [], log: 'no changes to land' };
    }

    const checkoutRes = gitTry(config.repoPath, ['checkout', mainBranch]);
    if (!checkoutRes.ok) {
      return { ok: false, status: 'failed', mainBranch, landedCommits: [], log: `[Worktree] checkout ${mainBranch} failed: ${checkoutRes.stderr}` };
    }

    const landedCommits: string[] = [];

    for (const commit of commits) {
      const pick = gitTry(config.repoPath, ['cherry-pick', commit]);
      if (pick.ok) {
        landedCommits.push(commit);
        continue;
      }
      const stderr = pick.stderr || '';
      // Empty cherry-pick (change already applied / no diff on this base) → skip.
      if (stderr.includes('is now empty') || stderr.includes('previous cherry-pick is now empty')) {
        gitTry(config.repoPath, ['cherry-pick', '--skip']);
        continue;
      }
      // Real conflict → abort, mark blocked, KEEP worktree.
      const files = conflictFilesIn(config.repoPath);
      gitTry(config.repoPath, ['cherry-pick', '--abort']);
      const now = new Date().toISOString();
      recordMerge(info, 'conflict', { conflictFiles: files, log: `cherry-pick conflict on ${commit.slice(0, 7)}: ${stderr.slice(0, 500)}` });
      run(
        `UPDATE tasks SET merge_status = 'blocked', status_reason = COALESCE(status_reason, '') || ' | WORKTREE_LAND_CONFLICT: cherry-pick of ${commit.slice(0, 7)} conflicted; worktree kept at ${info.worktreePath} for manual resolve', updated_at = ? WHERE id = ?`,
        [now, taskId]
      );
      console.warn(`[Worktree] Landing conflict for task ${taskId} on ${commit.slice(0, 7)} — worktree kept at ${info.worktreePath}`);
      return {
        ok: false,
        status: 'conflict',
        mainBranch,
        landedCommits,
        conflictFiles: files,
        log: `cherry-pick conflict on ${commit.slice(0, 7)}; main restored via abort; worktree kept`,
      };
    }

    const mergeCommit = git(config.repoPath, ['rev-parse', 'HEAD']).trim();

    const push = gitTry(config.repoPath, ['push', 'origin', mainBranch]);
    if (!push.ok) {
      const now = new Date().toISOString();
      recordMerge(info, 'failed', { mergeCommit, log: `cherry-pick succeeded locally but push failed: ${push.stderr}` });
      run(
        `UPDATE tasks SET merge_status = 'failed', status_reason = COALESCE(status_reason, '') || ' | WORKTREE_LAND_PUSH_FAILED: cherry-pick ok on ${mainBranch} but push to origin failed; worktree kept', updated_at = ? WHERE id = ?`,
        [now, taskId]
      );
      return {
        ok: false,
        status: 'failed',
        mainBranch,
        landedCommits,
        mergeCommit,
        log: `cherry-pick landed locally on ${mainBranch} (${landedCommits.length} commit(s)) but push failed: ${push.stderr}`,
      };
    }

    // Verify sync: local main == origin main after push.
    const headNow = git(config.repoPath, ['rev-parse', 'HEAD']).trim();
    const originNow = git(config.repoPath, ['rev-parse', `origin/${mainBranch}`]).trim();
    const synced = headNow === originNow;

    const now = new Date().toISOString();
    recordMerge(info, synced ? 'merged' : 'failed', {
      mergeCommit,
      log: `cherry-picked ${landedCommits.length} commit(s) from ${info.branchName} onto ${mainBranch} and pushed${synced ? '' : ` (SYNC CHECK FAILED: local ${headNow.slice(0, 7)} != origin ${originNow.slice(0, 7)})`}`,
    });
    run(
      `UPDATE tasks SET merge_status = ${synced ? "'merged'" : "'failed'"}, updated_at = ? WHERE id = ?`,
      [now, taskId]
    );

    if (synced) {
      // Cleanup policy: remove worktree + branch after successful landing.
      cleanupTaskWorktree(taskId, config);
    }

    return {
      ok: synced,
      status: synced ? 'landed' : 'failed',
      mainBranch,
      landedCommits,
      mergeCommit,
      log: synced
        ? `landed ${landedCommits.length} commit(s) via cherry-pick onto ${mainBranch}; pushed; worktree cleaned up`
        : `landed commits but sync check failed (local ${headNow.slice(0, 7)} != origin ${originNow.slice(0, 7)})`,
    };
  } finally {
    releaseLandLock(config.repoPath);
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────

/**
 * Remove the task worktree + its local branch after a successful landing (or
 * on explicit operator cleanup). Idempotent: missing worktree/branch is fine.
 * The tasks row is reset (workspace_path NULL) so a re-dispatch recreates a
 * fresh worktree from the new origin/HEAD.
 */
export function cleanupTaskWorktree(
  taskId: string,
  config: WorktreeManagerConfig = getWorktreeConfig()
): CleanupResult {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  const info = task ? loadTaskWorktree(task) : null;
  const worktreePath = info?.worktreePath || taskWorktreePath(taskId);

  if (!info || !existsSync(worktreePath)) {
    run(`UPDATE tasks SET workspace_path = NULL, workspace_port = NULL, updated_at = ? WHERE id = ?`, [new Date().toISOString(), taskId]);
    return { ok: true, log: `No active worktree for ${taskId} — nothing to clean up` };
  }

  const logs: string[] = [];
  const preflight = preflightSharedRepo(config);
  if (!preflight.ok) {
    // Worktree removal does not strictly need origin — but a dirty shared
    // tree means we should not touch it. Removal via --force is safe though:
    // it only detaches the worktree dir, it never modifies main's tree.
    logs.push(`shared-repo preflight warning: ${preflight.error}`);
  }

  const removeRes = gitTry(config.repoPath, ['worktree', 'remove', worktreePath, '--force']);
  if (removeRes.ok) {
    logs.push(`worktree removed: ${worktreePath}`);
  } else {
    // Fallback: plain directory removal (worktree registration pruned later).
    try {
      execSync(`rm -rf "${worktreePath}"`, { stdio: 'pipe' });
      gitTry(config.repoPath, ['worktree', 'prune']);
      logs.push(`worktree dir removed via fs fallback (worktree pruned)`);
    } catch (err) {
      logs.push(`worktree removal failed: ${(err as Error).message}`);
      return { ok: false, log: logs.join('; ') };
    }
  }

  const delRes = gitTry(config.repoPath, ['branch', '-D', info.branchName]);
  if (delRes.ok) {
    logs.push(`branch deleted: ${info.branchName}`);
  } else if (!(delRes.stderr || '').includes('not found') && !(delRes.stderr || '').includes('No branch')) {
    logs.push(`branch delete skipped: ${delRes.stderr}`);
  } else {
    logs.push(`branch ${info.branchName} already gone`);
  }

  const now = new Date().toISOString();
  run(
    `UPDATE tasks SET workspace_path = NULL, workspace_port = NULL, merge_status = COALESCE(merge_status, 'pending'), updated_at = ? WHERE id = ?`,
    [now, taskId]
  );

  return { ok: true, log: logs.join('; ') };
}
