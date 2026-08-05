import test from 'node:test';
import assert from 'node:assert/strict';

import { run, queryOne } from './db';
import {
  resolveSessionHealthConfig,
  evaluateSessionHealth,
  resolveDispatchSession,
  buildRotatedSessionKey,
  estimateLiveContextFromHistory,
  estimateTokensFromChars,
  buildModelWindowMap,
  enrichGatewaySessionMetrics,
  DEFAULT_MAX_TOTAL_TOKENS,
  DEFAULT_CTX_HIGH_WATER_PCT,
  type GatewaySessionInfo,
  type SessionHealthConfig,
} from './session-health';
import type { OpenClawSession } from './types';

// ── Config (env-driven thresholds) ──

test('resolveSessionHealthConfig: defaults are 1M / 90%', () => {
  const cfg = resolveSessionHealthConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.maxTotalTokens, DEFAULT_MAX_TOTAL_TOKENS);
  assert.equal(cfg.ctxHighWaterPct, DEFAULT_CTX_HIGH_WATER_PCT);
});

test('resolveSessionHealthConfig: honors env overrides', () => {
  const cfg = resolveSessionHealthConfig({
    PLATFORM_SESSION_MAX_TOTAL_TOKENS: '500000',
    PLATFORM_SESSION_CTX_HIGH_WATER_PCT: '70',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.maxTotalTokens, 500_000);
  assert.equal(cfg.ctxHighWaterPct, 70);
});

test('resolveSessionHealthConfig: invalid env falls back to defaults', () => {
  const cfg = resolveSessionHealthConfig({
    PLATFORM_SESSION_MAX_TOTAL_TOKENS: 'banana',
    PLATFORM_SESSION_CTX_HIGH_WATER_PCT: '-5',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.maxTotalTokens, DEFAULT_MAX_TOTAL_TOKENS);
  assert.equal(cfg.ctxHighWaterPct, DEFAULT_CTX_HIGH_WATER_PCT);
});

// ── Health evaluation (pure) ──

test('evaluateSessionHealth: healthy active session with no tokens → healthy, no churn', () => {
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 0, run_number: 1 },
    config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
  });
  assert.equal(verdict.healthy, true);
  assert.deepEqual(verdict.reasons, []);
});

test('evaluateSessionHealth: cumulative totalTokens above cap → unhealthy (MRN-104 pattern)', () => {
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 7_100_000, run_number: 1 },
    gatewayInfo: { totalTokens: 7_100_000, contextTokens: 1_000_000 },
    contextWindow: 1_000_000,
    config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
  });
  assert.equal(verdict.healthy, false);
  assert.ok(verdict.reasons.some(r => r.startsWith('total_tokens_exceeded')));
  assert.equal(verdict.totalTokens, 7_100_000);
});

test('evaluateSessionHealth: gateway status failed → unhealthy even if DB row is active', () => {
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 1000, run_number: 1 },
    gatewayInfo: { totalTokens: 1000, contextTokens: 1_000_000, status: 'failed' },
    contextWindow: 1_000_000,
    config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
  });
  assert.equal(verdict.healthy, false);
  assert.ok(verdict.reasons.some(r => r.startsWith('gateway_status:failed')));
});

test('evaluateSessionHealth: gateway running/active status is healthy', () => {
  for (const status of ['active', 'running']) {
    const verdict = evaluateSessionHealth({
      dbSession: { status: 'active', total_tokens: 1000, run_number: 1 },
      gatewayInfo: { totalTokens: 1000, contextTokens: 1_000_000, status },
      contextWindow: 1_000_000,
      config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
    });
    assert.equal(verdict.healthy, true, `status ${status} must be healthy`);
  }
});

test('evaluateSessionHealth: gateway window-fallback is NOT treated as live context (no false-positive rotation)', () => {
  // Healthy session, gateway reports totalTokens=50k and contextTokens == window
  // (fallback) — must stay healthy.
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 50_000, run_number: 1 },
    gatewayInfo: { totalTokens: 50_000, contextTokens: 1_000_000 },
    contextWindow: 1_000_000,
    config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
  });
  assert.equal(verdict.healthy, true);
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.ctxPct, null);
});

