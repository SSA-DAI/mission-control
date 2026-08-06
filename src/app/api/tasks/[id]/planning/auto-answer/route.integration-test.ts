/**
 * PLATFORM-020 — Route-level integration test for
 * POST /api/tasks/:id/planning/auto-answer (time-budget engine).
 *
 * Drives the REAL route handler end-to-end (planning state read, message sync,
 * PLATFORM-016 idempotency guard, chat.send, completion detection,
 * approve+dispatch, stallResponse) against a temp SQLite DB. Only the OpenClaw
 * gateway I/O is scripted (node:test mock.module) to simulate a planning agent.
 *
 * Scenarios (acceptance of PLATFORM-020):
 *  1. Slow-but-progressing agent → route COMPLETES within the time budget
 *     (regression: PLATFORM-009 false stall must not happen), answered=3,
 *     progress log populated with per-iteration entries incl. elapsedMs.
 *  2. Stuck agent (never responds) → stall code `time_budget_exhausted`
 *     (NOT `max_iterations`), reason lists the remaining question + manual
 *     follow-up suggestion, progress log preserved.
 *
 * Run (requires the experimental module-mocks flag; excluded from `npm test`
 * by naming convention `*.integration-test.ts`):
 *   npx tsx --experimental-test-module-mocks --test --test-concurrency=1 \
 *     "src/app/api/tasks/[id]/planning/auto-answer/route.integration-test.ts"
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { mock } from 'node:test';
import { NextRequest } from 'next/server';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const repoRoot = new URL('../../../../../../../', import.meta.url).pathname;
const dbPath = `${repoRoot}.tmp/auto-answer-route-${process.pid}.db`;
process.env.DATABASE_PATH = dbPath;

// ── scripted "planning agent" state ──────────────────────────────────────────
type AgentMode = 'slow-progress' | 'stuck';
let agentMode: AgentMode = 'slow-progress';
let chatSendCount = 0; // number of answers the auto-answer has sent so far

const Q1 = { question: 'Scope cukup jelas?', options: [{ id: 'A', label: 'Ya' }, { id: 'B', label: 'Tidak' }], recommended: 'A' };
const Q2 = { question: 'Prioritas tinggi?', options: [{ id: 'A', label: 'Tinggi' }, { id: 'B', label: 'Normal' }], recommended: 'A' };
const Q3 = { question: 'Perlu UAT?', options: [{ id: 'A', label: 'Ya' }, { id: 'B', label: 'Tidak' }], recommended: 'A' };
const QUESTIONS = [Q1, Q2, Q3];
const COMPLETE = {
  status: 'complete',
  spec: { title: 'P020 Integration', summary: 'route-level', deliverables: [], success_criteria: [], constraints: {} },
  agents: [],
};

const fakeClient = {
  isConnected: () => true,
  connect: async () => {},
  call: async (method: string) => {
    if (method === 'chat.send') {
      chatSendCount++;
      return { ok: true, message: { id: `msg-${chatSendCount}` } };
    }
    return {};
  },
};

/**
 * Slow-but-progressing agent: after each answer the auto-answer sends, the
 * agent produces its next message (one assistant message more than answers
 * sent). The real agent latency is simulated with a short sleep; the route's
 * own waitForAgentResponse poll window (20s) then dominates the wall time,
 * which is exactly the "healthy but slow" regime PLATFORM-009 was about.
 */
async function fakeGetMessagesFromOpenClaw(): Promise<Array<{ role: string; content: string }>> {
  if (agentMode === 'stuck') {
    await sleep(300);
    return []; // agent never responds
  }
  await sleep(400);
  const msgs: Array<{ role: string; content: string }> = [];
  for (let i = 0; i <= chatSendCount && i < QUESTIONS.length; i++) {
    msgs.push({ role: 'assistant', content: JSON.stringify(QUESTIONS[i]) });
  }
  if (chatSendCount >= QUESTIONS.length) {
    msgs.push({ role: 'assistant', content: JSON.stringify(COMPLETE) });
  }
  return msgs;
}

let POST: typeof import('./route').POST;

before(async () => {
  // Grab the real extractJSON, then replace the module with the scripted agent.
  const realPlanningUtils = await import('@/lib/planning-utils');
  // `exports` is the current runtime shape of MockModuleOptions; older
  // @types/node only knows `namedExports` — cast through the declared type.
  const utilsMock = {
    exports: {
      extractJSON: realPlanningUtils.extractJSON,
      getMessagesFromOpenClaw: fakeGetMessagesFromOpenClaw as typeof realPlanningUtils.getMessagesFromOpenClaw,
    },
  } as unknown as Parameters<typeof mock.module>[1];
  mock.module('@/lib/planning-utils', utilsMock);

  const clientMock = {
    exports: {
      getOpenClawClient: () => fakeClient,
    },
  } as unknown as Parameters<typeof mock.module>[1];
  mock.module('@/lib/openclaw/client', clientMock);

  const db = await import('@/lib/db');
  db.run(`INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('default', 'Default', 'default')`);

  // Task 1: healthy-but-slow planning (3 questions then complete).
  db.run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, planning_session_key, planning_messages, planning_complete)
     VALUES ('t-slow-progress', 'P020 slow progress', 'planning', 'low', 'default', 'session-slow', '[]', 0)`
  );
  // Task 2: stuck planning (agent never responds).
  db.run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, planning_session_key, planning_messages, planning_complete)
     VALUES ('t-stuck', 'P020 stuck', 'planning', 'low', 'default', 'session-stuck', '[]', 0)`
  );

  const route = await import('./route');
  POST = route.POST;
});

