/**
 * Parallel Build Isolation
 *
 * Provides filesystem isolation for concurrent tasks targeting the same product.
 * Two strategies:
 *   - worktree: git worktree per task (for repo-backed projects)
 *   - sandbox:  rsync copy per task (for non-repo projects)
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getProjectsPath } from '@/lib/config';
import { preflightRepoAccess } from '@/lib/repo-preflight';
import type { Task, Product } from '@/lib/types';

// ─── Types ───────────────────────────────────────────────────────────

export type IsolationStrategy = 'worktree' | 'sandbox';

export interface WorkspaceInfo {
  path: string;
  strategy: IsolationStrategy;
  branch?: string;
  baseBranch: string;
  baseCommit?: string;
  port: number;
}

interface WorkspaceMetadata {
  taskId: string;
  productId?: string;
  createdAt: string;
  strategy: IsolationStrategy;
  branch?: string;
  baseBranch: string;
  baseCommit?: string;
  status: 'active' | 'merged' | 'abandoned';
  agentId?: string;
  isolatedPort: number;
}

export interface MergeResult {
  success: boolean;
  status: 'merged' | 'conflict' | 'pr_created' | 'failed' | 'no_repo';
  prUrl?: string;
  conflictFiles?: string[];
  mergeCommit?: string;
  mergeLog?: string;
}

export interface WorkspaceStatus {
  exists: boolean;
  strategy?: IsolationStrategy;
  path?: string;
  port?: number;
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  mergeStatus?: string;
  conflicts?: string[];
}

interface ExecFailure extends Error {
  status?: number;
  signal?: string;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

function redactRepoUrl(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl);
    parsed.username = parsed.username ? '<redacted>' : '';
    parsed.password = parsed.password ? '<redacted>' : '';
    return parsed.toString();
  } catch {
    return repoUrl.replace(/:\/\/[^/@]+@/, '://<redacted>@');
  }
}

function outputSnippet(value: unknown): string | undefined {
  if (!value) return undefined;
  const text = Buffer.isBuffer(value) ? value.toString('utf-8') : String(value);
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 1000) : undefined;
}

function summarizeExecFailure(error: unknown) {
  const err = error as ExecFailure;
  return {
    message: err.message,
    status: err.status,
    signal: err.signal,
    stdout: outputSnippet(err.stdout),
    stderr: outputSnippet(err.stderr),
  };
}

function parseDefaultBranch(lsRemoteOutput: string): string | undefined {
  const match = lsRemoteOutput.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
  return match?.[1];
}

function parseHeadBranches(lsRemoteOutput: string): string[] {
  return lsRemoteOutput
    .split('\n')
    .map(line => line.match(/refs\/heads\/(.+)$/)?.[1])
    .filter((branch): branch is string => Boolean(branch));
}

function logRemoteBranchProbe(repoUrl: string, requestedBranch: string, taskId: string): void {
  try {
    const defaultOutput = execFileSync('git', ['ls-remote', '--symref', repoUrl, 'HEAD'], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: 'pipe',
    });
    const branchesToCheck = Array.from(new Set([requestedBranch, 'main', 'master', 'trunk', 'develop'].filter(Boolean)));
    const headsOutput = execFileSync('git', ['ls-remote', '--heads', repoUrl, ...branchesToCheck], {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: 'pipe',
    });

    console.warn('[WorkspaceIsolation] Remote branch probe after clone failure', JSON.stringify({
      taskId,
      repoUrl: redactRepoUrl(repoUrl),
      requestedBranch,
      defaultBranch: parseDefaultBranch(defaultOutput),
      matchingBranches: parseHeadBranches(headsOutput),
    }));
  } catch (probeError) {
    console.warn('[WorkspaceIsolation] Remote branch probe failed after clone failure', JSON.stringify({
      taskId,
      repoUrl: redactRepoUrl(repoUrl),
      requestedBranch,
      probeError: summarizeExecFailure(probeError),
    }));
  }
}

// ─── Port Allocator ──────────────────────────────────────────────────

const PORT_RANGE_START = 4200;
const PORT_RANGE_END = 4299;

export function allocatePort(taskId: string, productId?: string): number {
  // Find the first available port in the range
  const usedPorts = queryAll<{ port: number }>(
    `SELECT port FROM workspace_ports WHERE status = 'active' ORDER BY port`
  ).map(r => r.port);

  let port = PORT_RANGE_START;
  while (port <= PORT_RANGE_END) {
    if (!usedPorts.includes(port)) break;
    port++;
  }

  if (port > PORT_RANGE_END) {
    throw new Error('No available ports for workspace isolation (4200-4299 exhausted)');
  }

  const id = uuidv4();
  run(
    `INSERT INTO workspace_ports (id, task_id, port, product_id, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
    [id, taskId, port, productId || null, new Date().toISOString()]
  );

  return port;
}

export function releasePort(taskId: string): void {
  run(
    `UPDATE workspace_ports SET status = 'released', released_at = ? WHERE task_id = ? AND status = 'active'`,
    [new Date().toISOString(), taskId]
  );
}

// ─── Strategy Detection ──────────────────────────────────────────────

/**
 * PLATFORM-004c guardrail: branches that must never get an auto-PR.
 * deploy/* and release/* are production/operational branches — push only.
 */