test('evaluateSessionHealth: non-active status (failed/blocked) → unhealthy', () => {
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'failed', total_tokens: 0, run_number: 1 },
    config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
  });
  assert.equal(verdict.healthy, false);
  assert.ok(verdict.reasons.some(r => r.startsWith('session_status:failed')));
});

test('evaluateSessionHealth: live context above high-water % → unhealthy', () => {
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 1000, run_number: 1 },
    gatewayInfo: { totalTokens: 1000, contextTokens: 1_000_000 },
    estimatedContextTokens: 950_000, // 95% of 1M window, cap 90%
    contextWindow: 1_000_000,
    config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
  });
  assert.equal(verdict.healthy, false);
  assert.ok(verdict.reasons.some(r => r.startsWith('ctx_high_water')));
});

test('evaluateSessionHealth: honest metric split — ctxPct from LIVE context, cumulativePct separate', () => {
  // Gateway fills contextTokens with the window when no live estimate exists.
  const noLive = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 7_100_000, run_number: 1 },
    gatewayInfo: { totalTokens: 7_100_000, contextTokens: 1_000_000 },
    contextWindow: 1_000_000,
    config: { maxTotalTokens: 10_000_000, ctxHighWaterPct: 90 },
  });
  // Without a live estimate the honest ctx% is null — never 718%.
  assert.equal(noLive.ctxPct, null);
  assert.equal(noLive.cumulativePct, 710);

  // With a live estimate, ctx% reflects live context only.
  const withLive = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 7_100_000, run_number: 1 },
    gatewayInfo: { totalTokens: 7_100_000, contextTokens: 1_000_000 },
    estimatedContextTokens: 120_000,
    contextWindow: 1_000_000,
    config: { maxTotalTokens: 10_000_000, ctxHighWaterPct: 90 },
  });
  assert.equal(withLive.ctxPct, 12);
  assert.equal(withLive.cumulativePct, 710);
});

// ── Transcript-tail fallback ──

test('estimateTokensFromChars: ~4 chars per token', () => {
  assert.equal(estimateTokensFromChars(400), 100);
  assert.equal(estimateTokensFromChars(0), 0);
  assert.equal(estimateTokensFromChars(-5), 0);
});

test('estimateLiveContextFromHistory: sums message content, null on empty', () => {
  assert.equal(estimateLiveContextFromHistory(null), null);
  assert.equal(estimateLiveContextFromHistory([]), null);
  const history = [
    { role: 'user', content: 'a'.repeat(400) },
    { role: 'assistant', content: 'b'.repeat(800) },
    { role: 'toolResult', content: { nested: 'c'.repeat(400) } },
  ];
  const est = estimateLiveContextFromHistory(history);
  assert.ok(est !== null && est > 0, 'estimates tokens from tail');
});

// ── Rotation key ──

test('buildRotatedSessionKey: run-numbered + unique suffix', () => {
  const a = buildRotatedSessionKey('Builder', 'task-1', 2, 'abc12345');
  const b = buildRotatedSessionKey('Builder', 'task-1', 2, 'xyz98765');
  assert.ok(a.includes('mission-control-builder-task-1-r2-abc12345'));
  assert.notEqual(a, b, 'unique suffix prevents gateway-key collision on repeated rotations');
});

// ── D1 honest metrics enrichment ──

test('enrichGatewaySessionMetrics: window fallback detected, ctx% honest', () => {
  // row.contextTokens === window → gateway fell back, no live estimate
  const m1 = enrichGatewaySessionMetrics(
    { totalTokens: 7_100_000, contextTokens: 1_000_000 } as GatewaySessionInfo,
    1_000_000
  );
  assert.equal(m1.ctxPct, null);
  assert.equal(m1.cumulativeRunPct, 710);
  assert.equal(m1.totalTokens, 7_100_000);

  // live estimate provided explicitly
  const m2 = enrichGatewaySessionMetrics(
    { totalTokens: 7_100_000, contextTokens: 1_000_000 } as GatewaySessionInfo,
    1_000_000,
    200_000
  );
  assert.equal(m2.ctxPct, 20);
  assert.equal(m2.cumulativeRunPct, 710);
});

