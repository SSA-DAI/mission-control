import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// PLATFORM-018 integration tests: task worktree isolation lifecycle.
//
// Proves the acceptance criteria end-to-end against REAL git repos:
//  1. agent worktree initialized from origin/HEAD, branch platform-<id>/<short>
//  2. agent commits in the worktree NEVER appear on the shared main branch
//  3. landing cherry-picks onto main + pushes → history in sync with origin
//  4. supervisor can keep committing/pushing on main (no regression)
//  5. second agent worktree lands in correct history order
//  6. cherry-pick conflict → merge_status 'blocked' + worktree KEPT + main clean
//  7. edge cases: dirty shared tree, origin unreachable, no changes to land
//
// Hermetic: own DATABASE_PATH + repo dirs per process (node:test runs each
// file in its own process), unique task ids, no empty-DB assumptions.

const pid = process.pid;
const dbPath = path.join(process.cwd(), `.tmp/worktree-manager-test-${pid}.db`);
const testRoot = path.join(process.cwd(), `.tmp/wt-test-${pid}`);

type Db = {
  run: (sql: string, params?: unknown[]) => unknown;
  queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => T | undefined;
};

type Wtm = typeof import('@/lib/worktree-manager');
type Task = { id: string; title: string; status: string; priority: string; workspace_id: string; business_id: string; repo_url: string; [k: string]: unknown };

let db: Db;
let wtm: Wtm;

before(async () => {
  fs.mkdirSync('.tmp', { recursive: true });
  fs.mkdirSync(testRoot, { recursive: true });
  process.env.DATABASE_PATH = dbPath;
  process.env.WORKTREE_REPO_PATH = path.join(testRoot, 'default', 'supervisor');
  process.env.WORKTREE_TASK_ROOT = path.join(testRoot, 'default', 'tasks');
  process.env.WORKTREE_MAIN_BRANCH = 'main';
  db = (await import('@/lib/db')) as unknown as Db;
  wtm = await import('@/lib/worktree-manager');
});

after(() => {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Git helpers ─────────────────────────────────────────────────────

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(repo: string, args: string[]): boolean {
  try { git(repo, args); return true; } catch { return false; }
}

function setupRepoPair(dir: string): { origin: string; supervisor: string } {
  fs.mkdirSync(dir, { recursive: true });
  const origin = path.join(dir, 'origin.git');
  const supervisor = path.join(dir, 'supervisor');
  git(dir, ['init', '--bare', '-b', 'main', origin]);
  git(dir, ['clone', origin, supervisor]);
  for (const c of [['user.email', 'test@example.com'], ['user.name', 'Test Supervisor'], ['commit.gpgsign', 'false']]) {
    git(supervisor, ['config', c[0], c[1]]);
  }
  git(supervisor, ['commit', '--allow-empty', '-m', 'init']);
  git(supervisor, ['push', '-u', 'origin', 'main']);
  return { origin, supervisor };
}

function writeFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content);
}

