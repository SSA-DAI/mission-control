import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// PLATFORM-004c regression tests: workspace prepare (pipeline step 1),
// verification gate, deploy/release PR guardrail, and the NO_MERGE fix.
//
// Hermetic: own DATABASE_PATH + PROJECTS_PATH per process (node:test runs
// each file in its own process), unique task ids/slugs, no empty-DB
// assumptions.

const dbPath = `.tmp/workspace-isolation-test-${process.pid}.db`;
const projectsPath = `.tmp/ws-isolation-projects-${process.pid}`;

type Db = {
  run: (sql: string, params?: unknown[]) => unknown;
  queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => T | undefined;
};

type Wi = typeof import('@/lib/workspace-isolation');

let db: Db;
let wi: Wi;

before(async () => {
  fs.mkdirSync('.tmp', { recursive: true });
  fs.mkdirSync(projectsPath, { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.PROJECTS_PATH = projectsPath;
  db = (await import('@/lib/db')) as unknown as Db;
  wi = await import('@/lib/workspace-isolation');
});

after(() => {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  try { fs.rmSync(projectsPath, { recursive: true, force: true }); } catch { /* ignore */ }
});

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function insertTask(overrides: Record<string, unknown> = {}): string {
  const id = `ws-test-${randomUUID()}`;
  const row: Record<string, unknown> = {
    title: 'Test Workspace Prepare',
    status: 'in_progress',
    priority: 'normal',
    workspace_id: 'default',
    business_id: 'default',
    ...overrides,
  };
  const cols = ['id', ...Object.keys(row)];
  const vals: unknown[] = [id, ...Object.values(row)];
  db.run(`INSERT INTO tasks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
  return id;
}

function getTask(id: string): Record<string, unknown> {
  const row = db.queryOne('SELECT * FROM tasks WHERE id = ?', [id]);
  assert.ok(row, `task ${id} must exist`);
  return row;
}

// ── Guardrail: deploy/* / release/* branches ──

test('isProtectedBranch: deploy/* and release/* are protected', () => {
  assert.equal(wi.isProtectedBranch('deploy/prod'), true);
  assert.equal(wi.isProtectedBranch('deploy/2026-08-06'), true);
  assert.equal(wi.isProtectedBranch('release/v1.2'), true);
  assert.equal(wi.isProtectedBranch('release/2026-08'), true);
});

test('isProtectedBranch: normal branches are NOT protected', () => {
  assert.equal(wi.isProtectedBranch('autopilot/feature-x'), false);
  assert.equal(wi.isProtectedBranch('main'), false);
  assert.equal(wi.isProtectedBranch('develop'), false);
  // Prefix without the slash delimiter does not match
  assert.equal(wi.isProtectedBranch('deploy'), false);
  assert.equal(wi.isProtectedBranch('release-notes/1'), false);
  assert.equal(wi.isProtectedBranch('deployable/thing'), false);
});

test('shouldCreatePr: all conditions must hold (pushed + requested + github + non-protected)', () => {
  const gh = { repo_url: 'https://github.com/SSA-DAI/mission-control.git' };
  // Happy path → PR created
  assert.equal(wi.shouldCreatePr(gh, 'autopilot/feature-x', true, true), true);
  // Guardrail: deploy/release branch → no PR even when pushed
  assert.equal(wi.shouldCreatePr(gh, 'deploy/prod', true, true), false);
  assert.equal(wi.shouldCreatePr(gh, 'release/v1', true, true), false);
  // Not pushed → no PR
  assert.equal(wi.shouldCreatePr(gh, 'autopilot/feature-x', false, true), false);
  // createPR disabled → no PR
  assert.equal(wi.shouldCreatePr(gh, 'autopilot/feature-x', true, false), false);
  // Non-GitHub repo → no PR (gh pr create targets github.com)
  assert.equal(wi.shouldCreatePr({ repo_url: undefined }, 'autopilot/feature-x', true, true), false);
  assert.equal(wi.shouldCreatePr({ repo_url: 'git@gitlab.com:acme/repo.git' }, 'autopilot/feature-x', true, true), false);
});

// ── Verification gate: only green pipeline merges ──

test('isPipelineGreen: only done/verification allow auto-merge', () => {
  assert.equal(wi.isPipelineGreen({ status: 'done' }), true);
  assert.equal(wi.isPipelineGreen({ status: 'verification' }), true);
  for (const status of ['inbox', 'assigned', 'in_progress', 'testing', 'review', 'review_fix', 'pending_dispatch', 'planning', 'convoy_active']) {
    assert.equal(wi.isPipelineGreen({ status }), false, `status ${status} must NOT be mergeable`);
  }
});

// ── NO_MERGE regression: prepare always persists workspace_path ──

test('prepareTaskWorkspace: no-repo task gets workspace_path + merge_status=pending (NO_MERGE fix)', async () => {
  const id = insertTask({});
  const ws = await wi.prepareTaskWorkspace(getTask(id));

  assert.equal(ws.alreadyPrepared, false);
  assert.equal(ws.strategy, 'sandbox');
  // Workspace is the shared project dir (no isolation needed)
  assert.ok(ws.path.endsWith(slugify('Test Workspace Prepare')), ws.path);

  const updated = getTask(id);
  assert.equal(updated.workspace_path, ws.path, 'workspace_path MUST be persisted');
  assert.equal(updated.merge_status, 'pending');
  assert.ok(fs.existsSync(ws.path), 'workspace dir must exist');
});

test('prepareTaskWorkspace: idempotent — second call returns alreadyPrepared=true', async () => {
  const id = insertTask({});
  const first = await wi.prepareTaskWorkspace(getTask(id));
  const second = await wi.prepareTaskWorkspace(getTask(id));

  assert.equal(second.alreadyPrepared, true);
  assert.equal(second.path, first.path);
  assert.equal(getTask(id).workspace_path, first.path);
});

test('prepareTaskWorkspace: repo task creates git worktree on autopilot/<slug> branch', async () => {
  const title = `Worktree Test ${randomUUID().slice(0, 6)}`;
  const projectDir = path.join(projectsPath, slugify(title));
  fs.mkdirSync(projectDir, { recursive: true });

  execSync('git init', { cwd: projectDir, stdio: 'pipe' });
  execSync('git config user.email test@mc.local && git config user.name "Test Runner"', { cwd: projectDir, stdio: 'pipe' });
  execSync('git checkout -b main', { cwd: projectDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(projectDir, 'file.txt'), 'hello\n');
  execSync('git add -A && git commit -m init', { cwd: projectDir, stdio: 'pipe' });

  const id = insertTask({ title, repo_url: 'https://github.com/example/dummy-repo.git' });
  const ws = await wi.prepareTaskWorkspace(getTask(id));

  assert.equal(ws.alreadyPrepared, false);
  assert.equal(ws.strategy, 'worktree');
  assert.ok(ws.branch?.startsWith('autopilot/'), ws.branch);
  assert.ok(ws.path.includes('.workspaces'), ws.path);
  assert.ok(fs.existsSync(ws.path), 'worktree dir must exist');
  assert.equal(getTask(id).workspace_path, ws.path);
  assert.equal(getTask(id).workspace_strategy, 'worktree');

  // Cleanup worktree so the repo stays consistent for other tests
  try {
    execSync(`git worktree remove --force "${ws.path}"`, { cwd: projectDir, stdio: 'pipe' });
  } catch { /* ignore */ }
});

test('mergeWorkspace: no-repo prepared task → no_repo status, never NO_MERGE', async () => {
  const id = insertTask({ status: 'done' });
  await wi.prepareTaskWorkspace(getTask(id));
  const prepared = getTask(id);
  assert.ok(prepared.workspace_path, 'prepared task must have workspace_path');

  const result = await wi.mergeWorkspace(prepared as never);
  assert.equal(result.status, 'no_repo');
  assert.equal(result.success, true);
  assert.equal(getTask(id).merge_status, 'no_repo');
  // NO_MERGE flag must never be raised for a prepared task
  assert.notEqual(getTask(id).merge_status, 'missing_workspace_path');
});

test('triggerWorkspaceMerge: done task with prepared workspace merges (NO_MERGE flag not raised)', async () => {
  const id = insertTask({ status: 'done' });
  await wi.prepareTaskWorkspace(getTask(id));

  const result = await wi.triggerWorkspaceMerge(id);
  assert.ok(result, 'merge must run — workspace_path exists');
  assert.equal(result.status, 'no_repo');
  assert.notEqual(getTask(id).merge_status, 'missing_workspace_path');
});