test('buildModelWindowMap: provider/model and bare-id lookups', () => {
  const map = buildModelWindowMap([
    { id: 'deepseek-v4-pro', provider: 'opencode-go', contextWindow: 1_000_000 },
    { id: 'gpt-5.5', provider: 'openai', contextWindow: 400_000 },
    { id: 'broken', provider: 'x' }, // no window → skipped
  ]);
  assert.equal(map['opencode-go/deepseek-v4-pro'], 1_000_000);
  assert.equal(map['deepseek-v4-pro'], 1_000_000);
  assert.equal(map['broken'], undefined);
});

// ── A1 core: resolveDispatchSession (DB-backed) ──

function seedAgentAndTask(): { agentId: string; taskId: string } {
  const agentId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, status, workspace_id)
     VALUES (?, 'Test Builder', 'builder', 'standby', 'default')`,
    [agentId]
  );
  run(
    `INSERT OR IGNORE INTO tasks (id, title, status, workspace_id)
     VALUES (?, 'PLATFORM-008 test task', 'in_progress', 'default')`,
    [taskId]
  );
  return { agentId, taskId };
}

function insertSession(overrides: Partial<OpenClawSession>): OpenClawSession {
  const id = crypto.randomUUID();
  const base = {
    id,
    agent_id: '',
    openclaw_session_id: `mission-control-test-builder-${id}`,
    task_id: '',
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
  run(
    `INSERT INTO openclaw_sessions
       (id, agent_id, openclaw_session_id, task_id, channel, status, session_type, total_tokens, context_tokens, run_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.agent_id, row.openclaw_session_id, row.task_id, row.channel,
      row.status, row.session_type, row.total_tokens, row.context_tokens, row.run_number,
      row.created_at, row.updated_at,
    ]
  );
  const saved = queryOne<OpenClawSession>('SELECT * FROM openclaw_sessions WHERE id = ?', [id]);
  assert.ok(saved, 'session row must persist');
  return saved!;
}

const cfg: SessionHealthConfig = { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 };
const PREFIX = 'agent:builder:';

test('resolveDispatchSession: no previous session → creates run 1 (no rotation)', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const res = resolveDispatchSession({
    taskId,
    agentId,
    agentName: 'Test Builder',
    gatewaySessions: [],
    existingSession: null,
    sessionKeyPrefix: PREFIX,
    config: cfg,
  });
  assert.equal(res.rotated, false);
  assert.equal(res.runNumber, 1);
  assert.equal(res.reusedExistingSession, false);
  assert.equal(res.session.openclaw_session_id, `mission-control-test-builder-${taskId}`);
});

test('resolveDispatchSession: BLOATED session → retry produces a NEW session key (A1 acceptance)', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const bloated = insertSession({
    agent_id: agentId,
    task_id: taskId,
    openclaw_session_id: `mission-control-test-builder-${taskId}`,
    total_tokens: 7_100_000, // > 1M cap — the MRN-104 failure mode
    run_number: 1,
  });

  const res = resolveDispatchSession({
    taskId,
    agentId,
    agentName: 'Test Builder',
    gatewaySessions: [{ key: `${PREFIX}${bloated.openclaw_session_id}`, totalTokens: 7_100_000, contextTokens: 1_000_000 }],
    existingSession: bloated,
    sessionKeyPrefix: PREFIX,
    config: cfg,
  });

  assert.equal(res.rotated, true, 'bloated session must be rotated');
  assert.ok(res.rotationReasons.some(r => r.startsWith('total_tokens_exceeded')));
  assert.equal(res.runNumber, 2);
  assert.notEqual(res.session.openclaw_session_id, bloated.openclaw_session_id, 'session key must change');
  assert.ok(res.session.openclaw_session_id.includes(`-r2-`), 'rotated key is run-numbered');

  // Old row is marked rotated, new row active.
  const oldRow = queryOne<{ status: string }>('SELECT status FROM openclaw_sessions WHERE id = ?', [bloated.id]);
  assert.equal(oldRow!.status, 'rotated');
  const newRow = queryOne<{ status: string }>('SELECT status FROM openclaw_sessions WHERE id = ?', [res.session.id]);
  assert.equal(newRow!.status, 'active');
});