function insertTask(overrides: Record<string, unknown> = {}): Task {
  const id = `wt-test-${randomUUID()}`;
  const row: Record<string, unknown> = {
    title: 'Worktree Isolation Test',
    status: 'in_progress',
    priority: 'normal',
    workspace_id: 'default',
    business_id: 'default',
    ...overrides,
  };
  const cols = ['id', ...Object.keys(row)];
  const vals: unknown[] = [id, ...Object.values(row)];
  db.run(`INSERT INTO tasks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
  return db.queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id])!;
}

function configFor(dir: string) {
  return {
    repoPath: path.join(dir, 'supervisor'),
    taskRoot: path.join(dir, 'tasks'),
    mainBranch: 'main',
    enabled: true,
  };
}

// ─── Full integration: agent → landing → supervisor → agent ──────────

test('PLATFORM-018 full flow: worktree isolation → cherry-pick landing → supervisor → second agent', async () => {
  const pair = setupRepoPair(path.join(testRoot, 'flow'));
  const config = configFor(path.join(testRoot, 'flow'));
  const origin = pair.origin;
  const supervisor = pair.supervisor;
  const originMain = `origin/main`;

  // ── 1. Worktree creation from origin/HEAD with platform branch naming ──
  const taskA = insertTask({ repo_url: origin, repo_branch: 'main' });
  const wtA = await wtm.createTaskWorktree(taskA, config);

  assert.ok(fs.existsSync(wtA.worktreePath), 'worktree dir exists');
  assert.match(wtA.branchName, /^platform-[a-z0-9]{8}\/[0-9a-f]{7}$/, `branch naming platform-<id>/<short>: ${wtA.branchName}`);
  assert.equal(wtA.branchName, wtA.branch);
  assert.equal(wtA.mainBranch, 'main');
  assert.ok(gitOk(supervisor, ['rev-parse', '--verify', wtA.branchName]), 'branch registered in shared repo');
  // Worktree HEAD == origin/HEAD (base commit), not local supervisor HEAD drift.
  const originHead = git(supervisor, ['rev-parse', originMain]);
  assert.equal(git(wtA.worktreePath, ['rev-parse', 'HEAD']), originHead, 'worktree initialized from origin/HEAD');
  assert.equal(git(wtA.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), wtA.branchName);
  // Supervisor working tree untouched.
  assert.equal(git(supervisor, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'supervisor still on main');
  assert.equal(git(supervisor, ['status', '--porcelain']), '', 'supervisor tree clean');
  const taskARow = db.queryOne<{ workspace_path: string; workspace_strategy: string; merge_status: string }>(
    'SELECT workspace_path, workspace_strategy, merge_status FROM tasks WHERE id = ?', [taskA.id]);
  assert.equal(taskARow?.workspace_path, wtA.worktreePath, 'tasks.workspace_path persisted');
  assert.equal(taskARow?.workspace_strategy, 'worktree');

  // ── 2. Agent commit stays isolated; never touches shared main ──
  writeFile(wtA.worktreePath, 'feature-a.txt', 'agent-a\n');
  git(wtA.worktreePath, ['add', 'feature-a.txt']);
  git(wtA.worktreePath, ['commit', '-m', 'agent commit A']);
  const agentCommitA = git(wtA.worktreePath, ['rev-parse', 'HEAD']);

  assert.ok(!git(supervisor, ['log', '--oneline', 'main']).includes('agent commit A'), 'agent commit NOT on shared main');
  assert.equal(git(supervisor, ['rev-parse', 'HEAD']), originHead, 'shared main unchanged by agent work');

  // ── 3. Landing: cherry-pick onto main + push → origin sync ──
  const landA = await wtm.landTaskWorktree(taskA.id, config);
  assert.equal(landA.ok, true, landA.log);
  assert.equal(landA.status, 'landed', landA.log);
  assert.ok(landA.landedCommits.includes(agentCommitA), 'agent commit cherry-picked');
  assert.ok(git(supervisor, ['log', '--oneline', 'main']).includes('agent commit A'), 'agent commit landed on main');
  assert.equal(git(supervisor, ['log', '--oneline', `${originMain}..HEAD`]), '', 'local main in sync with origin (no divergence)');
  assert.ok(git(supervisor, ['log', '--oneline', originMain]).includes('agent commit A'), 'origin has landed commit');
  // Cleanup policy: worktree + branch removed after successful landing.
  assert.ok(!fs.existsSync(wtA.worktreePath), 'worktree removed after landing');
  assert.ok(!gitOk(supervisor, ['rev-parse', '--verify', wtA.branchName]), 'branch deleted after landing');
  const merged = db.queryOne<{ merge_status: string }>('SELECT merge_status FROM tasks WHERE id = ?', [taskA.id]);
  assert.equal(merged?.merge_status, 'merged');

  // ── 4. Supervisor commits on main afterward — no conflict, no regression ──
  writeFile(supervisor, 'sup.txt', 'supervisor\n');
  git(supervisor, ['add', 'sup.txt']);
  git(supervisor, ['commit', '-m', 'supervisor commit after landing']);
  git(supervisor, ['push', 'origin', 'main']);
  assert.ok(git(supervisor, ['log', '--oneline', `${originMain}..HEAD`]) === '', 'supervisor push keeps sync');

  // ── 5. Second agent worktree → landing again → history order preserved ──
  const taskB = insertTask({ repo_url: origin, repo_branch: 'main' });
  const wtB = await wtm.createTaskWorktree(taskB, config);
  assert.equal(git(wtB.worktreePath, ['rev-parse', 'HEAD']), git(supervisor, ['rev-parse', originMain]), 'task B base = latest origin/HEAD');
  writeFile(wtB.worktreePath, 'feature-b.txt', 'agent-b\n');
  git(wtB.worktreePath, ['add', 'feature-b.txt']);
  git(wtB.worktreePath, ['commit', '-m', 'agent commit B']);

  const landB = await wtm.landTaskWorktree(taskB.id, config);
  assert.equal(landB.ok, true, landB.log);
  assert.equal(landB.status, 'landed', landB.log);

  const fullHistory = git(supervisor, ['log', '--format=%s', 'main']).split('\n').reverse();
  const order = fullHistory.map((s, i) => [s, i] as const);
  const idxInit = order.find(([s]) => s === 'init')?.[1] ?? -1;
  const idxA = order.find(([s]) => s === 'agent commit A')?.[1] ?? -1;
  const idxSup = order.find(([s]) => s === 'supervisor commit after landing')?.[1] ?? -1;
  const idxB = order.find(([s]) => s === 'agent commit B')?.[1] ?? -1;
  assert.ok(idxInit < idxA && idxA < idxSup && idxSup < idxB, `history order init→A→sup→B: ${fullHistory.join(' | ')}`);
  assert.equal(git(supervisor, ['log', '--oneline', `${originMain}..HEAD`]), '', 'final origin sync');
});

// ─── Conflict handling ───────────────────────────────────────────────

test('PLATFORM-018 cherry-pick conflict → blocked + worktree kept + main restored clean', async () => {
  const pair = setupRepoPair(path.join(testRoot, 'conflict'));
  const config = configFor(path.join(testRoot, 'conflict'));
  const origin = pair.origin;
  const supervisor = pair.supervisor;

  // init: shared.txt line 1 = "v1\n"
  writeFile(supervisor, 'shared.txt', 'v1\n');
  git(supervisor, ['add', 'shared.txt']);
  git(supervisor, ['commit', '-m', 'init shared.txt']);
  git(supervisor, ['push', 'origin', 'main']);

  // Agent worktree based on v1; agent rewrites line 1 → "agent-a\n"
  const taskA = insertTask({ repo_url: origin, repo_branch: 'main' });
  const wtA = await wtm.createTaskWorktree(taskA, config);
  writeFile(wtA.worktreePath, 'shared.txt', 'agent-a\n');
  git(wtA.worktreePath, ['add', 'shared.txt']);
  git(wtA.worktreePath, ['commit', '-m', 'agent rewrites shared line']);

  // Supervisor rewrites the SAME line first and pushes → cherry-pick must conflict
  writeFile(supervisor, 'shared.txt', 'sup\n');
  git(supervisor, ['add', 'shared.txt']);
  git(supervisor, ['commit', '-m', 'supervisor rewrites shared line']);
  git(supervisor, ['push', 'origin', 'main']);

  const land = await wtm.landTaskWorktree(taskA.id, config);
  assert.equal(land.ok, false, 'conflict must not report success');
  assert.equal(land.status, 'conflict', land.log);
  assert.ok((land.conflictFiles || []).includes('shared.txt'), `conflict file detected: ${land.conflictFiles}`);
  assert.ok(fs.existsSync(wtA.worktreePath), 'worktree KEPT on conflict');
  assert.ok(gitOk(supervisor, ['rev-parse', '--verify', wtA.branchName]), 'branch KEPT on conflict');
  assert.equal(git(supervisor, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'main branch restored after abort');
  assert.equal(git(supervisor, ['status', '--porcelain']), '', 'shared tree clean after abort');
  assert.equal(git(supervisor, ['log', '--oneline', 'origin/main..HEAD']), '', 'no stray commits on main after abort');

  const taskRow = db.queryOne<{ merge_status: string; status_reason: string | null }>(
    'SELECT merge_status, status_reason FROM tasks WHERE id = ?', [taskA.id]);
  assert.equal(taskRow?.merge_status, 'blocked', 'merge_status = blocked');
  assert.ok((taskRow?.status_reason || '').includes('WORKTREE_LAND_CONFLICT'), 'status_reason flags conflict');

  // Manual resolve then cleanup works.
  const cleanup = wtm.cleanupTaskWorktree(taskA.id, config);
  assert.equal(cleanup.ok, true, cleanup.log);
  assert.ok(!fs.existsSync(wtA.worktreePath), 'worktree removed by cleanup');
  assert.ok(!gitOk(supervisor, ['rev-parse', '--verify', wtA.branchName]), 'branch removed by cleanup');
});

// ─── Edge cases ──────────────────────────────────────────────────────

test('PLATFORM-018 dirty shared tree blocks create (pre-flight clean-tree check)', async () => {
  const pair = setupRepoPair(path.join(testRoot, 'dirty'));
  const config = configFor(path.join(testRoot, 'dirty'));
  const task = insertTask({ repo_url: pair.origin, repo_branch: 'main' });

  writeFile(pair.supervisor, 'uncommitted.txt', 'dirty\n'); // no commit

  await assert.rejects(
    () => wtm.createTaskWorktree(task, config),
    /Pre-flight failed before create.*clean tree|uncommitted changes|Working tree has uncommitted/,
    'create must refuse when supervisor tree is dirty'
  );

  // Clean it up; create succeeds again.
  fs.rmSync(path.join(pair.supervisor, 'uncommitted.txt'), { force: true });
  const wt = await wtm.createTaskWorktree(task, config);
  assert.ok(fs.existsSync(wt.worktreePath), 'create works after tree cleaned');
  await wtm.landTaskWorktree(task.id, config);
});

test('PLATFORM-018 origin unreachable blocks create (pre-flight origin check)', async () => {
  const pair = setupRepoPair(path.join(testRoot, 'unreachable'));
  const config = configFor(path.join(testRoot, 'unreachable'));
  const task = insertTask({ repo_url: pair.origin, repo_branch: 'main' });

  git(pair.supervisor, ['remote', 'set-url', 'origin', 'http://127.0.0.1:9/unreachable.git']);

  await assert.rejects(
    () => wtm.createTaskWorktree(task, config),
    /Pre-flight failed before create.*Origin unreachable|origin unreachable/i,
    'create must refuse when origin is unreachable'
  );
});

test('PLATFORM-018 no changes to land → no_changes (idempotent, non-blocking)', async () => {
  const pair = setupRepoPair(path.join(testRoot, 'nochanges'));
  const config = configFor(path.join(testRoot, 'nochanges'));
  const task = insertTask({ repo_url: pair.origin, repo_branch: 'main' });

  const wt = await wtm.createTaskWorktree(task, config);
  const land = await wtm.landTaskWorktree(task.id, config);
  assert.equal(land.ok, true, land.log);
  assert.equal(land.status, 'no_changes', land.log);
  assert.equal(git(pair.supervisor, ['log', '--oneline', 'origin/main..HEAD']), '', 'still in sync');
  assert.ok(fs.existsSync(wt.worktreePath), 'worktree retained on no_changes (nothing landed)');
  // Second call also safe (idempotent).
  const again = await wtm.landTaskWorktree(task.id, config);
  assert.equal(again.status, 'no_changes', again.log);
});

test('PLATFORM-018 landing conflict detection via re-land returns blocked consistently', async () => {
  const pair = setupRepoPair(path.join(testRoot, 'reland'));
  const config = configFor(path.join(testRoot, 'reland'));
  const origin = pair.origin;
  const supervisor = pair.supervisor;

  writeFile(supervisor, 'f.txt', 'v1\n');
  git(supervisor, ['add', 'f.txt']);
  git(supervisor, ['commit', '-m', 'init f']);
  git(supervisor, ['push', 'origin', 'main']);

  const task = insertTask({ repo_url: origin, repo_branch: 'main' });
  const wt = await wtm.createTaskWorktree(task, config);
  writeFile(wt.worktreePath, 'f.txt', 'agent\n');
  git(wt.worktreePath, ['add', 'f.txt']);
  git(wt.worktreePath, ['commit', '-m', 'agent change']);

  writeFile(supervisor, 'f.txt', 'sup\n');
  git(supervisor, ['add', 'f.txt']);
  git(supervisor, ['commit', '-m', 'sup change']);
  git(supervisor, ['push', 'origin', 'main']);

  const first = await wtm.landTaskWorktree(task.id, config);
  assert.equal(first.status, 'conflict', first.log);
  const second = await wtm.landTaskWorktree(task.id, config);
  assert.equal(second.status, 'conflict', 're-land on unresolved conflict stays blocked');
  assert.ok(fs.existsSync(wt.worktreePath), 'worktree still kept');
  assert.equal(git(supervisor, ['status', '--porcelain']), '', 'shared repo clean across repeated aborts');
  // sanity: gitOk helper used to keep linter happy about unused origin vars
  assert.ok(gitOk(supervisor, ['rev-parse', '--verify', 'HEAD']));
});