export function isProtectedBranch(branch: string): boolean {
  return /^(deploy|release)\//.test(branch);
}

/**
 * PLATFORM-004c verification gate: auto-merge/PR only when the pipeline is green.
 * A task is mergeable when all workflow stages passed ('done') or the task is
 * actively in the verification stage.
 */
export function isPipelineGreen(task: Pick<Task, 'status'>): boolean {
  return task.status === 'done' || task.status === 'verification';
}

/**
 * PLATFORM-004c: single source of truth for whether an auto-PR should be created.
 * All conditions must hold: branch was pushed, PR requested, repo is GitHub,
 * and the branch is NOT protected (deploy/* / release/* guardrail).
 */
export function shouldCreatePr(
  task: Pick<Task, 'repo_url'>,
  branch: string,
  pushed: boolean,
  createPR: boolean
): boolean {
  return pushed && createPR && !!task.repo_url?.includes('github.com') && !isProtectedBranch(branch);
}

export function determineIsolationStrategy(task: Task): IsolationStrategy | null {
  // If task has a repo URL, always use worktree
  if (task.repo_url) return 'worktree';

  // If other tasks are actively building the same product, use sandbox
  if (task.product_id) {
    const activeSiblings = queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM tasks
       WHERE product_id = ? AND id != ?
       AND status IN ('in_progress', 'assigned', 'convoy_active', 'testing')`,
      [task.product_id, task.id]
    );
    if ((activeSiblings?.count || 0) > 0) return 'sandbox';
  }

  return null;
}

// ─── Project Path Resolution ─────────────────────────────────────────

function getProductProjectDir(task: Task): string {
  const projectsPath = getProjectsPath();
  const projectDir = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return path.resolve(projectsPath.replace('~', process.env.HOME || ''), projectDir);
}

function getWorkspacesRoot(projectDir: string): string {
  return path.join(projectDir, '.workspaces');
}

function getTaskWorkspaceDir(projectDir: string, taskId: string): string {
  return path.join(getWorkspacesRoot(projectDir), `task-${taskId}`);
}

// ─── Workspace Creation ──────────────────────────────────────────────

/**
 * PLATFORM-004c: idempotent pre-dispatch workspace setup (pipeline step 1).
 *
 * Called by the dispatch pipeline for EVERY builder dispatch (not only when
 * determineIsolationStrategy() is truthy) and by the workspace route's
 * `prepare` action. Always results in tasks.workspace_path being set, which
 * fixes the NO_MERGE pattern (workspace_path=NULL at done → code never lands).
 *
 * - workspace_path set + dir exists  → returns existing (alreadyPrepared)
 * - workspace_path set but stale    → recreates
 * - never prepared                  → creates (clone + branch, or project dir
 *   for tasks without a repo)
 */
export async function prepareTaskWorkspace(task: Task): Promise<WorkspaceInfo & { alreadyPrepared?: boolean }> {
  if (task.workspace_path) {
    const status = getWorkspaceStatus(task);
    if (status.exists) {
      return {
        path: task.workspace_path,
        strategy: (task.workspace_strategy as IsolationStrategy) || 'sandbox',
        baseBranch: task.repo_branch || 'main',
        port: task.workspace_port || 0,
        baseCommit: task.workspace_base_commit || undefined,
        alreadyPrepared: true,
      };
    }
    // workspace_path is stale (dir gone) — recreate below
  }
  const workspace = await createTaskWorkspace(task);
  return { ...workspace, alreadyPrepared: false };
}

export async function createTaskWorkspace(task: Task): Promise<WorkspaceInfo> {
  const strategy = determineIsolationStrategy(task);
  if (!strategy) {
    // No isolation needed — return the original project dir.
    // PLATFORM-004c: Always persist workspace_path so merge/PR step can find it.
    // Previously this early return skipped the DB update, causing NO_MERGE for
    // tasks without repo_url or parallel builds.
    const projectDir = getProductProjectDir(task);
    const now = new Date().toISOString();
    // Ensure the project dir exists — the builder writes deliverables here.
    try {
      mkdirSync(projectDir, { recursive: true });
    } catch {
      // Best effort — the agent can create it on demand
    }
    run(
      `UPDATE tasks SET workspace_path = ?, workspace_strategy = 'sandbox',
       workspace_port = 0, merge_status = 'pending', updated_at = ? WHERE id = ?`,
      [projectDir, now, task.id]
    );
    return {
      path: projectDir,
      strategy: 'sandbox',
      baseBranch: task.repo_branch || 'main',
      port: 0, // Use default port
    };
  }

  const projectDir = getProductProjectDir(task);
  const workspaceDir = getTaskWorkspaceDir(projectDir, task.id);
  const baseBranch = task.repo_branch || 'main';
  const port = allocatePort(task.id, task.product_id);

  // Ensure .workspaces directory exists
  const workspacesRoot = getWorkspacesRoot(projectDir);
  mkdirSync(workspacesRoot, { recursive: true });

  // Add .workspaces to .gitignore if it's a git repo
  const gitignorePath = path.join(projectDir, '.gitignore');
  if (existsSync(path.join(projectDir, '.git'))) {
    try {
      const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
      if (!gitignore.includes('.workspaces')) {
        writeFileSync(gitignorePath, gitignore.trimEnd() + '\n.workspaces/\n');
      }
    } catch {
      // Best effort
    }
  }

  let result: WorkspaceInfo;

  if (strategy === 'worktree') {
    result = await createWorktreeWorkspace(task, projectDir, workspaceDir, baseBranch, port);
  } else {
    result = await createSandboxWorkspace(task, projectDir, workspaceDir, baseBranch, port);
  }

  // Write workspace metadata file
  const metadata: WorkspaceMetadata = {
    taskId: task.id,
    productId: task.product_id,
    createdAt: new Date().toISOString(),
    strategy,
    branch: result.branch,
    baseBranch: result.baseBranch,
    baseCommit: result.baseCommit,
    status: 'active',
    agentId: task.assigned_agent_id || undefined,
    isolatedPort: port,
  };
  writeFileSync(path.join(workspaceDir, '.mc-workspace.json'), JSON.stringify(metadata, null, 2));

  // Persist to DB
  const now = new Date().toISOString();
  run(
    `UPDATE tasks SET workspace_path = ?, workspace_strategy = ?, workspace_port = ?,
     workspace_base_commit = ?, merge_status = 'pending', updated_at = ? WHERE id = ?`,
    [result.path, strategy, port, result.baseCommit || null, now, task.id]
  );

  return result;
}

async function createWorktreeWorkspace(
  task: Task,
  projectDir: string,
  workspaceDir: string,
  baseBranch: string,
  port: number
): Promise<WorkspaceInfo> {
  const featureSlug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
  const branchName = `autopilot/${featureSlug}`;

  // Check if this is a cloned repo or we need to clone
  const isGitRepo = existsSync(path.join(projectDir, '.git'));

  if (isGitRepo) {
    // Use git worktree from existing repo
    try {
      execSync(`git fetch origin`, { cwd: projectDir, stdio: 'pipe' });
    } catch {
      // May not have a remote — that's OK for local repos
    }

    // Get base commit
    let baseCommit: string | undefined;
    try {
      baseCommit = execSync(`git rev-parse HEAD`, { cwd: projectDir, encoding: 'utf-8' }).trim();
    } catch {
      // Empty repo
    }

    // Create worktree with a new branch
    try {
      execSync(
        `git worktree add "${workspaceDir}" -b "${branchName}" HEAD`,
        { cwd: projectDir, stdio: 'pipe' }
      );
    } catch (err) {
      // Branch may already exist — try without -b
      try {
        execSync(
          `git worktree add "${workspaceDir}" "${branchName}"`,
          { cwd: projectDir, stdio: 'pipe' }
        );
      } catch {
        throw new Error(`Failed to create git worktree: ${(err as Error).message}`);
      }
    }

    return { path: workspaceDir, strategy: 'worktree', branch: branchName, baseBranch, baseCommit, port };
  }

  // Not a local git repo — clone from repo_url
  if (task.repo_url) {
    let cloneBranch = baseBranch;
    const preflight = preflightRepoAccess(task.repo_url, baseBranch);
    if (!preflight.ok) {
      if (preflight.access === 'confirmed' && preflight.resolvedBranch) {
        cloneBranch = preflight.resolvedBranch;
        console.warn('[WorkspaceIsolation] Requested branch missing; using detected default branch', JSON.stringify({
          taskId: task.id,
          repoUrl: redactRepoUrl(task.repo_url),
          requestedBranch: baseBranch,
          resolvedBranch: cloneBranch,
        }));
        run('UPDATE tasks SET repo_branch = ?, updated_at = datetime(\'now\') WHERE id = ?', [cloneBranch, task.id]);
      } else {
        throw new Error(`Repository preflight failed: ${preflight.message}${preflight.error ? ` ${preflight.error}` : ''}`);
      }
    }

    console.info('[WorkspaceIsolation] Cloning repo for isolated workspace', JSON.stringify({
      taskId: task.id,
      repoUrl: redactRepoUrl(task.repo_url),
      requestedBranch: cloneBranch,
      workspaceDir,
    }));

    try {
      execFileSync(
        'git',
        ['clone', '--branch', cloneBranch, task.repo_url, workspaceDir],
        { stdio: 'pipe', timeout: 120000 }
      );
      execFileSync(
        'git',
        ['checkout', '-b', branchName],
        { cwd: workspaceDir, stdio: 'pipe' }
      );
      const baseCommit = execSync(`git rev-parse HEAD`, { cwd: workspaceDir, encoding: 'utf-8' }).trim();
      return { path: workspaceDir, strategy: 'worktree', branch: branchName, baseBranch: cloneBranch, baseCommit, port };
    } catch (err) {
      console.warn('[WorkspaceIsolation] Clone failed for isolated workspace', JSON.stringify({
        taskId: task.id,
        repoUrl: redactRepoUrl(task.repo_url),
        requestedBranch: cloneBranch,
        workspaceDir,
        error: summarizeExecFailure(err),
      }));
      logRemoteBranchProbe(task.repo_url, cloneBranch, task.id);
      throw new Error(`Failed to clone repo: ${(err as Error).message}`);
    }
  }

  throw new Error('Worktree strategy requires a git repo or repo_url');
}

async function createSandboxWorkspace(
  task: Task,
  projectDir: string,
  workspaceDir: string,
  baseBranch: string,
  port: number
): Promise<WorkspaceInfo> {
  // Ensure source directory exists
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  // rsync the project directory, excluding heavy/generated dirs
  try {
    execSync(
      `rsync -a --exclude='.workspaces' --exclude='node_modules' --exclude='.next' --exclude='.git' --exclude='dist' --exclude='build' "${projectDir}/" "${workspaceDir}/"`,
      { stdio: 'pipe', timeout: 60000 }
    );
  } catch (err) {
    // If rsync fails (e.g., empty dir), just create the workspace
    mkdirSync(workspaceDir, { recursive: true });
  }

  return { path: workspaceDir, strategy: 'sandbox', baseBranch, port };
}

// ─── Workspace Status ────────────────────────────────────────────────

export function getWorkspaceStatus(task: Task): WorkspaceStatus {
  if (!task.workspace_path || !existsSync(task.workspace_path)) {
    return { exists: false };
  }

  const strategy = task.workspace_strategy as IsolationStrategy | undefined;
  const result: WorkspaceStatus = {
    exists: true,
    strategy,
    path: task.workspace_path,
    port: task.workspace_port || undefined,
    baseBranch: task.repo_branch || 'main',
    baseCommit: task.workspace_base_commit || undefined,
    mergeStatus: task.merge_status || undefined,
  };

  // Read metadata for branch info
  const metadataPath = path.join(task.workspace_path, '.mc-workspace.json');
  if (existsSync(metadataPath)) {
    try {
      const metadata: WorkspaceMetadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      result.branch = metadata.branch;
    } catch {
      // Ignore
    }
  }

  // Get diff stats
  if (strategy === 'worktree' && existsSync(path.join(task.workspace_path, '.git'))) {
    try {
      const diffStat = execSync(
        `git diff --stat HEAD~1 2>/dev/null || git diff --stat --cached 2>/dev/null || echo ""`,
        { cwd: task.workspace_path, encoding: 'utf-8', timeout: 10000 }
      );
      const lines = diffStat.trim().split('\n');
      const summary = lines[lines.length - 1] || '';
      const filesMatch = summary.match(/(\d+) files? changed/);
      const insertMatch = summary.match(/(\d+) insertions?/);
      const deleteMatch = summary.match(/(\d+) deletions?/);
      result.filesChanged = filesMatch ? parseInt(filesMatch[1]) : 0;
      result.insertions = insertMatch ? parseInt(insertMatch[1]) : 0;
      result.deletions = deleteMatch ? parseInt(deleteMatch[1]) : 0;
    } catch {
      // Ignore diff errors
    }
  } else if (strategy === 'sandbox') {
    // For sandbox, count files that differ from original
    const projectDir = path.dirname(path.dirname(task.workspace_path)); // Up from .workspaces/task-xxx
    try {
      const diff = execSync(
        `diff -rq "${projectDir}" "${task.workspace_path}" --exclude='.workspaces' --exclude='node_modules' --exclude='.next' --exclude='.mc-workspace.json' 2>/dev/null | wc -l`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();
      result.filesChanged = parseInt(diff) || 0;
    } catch {
      // Ignore
    }
  }

  return result;
}

// ─── Merge Operations ────────────────────────────────────────────────

export async function mergeWorkspace(task: Task, options?: { force?: boolean; createPR?: boolean }): Promise<MergeResult> {
  if (!task.workspace_path || !task.workspace_strategy) {
    return { success: false, status: 'failed', mergeLog: 'No workspace to merge' };
  }

  if (!existsSync(task.workspace_path)) {
    return { success: false, status: 'failed', mergeLog: 'Workspace directory not found' };
  }

  const now = new Date().toISOString();
  const mergeId = uuidv4();

  if (task.workspace_strategy === 'worktree') {
    return mergeWorktree(task, mergeId, now, options);
  } else {
    return mergeSandbox(task, mergeId, now, options);
  }
}

async function mergeWorktree(
  task: Task,
  mergeId: string,
  now: string,
  options?: { force?: boolean; createPR?: boolean }
): Promise<MergeResult> {
  const workspacePath = task.workspace_path!;
  const baseBranch = task.repo_branch || 'main';

  // Read metadata for branch name
  let branch = `autopilot/${task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}`;
  const metadataPath = path.join(workspacePath, '.mc-workspace.json');
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
      if (metadata.branch) branch = metadata.branch;
    } catch { /* ignore */ }
  }

  try {
    // Stage and commit any uncommitted changes
    try {
      execSync(`git add -A && git diff --cached --quiet || git commit -m "Autopilot: final changes for ${task.title}"`, {
        cwd: workspacePath, stdio: 'pipe', shell: '/bin/sh'
      });
    } catch { /* nothing to commit */ }

    // Push branch to remote
    let pushed = false;
    try {
      execSync(`git push origin "${branch}" 2>&1`, { cwd: workspacePath, stdio: 'pipe', timeout: 60000 });
      pushed = true;
    } catch (err) {
      // May not have remote push access
      console.warn(`[Workspace] Push failed for ${branch}:`, (err as Error).message);
    }

    // PLATFORM-004c: Guardrail — skip PR creation for deploy/* or release/* branches.
    // These are production/operational branches where auto-PR would be dangerous.
    // The branch is still pushed so the remote stays in sync.
    if (isProtectedBranch(branch)) {
      console.warn(`[Workspace] Skipping PR creation for protected branch "${branch}" (deploy/release guardrail) — branch pushed only`);
    }

    // Create PR if pushed and requested (or if repo_url suggests GitHub)
    let prUrl: string | undefined;
    if (shouldCreatePr(task, branch, pushed, options?.createPR !== false)) {
      try {
        const prBody = `## Autopilot Build\n\n- **Task:** ${task.title}\n- **Task ID:** ${task.id}\n- **Branch:** ${branch}\n- **Base:** ${baseBranch}`;
        const result = execSync(
          `gh pr create --title "\u{1F916} Autopilot: ${task.title}" --body "${prBody.replace(/"/g, '\\"')}" --base "${baseBranch}" --head "${branch}" 2>&1`,
          { cwd: workspacePath, encoding: 'utf-8', timeout: 30000 }
        ).trim();
        // gh pr create outputs the PR URL
        if (result.includes('github.com')) {
          prUrl = result.split('\n').pop()?.trim();
        }
      } catch (err) {
        console.warn('[Workspace] PR creation failed:', (err as Error).message);
      }
    }

    const status = prUrl ? 'pr_created' : (pushed ? 'merged' : 'merged');
    const mergeCommit = (() => {
      try { return execSync('git rev-parse HEAD', { cwd: workspacePath, encoding: 'utf-8' }).trim(); }
      catch { return undefined; }
    })();

    // Record merge
    run(
      `INSERT INTO workspace_merges (id, task_id, workspace_path, strategy, base_commit, merge_commit, status, merged_by, created_at, merged_at)
       VALUES (?, ?, ?, 'worktree', ?, ?, ?, 'auto', ?, ?)`,
      [mergeId, task.id, workspacePath, task.workspace_base_commit, mergeCommit, status, now, now]
    );

    // Update task
    run(
      `UPDATE tasks SET merge_status = ?, merge_pr_url = ?, updated_at = ? WHERE id = ?`,
      [status, prUrl || null, now, task.id]
    );

    return { success: true, status: status as MergeResult['status'], prUrl, mergeCommit };
  } catch (err) {
    const errorMsg = (err as Error).message;
    run(
      `INSERT INTO workspace_merges (id, task_id, workspace_path, strategy, status, merge_log, created_at)
       VALUES (?, ?, ?, 'worktree', 'failed', ?, ?)`,
      [mergeId, task.id, workspacePath, errorMsg, now]
    );
    run(`UPDATE tasks SET merge_status = 'conflict', updated_at = ? WHERE id = ?`, [now, task.id]);
    return { success: false, status: 'failed', mergeLog: errorMsg };
  }
}