test('resolveDispatchSession: healthy session → REUSED, no churn (A1 anti-churn)', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const healthy = insertSession({
    agent_id: agentId,
    task_id: taskId,
    openclaw_session_id: `mission-control-test-builder-${taskId}`,
    total_tokens: 50_000,
    run_number: 1,
  });

  const res = resolveDispatchSession({
    taskId,
    agentId,
    agentName: 'Test Builder',
    gatewaySessions: [{ key: `${PREFIX}${healthy.openclaw_session_id}`, totalTokens: 50_000, contextTokens: 1_000_000 }],
    existingSession: healthy,
    sessionKeyPrefix: PREFIX,
    config: cfg,
  });

  assert.equal(res.rotated, false, 'healthy session must not be rotated');
  assert.equal(res.reusedExistingSession, true);
  assert.equal(res.session.id, healthy.id);
  assert.equal(res.session.openclaw_session_id, healthy.openclaw_session_id);
});

test('resolveDispatchSession: failed previous run → new session key (never reuse blocked session)', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const failed = insertSession({
    agent_id: agentId,
    task_id: taskId,
    openclaw_session_id: `mission-control-test-builder-${taskId}`,
    status: 'failed',
    total_tokens: 120_000,
    run_number: 1,
  });

  const res = resolveDispatchSession({
    taskId,
    agentId,
    agentName: 'Test Builder',
    gatewaySessions: [],
    existingSession: failed,
    sessionKeyPrefix: PREFIX,
    config: cfg,
  });

  assert.equal(res.rotated, true);
  assert.ok(res.rotationReasons.some(r => r.startsWith('session_status:failed')));
  assert.notEqual(res.session.openclaw_session_id, failed.openclaw_session_id);
});

test('resolveDispatchSession: live context near window (transcript-tail estimate) → rotate', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const session = insertSession({
    agent_id: agentId,
    task_id: taskId,
    openclaw_session_id: `mission-control-test-builder-${taskId}`,
    total_tokens: 200_000,
    run_number: 1,
  });
  const key = `${PREFIX}${session.openclaw_session_id}`;

  const res = resolveDispatchSession({
    taskId,
    agentId,
    agentName: 'Test Builder',
    gatewaySessions: [{ key, totalTokens: 200_000, contextTokens: 1_000_000 }],
    contextEstimates: { [key]: 960_000 }, // 96% of window > 90% high-water
    contextWindow: 1_000_000,
    existingSession: session,
    sessionKeyPrefix: PREFIX,
    config: cfg,
  });

  assert.equal(res.rotated, true);
  assert.ok(res.rotationReasons.some(r => r.startsWith('ctx_high_water')));
});

test('resolveDispatchSession: repeated rotations never collide on the same gateway key', () => {
  const { agentId, taskId } = seedAgentAndTask();
  let current = insertSession({
    agent_id: agentId,
    task_id: taskId,
    openclaw_session_id: `mission-control-test-builder-${taskId}`,
    total_tokens: 2_000_000,
    run_number: 1,
  });

  const keys = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const res = resolveDispatchSession({
      taskId,
      agentId,
      agentName: 'Test Builder',
      gatewaySessions: [],
      existingSession: current,
      sessionKeyPrefix: PREFIX,
      config: cfg,
    });
    assert.equal(res.rotated, true);
    assert.ok(!keys.has(res.session.openclaw_session_id), 'every rotation key is unique');
    keys.add(res.session.openclaw_session_id);
    current = res.session;
    // Fresh rows start at 0 tokens — re-bloat to force the next rotation.
    run('UPDATE openclaw_sessions SET total_tokens = 2000000 WHERE id = ?', [current.id]);
    current = queryOne<OpenClawSession>('SELECT * FROM openclaw_sessions WHERE id = ?', [current.id])!;
  }
  assert.equal(keys.size, 3);
});
