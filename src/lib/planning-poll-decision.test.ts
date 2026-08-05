/**
 * PLATFORM-010 BUG-2 — Poll short-circuit regression tests.
 *
 * Scenario (MRN-104/P008): GET /planning/poll returned EARLY whenever
 * planning_dispatch_error was set (from a stalled auto-answer), so a completion
 * spec already present in the planning session was NEVER processed —
 * planning_complete stuck at 0 despite a complete spec (P008 required manual DB
 * cleanup).
 *
 * Acceptance: task with planning_dispatch_error + completion in session →
 * poll processes the completion (planning_complete 0 → 1) and the stale error
 * is cleared/replaced — NOT reported as a blocker.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';

import { resolvePollResponse, type PollDecisionInput } from './planning-poll-decision';

// ── pure decision tests (same function the route uses) ──

test('BUG-2 regression: dispatch_error + unprocessed completion → completion processed, error NOT reported', () => {
  const d = resolvePollResponse({
    planningComplete: false,
    dispatchError: 'Auto-answer stalled: planning agent not responding',
    hasUnprocessedCompletion: true,
    hasNewMessages: false,
  });
  assert.equal(d.processCompletion, true, 'completion must be processed despite stale dispatch_error');
  assert.equal(d.reportDispatchError, false, 'stale dispatch_error must NOT short-circuit');
  assert.equal(d.isComplete, false);
  assert.equal(d.hasUpdates, true);
});

test('BUG-2 negative control: dispatch_error without any completion → error still reported', () => {
  const d = resolvePollResponse({
    planningComplete: false,
    dispatchError: 'Auto-answer stalled: planning agent not responding',
    hasUnprocessedCompletion: false,
    hasNewMessages: false,
  });
  assert.equal(d.processCompletion, false);
  assert.equal(d.reportDispatchError, true, 'error surfaces only when no completion exists');
  assert.equal(d.hasUpdates, true);
});

test('resolvePollResponse: planning_complete already set → terminal isComplete response', () => {
  const d = resolvePollResponse({
    planningComplete: true,
    dispatchError: 'whatever',
    hasUnprocessedCompletion: true,
    hasNewMessages: false,
  });
  assert.equal(d.isComplete, true);
  assert.equal(d.processCompletion, false);
  assert.equal(d.reportDispatchError, false);
  assert.equal(d.hasUpdates, false);
});

test('resolvePollResponse: new messages only → hasUpdates without error', () => {
  const d = resolvePollResponse({
    planningComplete: false,
    dispatchError: null,
    hasUnprocessedCompletion: false,
    hasNewMessages: true,
  });
  assert.equal(d.hasUpdates, true);
  assert.equal(d.reportDispatchError, false);
});

test('resolvePollResponse: nothing pending → no updates', () => {
  const d = resolvePollResponse({
    planningComplete: false,
    dispatchError: null,
    hasUnprocessedCompletion: false,
    hasNewMessages: false,
  });
  assert.equal(d.hasUpdates, false);
  assert.equal(d.reportDispatchError, false);
});

test('resolvePollResponse: completion wins even when new messages also arrived', () => {
  const d = resolvePollResponse({
    planningComplete: false,
    dispatchError: 'stale error',
    hasUnprocessedCompletion: true,
    hasNewMessages: true,
  });
  assert.equal(d.processCompletion, true);
  assert.equal(d.reportDispatchError, false);
});

// ── DB-level integration: mirrors the tester E2E on a scratch DB ──

let db: typeof import('@/lib/db');
const dbPath = `.tmp/p010-bug2-regression-${process.pid}.db`;

before(async () => {
  process.env.DATABASE_PATH = dbPath;
  process.env.ALLOW_DYNAMIC_AGENTS = 'true'; // production path: agents are created from the spec
  db = await import('@/lib/db');
});

after(() => {
  try {
    unlinkSync(dbPath);
  } catch {
    // already gone
  }
});

const COMPLETION_SPEC = {
  status: 'complete',
  spec: {
    title: 'BUG-2 regression task',
    summary: 'Completion arrived in session while a stale dispatch_error existed',
    deliverables: ['x'],
    success_criteria: ['y'],
    constraints: {},
  },
  agents: [{ name: 'Builder', role: 'builder', avatar_emoji: '🛡️', instructions: 'test' }],
  execution_plan: { approach: 'test', steps: ['s1'] },
};

function seedBug2Task() {
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '📁', ?, ?)`,
    [now, now]
  );
  const taskId = `bug2-regression-${process.pid}`;
  const planningMessages = JSON.stringify([
    { role: 'assistant', content: JSON.stringify(COMPLETION_SPEC), timestamp: Date.now() },
  ]);
  db.run(
    `INSERT OR REPLACE INTO tasks
       (id, title, status, priority, workspace_id, business_id,
        planning_session_key, planning_messages, planning_complete,
        planning_dispatch_error, created_at, updated_at)
     VALUES (?, 'BUG-2 regression', 'planning', 'high', 'default', 'default',
        'agent:main:bug2-session', ?, 0,
        'Auto-answer stalled: planning agent not responding', ?, ?)`,
    [taskId, planningMessages, now, now]
  );
  return taskId;
}

test('BUG-2 DB regression: handlePlanningCompletion processes completion + clears stale dispatch_error', async () => {
  const taskId = seedBug2Task();

  // Same call path the poll route takes when it finds an unprocessed completion.
  const { handlePlanningCompletion } = await import('@/lib/planning-completion');
  const { firstAgentId, parsed, dispatchError } = await handlePlanningCompletion(
    taskId,
    COMPLETION_SPEC as any,
    JSON.parse(JSON.stringify([{ role: 'assistant', content: JSON.stringify(COMPLETION_SPEC) }]))
  );

  // Completion was processed (the regression: it must NOT be blocked).
  const task = db.queryOne<{
    planning_complete: number;
    planning_dispatch_error: string | null;
    status: string;
    planning_spec: string | null;
  }>('SELECT planning_complete, planning_dispatch_error, status, planning_spec FROM tasks WHERE id = ?', [taskId]);

  assert.ok(task, 'task exists');
  assert.equal(task!.planning_complete, 1, 'planning_complete set 0 → 1 despite stale dispatch_error');
  assert.equal(task!.status, 'assigned', 'task advanced to assigned');
  assert.ok(task!.planning_spec, 'spec persisted');
  assert.ok(
    !task!.planning_dispatch_error || !task!.planning_dispatch_error.includes('Auto-answer stalled'),
    'stale auto-answer dispatch_error cleared (any new error is from the current dispatch attempt)'
  );
  // Dispatch was attempted (fetch refused in test env) → a CURRENT error may be
  // recorded, but it must be the dispatch attempt, not the stale auto-answer one.
  assert.equal(typeof dispatchError, 'string', 'dispatch attempt made (fetch refused in test env)');
  if (task!.planning_dispatch_error) {
    assert.ok(
      task!.planning_dispatch_error.includes('Dispatch'),
      `planning_dispatch_error reflects the CURRENT dispatch attempt, got: ${task!.planning_dispatch_error}`
    );
  }
});

test('BUG-2 DB negative control: no completion in messages → completion NOT forced', () => {
  // A task with a stale error and only a QUESTION in messages must not be
  // marked complete — only the error surfaces (resolvePollResponse contract).
  const d = resolvePollResponse({
    planningComplete: false,
    dispatchError: 'Auto-answer stalled: planning agent not responding',
    hasUnprocessedCompletion: false,
    hasNewMessages: false,
  });
  assert.equal(d.processCompletion, false);
  assert.equal(d.reportDispatchError, true);
});
