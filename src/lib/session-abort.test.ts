import test from 'node:test';
import assert from 'node:assert/strict';
import {
  abortGatewayTurn,
  abortAndVerifySessionIdle,
  rotateDispatchSessionWithAbort,
  waitForSessionIdle,
  rotationAbortGuard,
  resolveInternalAbortUrl,
  callInternalAbortEndpoint,
  type GatewayClientLike,
} from './session-abort';
import type { GatewaySessionInfo } from './session-health';

// ── KESULTANAN-FIX-002: gateway-level abort→verify for busy-session rotation ──
// Unit tests for the abort + idle-verification contract. The fake client lets
// us assert ordering (abort before create is tested at the orchestration layer)
// and timeout/blocking behavior without a live gateway.

const KEY = 'agent:builder:mission-control-task-1';

function row(overrides: Partial<GatewaySessionInfo> = {}): GatewaySessionInfo {
  return { key: KEY, sessionId: 'sess-1', status: 'running', hasActiveRun: true, ...overrides };
}

/** Fake gateway client with scripted listSessions responses. */
class FakeClient implements GatewayClientLike {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  rows: GatewaySessionInfo[] = [];
  chatAbortError: Error | null = null;
  chatAbortResult: { ok?: boolean; aborted?: boolean; runIds?: string[] } = { ok: true, aborted: true, runIds: ['run-1'] };
  listError: Error | null = null;

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'chat.abort') {
      if (this.chatAbortError) throw this.chatAbortError;
      return this.chatAbortResult as T;
    }
    throw new Error(`unexpected method ${method}`);
  }

  async listSessions(): Promise<GatewaySessionInfo[]> {
    if (this.listError) throw this.listError;
    return this.rows;
  }
}

// ── waitForSessionIdle ──

test('waitForSessionIdle: row with active run → waits until idle', async () => {
  const client = new FakeClient();
  client.rows = [row({ hasActiveRun: true, status: 'running' })];
  let polls = 0;
  const list = async () => {
    polls += 1;
    client.rows = polls >= 2 ? [row({ hasActiveRun: false, status: 'done' })] : [row({ hasActiveRun: true, status: 'running' })];
    return client.rows;
  };
  const result = await waitForSessionIdle({
    client,
    sessionKey: KEY,
    timeoutMs: 5000,
    verifyIntervalMs: 5,
    listSessionsOverride: list,
  });
  assert.equal(result.idle, true);
  assert.equal(result.status, 'done');
  assert.equal(result.hasActiveRun, false);
});

test('waitForSessionIdle: status leaves busy set → idle', async () => {
  const client = new FakeClient();
  client.rows = [row({ status: 'running', hasActiveRun: true })];
  const list = async () => {
    client.rows = [row({ status: 'done', hasActiveRun: false })];
    return client.rows;
  };
  const result = await waitForSessionIdle({ client, sessionKey: KEY, timeoutMs: 1000, verifyIntervalMs: 5, listSessionsOverride: list });
  assert.equal(result.idle, true);
  assert.equal(result.status, 'done');
});

test('waitForSessionIdle: missing row → idle (nothing running)', async () => {
  const client = new FakeClient();
  client.rows = [];
  const result = await waitForSessionIdle({ client, sessionKey: KEY, timeoutMs: 1000, verifyIntervalMs: 5 });
  assert.equal(result.idle, true);
  assert.equal(result.row, null);
});

test('waitForSessionIdle: still busy past deadline → NOT idle (timeout)', async () => {
  const client = new FakeClient();
  client.rows = [row({ status: 'running', hasActiveRun: true })];
  let t = 1_000_000;
  const result = await waitForSessionIdle({
    client,
    sessionKey: KEY,
    timeoutMs: 30,
    verifyIntervalMs: 5,
    now: () => {
      t += 50;
      return t;
    },
  });
  assert.equal(result.idle, false);
  assert.equal(result.status, 'running');
  assert.equal(result.hasActiveRun, true);
});

test('waitForSessionIdle: matches by sessionId when key spelling drifts', async () => {
  const client = new FakeClient();
  client.rows = [{ key: 'agent:builder:other', sessionId: 'sess-1', status: 'idle', hasActiveRun: false }];
  const result = await waitForSessionIdle({ client, sessionKey: KEY, sessionId: 'sess-1', timeoutMs: 1000 });
  assert.equal(result.idle, true);
});