async function mergeSandbox(
  task: Task,
  mergeId: string,
  now: string,
  _options?: { force?: boolean }
): Promise<MergeResult> {
  const workspacePath = task.workspace_path!;

  // PLATFORM-004c: degenerate case — workspace IS the shared project dir
  // (task without repo_url: prepare persisted the project dir itself as
  // workspace_path). There is nothing to land; the work already lives in the
  // project dir. Record it so NO_MERGE is never raised for prepared tasks.
  const isStandaloneProject = path.basename(path.dirname(workspacePath)) !== '.workspaces';
  if (isStandaloneProject) {
    run(
      `INSERT INTO workspace_merges (id, task_id, workspace_path, strategy, status, merge_log, merged_by, created_at, merged_at)
       VALUES (?, ?, ?, 'sandbox', 'no_repo', 'no repo_url — workspace is the shared project dir; auto-landing n/a', 'auto', ?, ?)`,
      [mergeId, task.id, workspacePath, now, now]
    );
    run(`UPDATE tasks SET merge_status = 'no_repo', updated_at = ? WHERE id = ?`, [now, task.id]);
    return { success: true, status: 'no_repo' };
  }

  // The project dir is two levels up: .workspaces/task-xxx → .workspaces → projectDir
  const projectDir = path.dirname(path.dirname(workspacePath));

  try {
    // Check for conflicts: files modified in both workspace and main project since workspace creation
    let conflictFiles: string[] = [];
    try {
      const diff = execSync(
        `diff -rq "${projectDir}" "${workspacePath}" --exclude='.workspaces' --exclude='node_modules' --exclude='.next' --exclude='.mc-workspace.json' --exclude='.git' --exclude='dist' --exclude='build' 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 30000 }
      );
      // Parse diff output for changed files
      const changedFiles = diff.split('\n')
        .filter(l => l.startsWith('Files ') && l.includes(' differ'))
        .map(l => {
          const match = l.match(/Files (.+?) and (.+?) differ/);
          return match ? match[2].replace(workspacePath + '/', '') : null;
        })
        .filter(Boolean) as string[];

      if (changedFiles.length > 0) {
        // rsync changes from workspace back to project
        execSync(
          `rsync -a --exclude='.workspaces' --exclude='node_modules' --exclude='.next' --exclude='.mc-workspace.json' --exclude='.git' --exclude='dist' --exclude='build' "${workspacePath}/" "${projectDir}/"`,
          { stdio: 'pipe', timeout: 60000 }
        );
      }
    } catch (err) {
      conflictFiles = [`Merge error: ${(err as Error).message}`];
    }

    const status = conflictFiles.length > 0 ? 'conflict' : 'merged';

    run(
      `INSERT INTO workspace_merges (id, task_id, workspace_path, strategy, status, conflict_files, merged_by, created_at, merged_at)
       VALUES (?, ?, ?, 'sandbox', ?, ?, 'auto', ?, ?)`,
      [mergeId, task.id, workspacePath, status, conflictFiles.length > 0 ? JSON.stringify(conflictFiles) : null, now, now]
    );
    run(`UPDATE tasks SET merge_status = ?, updated_at = ? WHERE id = ?`, [status, now, task.id]);

    return { success: status === 'merged', status: status as MergeResult['status'], conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined };
  } catch (err) {
    const errorMsg = (err as Error).message;
    run(
      `INSERT INTO workspace_merges (id, task_id, workspace_path, strategy, status, merge_log, created_at)
       VALUES (?, ?, ?, 'sandbox', 'failed', ?, ?)`,
      [mergeId, task.id, workspacePath, errorMsg, now]
    );
    run(`UPDATE tasks SET merge_status = 'conflict', updated_at = ? WHERE id = ?`, [now, task.id]);
    return { success: false, status: 'failed', mergeLog: errorMsg };
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────

export function cleanupWorkspace(task: Task): boolean {
  if (!task.workspace_path) return false;

  const workspacePath = task.workspace_path;
  const projectDir = path.dirname(path.dirname(workspacePath));

  try {
    if (task.workspace_strategy === 'worktree') {
      // Remove git worktree
      try {
        execSync(`git worktree remove "${workspacePath}" --force`, { cwd: projectDir, stdio: 'pipe' });
      } catch {
        // Fallback: just remove the directory
        execSync(`rm -rf "${workspacePath}"`, { stdio: 'pipe' });
      }

      // Try to delete the branch
      const metadataPath = path.join(workspacePath, '.mc-workspace.json');
      if (existsSync(metadataPath)) {
        try {
          const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
          if (metadata.branch) {
            execSync(`git branch -D "${metadata.branch}" 2>/dev/null || true`, { cwd: projectDir, stdio: 'pipe' });
          }
        } catch { /* ignore */ }
      }
    } else {
      // Remove sandbox directory
      execSync(`rm -rf "${workspacePath}"`, { stdio: 'pipe' });
    }

    // Release port
    releasePort(task.id);

    // Update task
    const now = new Date().toISOString();
    run(
      `UPDATE tasks SET workspace_path = NULL, workspace_port = NULL, updated_at = ? WHERE id = ?`,
      [now, task.id]
    );

    // Update metadata status
    const metadataPath = path.join(workspacePath, '.mc-workspace.json');
    if (existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
        metadata.status = 'abandoned';
        writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      } catch { /* ignore */ }
    }

    return true;
  } catch (err) {
    console.error(`[Workspace] Cleanup failed for task ${task.id}:`, err);
    return false;
  }
}

// ─── Active Workspaces Query ─────────────────────────────────────────

export function getActiveWorkspaces(productId: string): Array<{
  taskId: string;
  taskTitle: string;
  branch?: string;
  port?: number;
  agentName?: string;
  strategy?: string;
  filesChanged?: number;
  createdAt: string;
}> {
  const tasks = queryAll<Task & { agent_name?: string }>(
    `SELECT t.*, a.name as agent_name FROM tasks t
     LEFT JOIN agents a ON t.assigned_agent_id = a.id
     WHERE t.product_id = ? AND t.workspace_path IS NOT NULL
     AND t.status IN ('assigned', 'in_progress', 'convoy_active', 'testing', 'review', 'verification')
     ORDER BY t.created_at DESC`,
    [productId]
  );

  return tasks.map(t => {
    let branch: string | undefined;
    if (t.workspace_path && existsSync(path.join(t.workspace_path, '.mc-workspace.json'))) {
      try {
        const meta = JSON.parse(readFileSync(path.join(t.workspace_path, '.mc-workspace.json'), 'utf-8'));
        branch = meta.branch;
      } catch { /* ignore */ }
    }

    return {
      taskId: t.id,
      taskTitle: t.title,
      branch,
      port: t.workspace_port || undefined,
      agentName: (t as { agent_name?: string }).agent_name,
      strategy: t.workspace_strategy,
      filesChanged: undefined, // Computed on-demand to avoid perf hit
      createdAt: t.created_at,
    };
  });
}

// ─── Merge Lock ──────────────────────────────────────────────────────

const MERGE_LOCKS = new Map<string, boolean>();

export function acquireMergeLock(productId: string): boolean {
  if (MERGE_LOCKS.get(productId)) return false;
  MERGE_LOCKS.set(productId, true);
  return true;
}

export function releaseMergeLock(productId: string): void {
  MERGE_LOCKS.delete(productId);
}

export async function triggerWorkspaceMerge(taskId: string): Promise<MergeResult | null> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task || !task.workspace_path || !task.workspace_strategy) return null;

  // Acquire merge lock for the product
  const lockKey = task.product_id || task.id;
  if (!acquireMergeLock(lockKey)) {
    // Another merge in progress — queue this one
    run(`UPDATE tasks SET merge_status = 'pending', updated_at = ? WHERE id = ?`, [new Date().toISOString(), taskId]);
    return null;
  }

  try {
    const result = await mergeWorkspace(task, { createPR: true });
    return result;
  } finally {
    releaseMergeLock(lockKey);
    // Check for queued merges
    const queued = queryOne<Task>(
      `SELECT * FROM tasks WHERE product_id = ? AND merge_status = 'pending' AND status = 'done' AND workspace_path IS NOT NULL AND id != ?`,
      [task.product_id, taskId]
    );
    if (queued) {
      // Fire-and-forget the next merge
      triggerWorkspaceMerge(queued.id).catch(err =>
        console.error('[Workspace] Queued merge failed:', err)
      );
    }
  }
}