after(() => {
  try {
    unlinkSync(dbPath);
  } catch {}
});

function callPost(id: string): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost/api/tasks/${id}/planning/auto-answer`, { method: 'POST' }),
    { params: Promise.resolve({ id }) }
  );
}

// ── 1. slow-but-progress → completes within the time budget ─────────────────

test('route: slow-but-progress planning completes within time budget (no false stall)', async () => {
  process.env.AUTO_ANSWER_TIMEOUT_MS = '120000'; // 2 menit ≫ ~65s runtime
  agentMode = 'slow-progress';
  chatSendCount = 0;

  const startedAt = Date.now();
  const res = await callPost('t-slow-progress');
  const body = await res.json();
  const elapsed = Date.now() - startedAt;

  assert.equal(res.status, 200);
  assert.equal(body.success, true, `expected success, got ${JSON.stringify(body).slice(0, 300)}`);
  assert.equal(body.completionDetected, true);
  assert.equal(body.answered, 3, 'all three questions must be answered');
  assert.ok(body.iterations >= 4, `expected ≥4 iterations, got ${body.iterations}`);

  // Time budget honored: must NOT have stalled.
  assert.equal(body.stall, undefined);

  // Progress log: one entry per iteration with action + elapsedMs.
  const log = body.iterationLog as Array<{ iteration: number; action: string; questionSnippet?: string; elapsedMs: number }>;
  assert.ok(Array.isArray(log) && log.length >= 3, `progress log expected, got ${JSON.stringify(log)?.slice(0, 200)}`);
  const answeredEntries = log.filter((e) => e.action === 'answered_question');
  assert.equal(answeredEntries.length, 3);
  for (const entry of log) {
    assert.equal(typeof entry.elapsedMs, 'number');
    assert.ok(entry.elapsedMs >= 0);
  }
  assert.ok(answeredEntries[0].questionSnippet, 'progress entry must carry the question snippet');

  // Sanity: the whole run stayed well inside the 120s budget.
  assert.ok(elapsed < 120_000, `run took ${elapsed}ms — should be well inside budget`);
  console.log(`[Integration] slow-but-progress: completed in ${elapsed}ms, ${body.iterations} iterasi, ${body.answered} dijawab, progress log ${log.length} entri`);
});

// ── 2. stuck → time budget exhaustion stall (NOT max_iterations) ────────────

test('route: stuck planning stalls on time_budget_exhausted, not max_iterations', async () => {
  process.env.AUTO_ANSWER_TIMEOUT_MS = '8000'; // budget kecil agar test cepat
  agentMode = 'stuck';
  chatSendCount = 0;

  const res = await callPost('t-stuck');
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.success, false);
  assert.equal(body.stall, true);
  assert.equal(body.stall_code, 'time_budget_exhausted', `expected budget stall, got ${body.stall_code}`);
  assert.notEqual(body.stall_code, 'max_iterations');
  // Budget must fire long before the 50-iteration hard ceiling: the stall
  // happened at iteration ~5, visible via the progress log (the stall response
  // contract does not expose an `iterations` field).
  const stallEntry = body.iterationLog[body.iterationLog.length - 1];
  assert.ok(stallEntry.iteration < 50, `budget must fire long before the 50-iteration ceiling (got ${stallEntry.iteration})`);
  assert.equal(stallEntry.action, 'time_budget_exhausted');
  assert.ok(body.reason.includes('menit'), 'reason must state the budget in minutes');
  assert.ok(body.reason.includes('Lanjutkan manual'), 'reason must suggest continuing manually');
  assert.equal(typeof body.userMessage, 'string');
  assert.equal(body.nextAction, 'Lanjutkan Manual');

  // Progress log preserved on the stall response.
  const log = body.iterationLog as Array<{ action: string; elapsedMs: number }>;
  assert.ok(Array.isArray(log) && log.length >= 1, 'stall response must carry the progress log');
  for (const entry of log) {
    assert.equal(typeof entry.elapsedMs, 'number');
    assert.ok(entry.elapsedMs >= 0);
  }

  // Task row got the stall reason persisted.
  const { queryOne } = await import('@/lib/db');
  const task = queryOne('SELECT status_reason, planning_dispatch_error FROM tasks WHERE id = ?', ['t-stuck']) as {
    status_reason: string | null;
    planning_dispatch_error: string | null;
  };
  assert.ok(String(task.status_reason).includes('time_budget_exhausted'), `status_reason persisted, got ${task.status_reason}`);
  const stallIter = body.iterationLog[body.iterationLog.length - 1]?.iteration;
  console.log(`[Integration] stuck: stall ${body.stall_code} setelah iterasi ${stallIter} — bukan max_iterations`);
});