// ── abortGatewayTurn (WS transport) ──

test('abortGatewayTurn: WS transport calls chat.abort with the session key', async () => {
  const client = new FakeClient();
  const result = await abortGatewayTurn({ client, sessionKey: KEY, forceWs: true });
  assert.equal(result.ok, true);
  assert.equal(result.aborted, true);
  assert.deepEqual(result.runIds, ['run-1']);
  assert.equal(result.transport, 'ws');
  const abortCall = client.calls.find(c => c.method === 'chat.abort');
  assert.ok(abortCall, 'chat.abort must be called');
  assert.equal(abortCall.params?.sessionKey, KEY);
});

test('abortGatewayTurn: WS transport surfaces transport errors (abort failed)', async () => {
  const client = new FakeClient();
  client.chatAbortError = new Error('scope denied');
  const result = await abortGatewayTurn({ client, sessionKey: KEY, forceWs: true });
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.includes('scope denied'));
});

test('abortGatewayTurn: idle session → ok with aborted=false (idempotent no-op)', async () => {
  const client = new FakeClient();
  client.chatAbortResult = { ok: true, aborted: false, runIds: [] };
  const result = await abortGatewayTurn({ client, sessionKey: KEY, forceWs: true });
  assert.equal(result.ok, true);
  assert.equal(result.aborted, false);
});

// ── abortGatewayTurn (internal endpoint transport) ──

test('callInternalAbortEndpoint: posts sessionKey + secret, parses response', async () => {
  const captured: { value: { url: string; headers: Record<string, string>; body: string } | null } = { value: null };
  const fetchImpl = async (url: unknown, init: unknown) => {
    captured.value = {
      url: String(url),
      headers: (init as { headers: Record<string, string> }).headers,
      body: (init as { body: string }).body,
    };
    return new Response(JSON.stringify({ ok: true, aborted: true, runIds: ['r1'] }), { status: 200 });
  };
  const result = await callInternalAbortEndpoint({
    sessionKey: KEY,
    endpointUrl: 'http://127.0.0.1:18789/api/v1/internal/abort',
    gatewayToken: 'tok',
    endpointSecret: 's3cret',
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(result.ok, true);
  assert.equal(result.aborted, true);
  assert.equal(captured.value?.url, 'http://127.0.0.1:18789/api/v1/internal/abort');
  assert.equal(captured.value?.headers['x-openclaw-internal-abort-secret'], 's3cret');
  assert.equal(captured.value?.headers['Authorization'], 'Bearer tok');
  assert.ok(captured.value?.body.includes(KEY));
});

test('callInternalAbortEndpoint: HTTP error surfaces as abort failure', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ ok: false, error: { message: 'forbidden key' } }), { status: 403 });
  const result = await callInternalAbortEndpoint({
    sessionKey: KEY,
    endpointUrl: 'http://x/api/v1/internal/abort',
    endpointSecret: 's3cret',
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.ok(result.error && result.error.includes('forbidden key'));
});

test('abortGatewayTurn: endpoint transport preferred when secret configured', async () => {
  const client = new FakeClient();
  let calledEndpoint = false;
  const fetchImpl = async () => {
    calledEndpoint = true;
    return new Response(JSON.stringify({ ok: true, aborted: true, runIds: ['r1'] }), { status: 200 });
  };
  const result = await abortGatewayTurn({
    client,
    sessionKey: KEY,
    endpointUrl: 'http://x/api/v1/internal/abort',
    endpointSecret: 's3cret',
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(calledEndpoint, true);
  assert.equal(result.transport, 'endpoint');
  assert.equal(result.ok, true);
  assert.equal(client.calls.length, 0, 'WS chat.abort must NOT be called when endpoint is configured');
});

test('abortGatewayTurn: endpoint failure does NOT silently fall back to WS', async () => {
  const client = new FakeClient();
  const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error: { message: 'nope' } }), { status: 403 });
  const result = await abortGatewayTurn({
    client,
    sessionKey: KEY,
    endpointUrl: 'http://x/api/v1/internal/abort',
    endpointSecret: 's3cret',
    fetchImpl: fetchImpl as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(result.transport, 'endpoint');
  assert.equal(client.calls.length, 0, 'must not silently fall through to WS on endpoint rejection');
});

test('resolveInternalAbortUrl: derives URL from gateway WS URL', () => {
  const url = resolveInternalAbortUrl({ OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:18789' } as unknown as NodeJS.ProcessEnv);
  assert.equal(url, 'http://127.0.0.1:18789/api/v1/internal/abort');
});

test('resolveInternalAbortUrl: explicit GATEWAY_ABORT_URL wins', () => {
  const url = resolveInternalAbortUrl({
    OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:18789',
    GATEWAY_ABORT_URL: 'http://gw:9999/internal/abort',
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(url, 'http://gw:9999/internal/abort');
});

// ── abortAndVerifySessionIdle (combined contract) ──

test('abortAndVerifySessionIdle: abort then verify → ok when idle confirmed', async () => {
  const client = new FakeClient();
  client.rows = [row({ status: 'done', hasActiveRun: false })];
  const result = await abortAndVerifySessionIdle({
    client,
    sessionKey: KEY,
    timeoutMs: 1000,
    verifyIntervalMs: 5,
    forceWs: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.aborted, true);
  assert.equal(result.verifiedIdle, true);
  assert.equal(result.transport, 'ws');
  assert.equal(client.calls.filter(c => c.method === 'chat.abort').length, 1);
});

test('abortAndVerifySessionIdle: verify timeout → ok=false, verifiedIdle=false (rotation must block)', async () => {
  const client = new FakeClient();
  client.rows = [row({ status: 'running', hasActiveRun: true })];
  let t = 1_000_000;
  const result = await abortAndVerifySessionIdle({
    client,
    sessionKey: KEY,
    timeoutMs: 30,
    verifyIntervalMs: 5,
    forceWs: true,
    now: () => {
      t += 50;
      return t;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verifiedIdle, false);
  assert.equal(result.timedOut, true);
  assert.ok(result.error);
});

test('abortAndVerifySessionIdle: abort transport failure → ok=false immediately', async () => {
  const client = new FakeClient();
  client.chatAbortError = new Error('gateway unreachable');
  const result = await abortAndVerifySessionIdle({ client, sessionKey: KEY, forceWs: true, timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.verifiedIdle, false);
  assert.ok(result.error && result.error.includes('gateway unreachable'));
});

// ── rotationAbortGuard (blocking rules) ──

test('rotationAbortGuard: busy rotation + failed abort → BLOCKED', () => {
  const guard = rotationAbortGuard({
    reasons: ['session_busy:active_run'],
    gatewayKey: KEY,
    abortResult: { ok: false, aborted: false, runIds: [], verifiedIdle: false, status: 'running', transport: 'ws', timeoutMs: 100, error: 'timeout' },
  });
  assert.equal(guard.proceed, false);
  assert.ok(guard.blockedReason);
});

test('rotationAbortGuard: busy rotation + verified idle → proceed', () => {
  const guard = rotationAbortGuard({
    reasons: ['session_busy:active_run'],
    gatewayKey: KEY,
    abortResult: { ok: true, aborted: true, runIds: ['r1'], verifiedIdle: true, status: 'done', transport: 'ws', timeoutMs: 100 },
  });
  assert.equal(guard.proceed, true);
  assert.equal(guard.blockedReason, null);
});

test('rotationAbortGuard: non-busy rotation without active run → proceed even when probe fails', () => {
  const guard = rotationAbortGuard({
    reasons: ['total_tokens_exceeded:500000'],
    gatewayKey: KEY,
    abortResult: null, // no abort attempted (gateway hiccup)
    oldRow: { key: KEY, status: 'done', hasActiveRun: false },
  });
  assert.equal(guard.proceed, true);
  assert.equal(guard.blockedReason, null);
});

test('rotationAbortGuard: non-busy reason but old row HAS active run + unverified → BLOCKED', () => {
  const guard = rotationAbortGuard({
    reasons: ['total_tokens_exceeded:500000'],
    gatewayKey: KEY,
    abortResult: { ok: false, aborted: false, runIds: [], verifiedIdle: false, status: 'running', transport: 'ws', timeoutMs: 100, error: 'timeout' },
    oldRow: { key: KEY, status: 'running', hasActiveRun: true },
  });
  assert.equal(guard.proceed, false);
});

test('rotationAbortGuard: forceBlockOnFailure blocks any unverified rotation', () => {
  const guard = rotationAbortGuard({
    reasons: ['session_busy:auto-recovery'],
    gatewayKey: KEY,
    abortResult: { ok: false, aborted: false, runIds: [], verifiedIdle: false, status: null, transport: 'ws', timeoutMs: 100, error: 'boom' },
    forceBlockOnFailure: true,
  });
  assert.equal(guard.proceed, false);
});

// ── rotateDispatchSessionWithAbort (abort→verify→create, DB-backed) ──

import { run as dbRun, queryOne } from './db';
import {
  planDispatchSession,
  commitRotationPlan,
  type DispatchSessionPlan,
} from './session-health';
import type { OpenClawSession } from './types';

const AGENT_ID = 'agent-1';
const AGENT_NAME = 'Builder';

function freshTaskId(): string {
  return `task-abort-orch-${Math.random().toString(36).slice(2, 10)}`;
}

// openclaw_sessions has FKs to agents(id) + tasks(id) with foreign_keys=ON,
// so the orchestration tests seed real agent + task rows first.
function ensureAgentAndTask(taskId: string): void {
  dbRun(
    `INSERT OR IGNORE INTO agents (id, name, role, status, session_key_prefix, created_at, updated_at)
     VALUES (?, 'Builder', 'builder', 'standby', 'agent:builder:', datetime('now'), datetime('now'))`,
    [AGENT_ID]
  );
  dbRun(
    `INSERT OR IGNORE INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Abort orchestration', 'assigned', 'normal', 'default', 'default', datetime('now'), datetime('now'))`,
    [taskId]
  );
}

function insertSession(taskId: string, overrides: Partial<OpenClawSession>): OpenClawSession {
  ensureAgentAndTask(taskId);
  const id = crypto.randomUUID();
  const base = {
    id,
    agent_id: AGENT_ID,
    openclaw_session_id: `mission-control-${AGENT_NAME.toLowerCase()}-${taskId}`,
    task_id: taskId,
    channel: 'mission-control',
    status: 'active',
    session_type: 'persistent' as const,
    total_tokens: 0,
    context_tokens: 0,
    run_number: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const row = { ...base, ...overrides };
  dbRun(
    `INSERT INTO openclaw_sessions
       (id, agent_id, openclaw_session_id, task_id, channel, status, session_type, total_tokens, context_tokens, run_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.agent_id, row.openclaw_session_id, row.task_id, row.channel, row.status, row.session_type, row.total_tokens, row.context_tokens, row.run_number, row.created_at, row.updated_at]
  );
  return row as OpenClawSession;
}

function busyPlan(taskId: string, previousSession: OpenClawSession): DispatchSessionPlan {
  return planDispatchSession({
    taskId,
    agentId: AGENT_ID,
    agentName: AGENT_NAME,
    gatewaySessions: [
      { key: `agent:builder:${previousSession.openclaw_session_id}`, sessionId: previousSession.openclaw_session_id, status: 'running', hasActiveRun: true },
    ],
    existingSession: previousSession,
    sessionKeyPrefix: 'agent:builder:',
    busyOverride: { busy: true, reason: 'busy_session:active_run', status: 'running', source: 'gateway' },
  }) as DispatchSessionPlan & { action: 'rotate' };
}

test('rotateDispatchSessionWithAbort: busy rotation → abort + verify BEFORE create (run 2 row only after idle)', async () => {
  const taskId = freshTaskId();
  const previous = insertSession(taskId, {});
  const plan = busyPlan(taskId, previous);
  assert.equal(plan.action, 'rotate');

  const client = new FakeClient();
  client.rows = [row({ key: plan.gatewayKey, sessionId: previous.openclaw_session_id, status: 'done', hasActiveRun: false })];

  const outcome = await rotateDispatchSessionWithAbort({
    plan,
    client,
    oldSessionId: previous.openclaw_session_id,
    timeoutMs: 1000,
    verifyIntervalMs: 5,
    forceWs: true,
  });

  assert.equal(outcome.blocked, false);
  assert.ok(outcome.session, 'new session must be created');
  assert.equal(outcome.abortResult?.aborted, true);
  assert.equal(outcome.abortResult?.verifiedIdle, true);
  assert.notEqual(outcome.session!.id, previous.id);
  assert.equal(outcome.session!.run_number, 2);
  // abort must have been called BEFORE the create commit
  assert.equal(client.calls.filter(c => c.method === 'chat.abort').length, 1, 'chat.abort must be called exactly once');
  // old row marked rotated, new row active
  const oldRow = queryOne<{ status: string }>('SELECT status FROM openclaw_sessions WHERE id = ?', [previous.id]);
  assert.equal(oldRow?.status, 'rotated');
  const newRow = queryOne<{ status: string }>('SELECT status FROM openclaw_sessions WHERE id = ?', [outcome.session!.id]);
  assert.equal(newRow?.status, 'active');
  dbRun('DELETE FROM openclaw_sessions WHERE task_id = ?', [taskId]);
  dbRun('DELETE FROM tasks WHERE id = ?', [taskId]);
});

test('rotateDispatchSessionWithAbort: abort FAILS → rotation BLOCKED, no new session row, old stays active', async () => {
  const taskId = freshTaskId();
  const previous = insertSession(taskId, {});
  const plan = busyPlan(taskId, previous);
  const client = new FakeClient();
  client.chatAbortError = new Error('gateway unreachable');

  const outcome = await rotateDispatchSessionWithAbort({
    plan,
    client,
    oldSessionId: previous.openclaw_session_id,
    timeoutMs: 1000,
    verifyIntervalMs: 5,
    forceWs: true,
  });

  assert.equal(outcome.blocked, true);
  assert.equal(outcome.session, null, 'no new session row on blocked rotation');
  assert.ok(outcome.blockedReason);
  // DB must be untouched: old row still active, no run-2 row
  const oldRow = queryOne<{ status: string }>('SELECT status FROM openclaw_sessions WHERE id = ?', [previous.id]);
  assert.equal(oldRow?.status, 'active');
  const run2 = queryOne<{ id: string }>(
    'SELECT id FROM openclaw_sessions WHERE agent_id = ? AND task_id = ? AND run_number = 2',
    [AGENT_ID, taskId]
  );
  assert.equal(run2, undefined, 'run 2 must NOT exist when rotation is blocked');
  dbRun('DELETE FROM openclaw_sessions WHERE task_id = ?', [taskId]);
  dbRun('DELETE FROM tasks WHERE id = ?', [taskId]);
});

test('rotateDispatchSessionWithAbort: verify TIMEOUT → rotation BLOCKED, no new session row', async () => {
  const taskId = freshTaskId();
  const previous = insertSession(taskId, {});
  const plan = busyPlan(taskId, previous);
  const client = new FakeClient();
  client.rows = [row({ key: plan.gatewayKey, sessionId: previous.openclaw_session_id, status: 'running', hasActiveRun: true })];
  let t = 1_000_000;

  const outcome = await rotateDispatchSessionWithAbort({
    plan,
    client,
    oldSessionId: previous.openclaw_session_id,
    timeoutMs: 30,
    verifyIntervalMs: 5,
    forceWs: true,
    now: () => {
      t += 50;
      return t;
    },
  });

  assert.equal(outcome.blocked, true);
  assert.equal(outcome.session, null);
  assert.equal(outcome.abortResult?.timedOut, true);
  const run2 = queryOne<{ id: string }>(
    'SELECT id FROM openclaw_sessions WHERE agent_id = ? AND task_id = ? AND run_number = 2',
    [AGENT_ID, taskId]
  );
  assert.equal(run2, undefined, 'run 2 must NOT exist when verification times out');
  dbRun('DELETE FROM openclaw_sessions WHERE task_id = ?', [taskId]);
  dbRun('DELETE FROM tasks WHERE id = ?', [taskId]);
});

test('rotateDispatchSessionWithAbort: non-busy rotation + idle old row → proceeds without abort requirement', async () => {
  const taskId = freshTaskId();
  const previous = insertSession(taskId, {});
  const plan = planDispatchSession({
    taskId,
    agentId: AGENT_ID,
    agentName: AGENT_NAME,
    gatewaySessions: [
      { key: `agent:builder:${previous.openclaw_session_id}`, sessionId: previous.openclaw_session_id, status: 'done', hasActiveRun: false, totalTokens: 9_000_000 },
    ],
    existingSession: { ...previous, total_tokens: 9_000_000 },
    sessionKeyPrefix: 'agent:builder:',
  }) as DispatchSessionPlan & { action: 'rotate' };
  assert.equal(plan.action, 'rotate');

  const client = new FakeClient();
  client.rows = [row({ key: plan.gatewayKey, sessionId: previous.openclaw_session_id, status: 'done', hasActiveRun: false })];

  const outcome = await rotateDispatchSessionWithAbort({
    plan,
    client,
    oldSessionId: previous.openclaw_session_id,
    timeoutMs: 1000,
    verifyIntervalMs: 5,
    forceWs: true,
  });

  assert.equal(outcome.blocked, false);
  assert.ok(outcome.session);
  assert.equal(outcome.session!.run_number, 2);
  dbRun('DELETE FROM openclaw_sessions WHERE task_id = ?', [taskId]);
  dbRun('DELETE FROM tasks WHERE id = ?', [taskId]);
});

test('rotateDispatchSessionWithAbort: reuse plan → no abort, no new row', async () => {
  const taskId = freshTaskId();
  const previous = insertSession(taskId, {});
  const plan = planDispatchSession({
    taskId,
    agentId: AGENT_ID,
    agentName: AGENT_NAME,
    gatewaySessions: [
      { key: `agent:builder:${previous.openclaw_session_id}`, sessionId: previous.openclaw_session_id, status: 'idle', hasActiveRun: false },
    ],
    existingSession: previous,
    sessionKeyPrefix: 'agent:builder:',
  });
  assert.equal(plan.action, 'reuse');

  const client = new FakeClient();
  const outcome = await rotateDispatchSessionWithAbort({ plan, client });

  assert.equal(outcome.blocked, false);
  assert.equal(outcome.session?.id, previous.id, 'reuse keeps the same session');
  assert.equal(client.calls.length, 0, 'no abort call on reuse');
  dbRun('DELETE FROM openclaw_sessions WHERE task_id = ?', [taskId]);
  dbRun('DELETE FROM tasks WHERE id = ?', [taskId]);
});

test('route contract: rotate commits ONCE — reusing outcome.session keeps exactly 1 active row (double-commit regression)', async () => {
  // KESULTANAN-FIX-002 review finding: the dispatch route used to call
  // commitRotationPlan(plan) AGAIN after rotateDispatchSessionWithAbort had
  // already committed, creating TWO active run-2 rows for the same task.
  // This test pins the contract: on a successful rotate, the caller reuses
  // outcome.session and must NOT commit the plan a second time.
  const taskId = freshTaskId();
  const previous = insertSession(taskId, {});
  const plan = busyPlan(taskId, previous);
  const client = new FakeClient();
  client.rows = [row({ key: plan.gatewayKey, sessionId: previous.openclaw_session_id, status: 'done', hasActiveRun: false })];

  const outcome = await rotateDispatchSessionWithAbort({
    plan,
    client,
    oldSessionId: previous.openclaw_session_id,
    timeoutMs: 1000,
    verifyIntervalMs: 5,
    forceWs: true,
  });
  assert.equal(outcome.blocked, false);
  assert.ok(outcome.session);

  // Route pattern (fixed): use outcome.session — exactly one active row.
  const active1 = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM openclaw_sessions WHERE task_id = ? AND status = ?', [taskId, 'active']);
  assert.equal(active1?.c, 1, 'single commit → exactly 1 active row');
  assert.equal(outcome.session.run_number, 2);

  // Anti-pattern (pre-fix route): committing the plan again creates a
  // duplicate active row — must never happen in the dispatch route.
  const dup = commitRotationPlan(plan);
  const active2 = queryOne<{ c: number }>('SELECT COUNT(*) as c FROM openclaw_sessions WHERE task_id = ? AND status = ?', [taskId, 'active']);
  assert.equal(active2?.c, 2, 'double commit → 2 active rows (the bug the route fix prevents)');
  assert.notEqual(dup.id, outcome.session.id);
  dbRun('DELETE FROM openclaw_sessions WHERE task_id = ?', [taskId]);
  dbRun('DELETE FROM tasks WHERE id = ?', [taskId]);
});
