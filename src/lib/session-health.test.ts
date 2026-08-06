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
  detectSessionCorruptionMarkers,
  containsUnhealthyMarker,
  UNHEALTHY_SESSION_MARKERS,
  isBusySessionError,
  rotateToFreshSession,
  isSessionBusy,
  rotationReasonLabel,
  LOCAL_SESSION_BUSY_FRESHNESS_MS,
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

test('evaluateSessionHealth: gateway running = active turn → BUSY/unhealthy (P013), gateway active is healthy', () => {
  // PLATFORM-013 regression: OpenClaw 2026.7 marks a session 'running' from
  // run start until termination — reusing it while the previous turn is
  // still processing throws EmbeddedAttemptSessionTakeoverError (P009 stall).
  const busy = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 1000, run_number: 1 },
    gatewayInfo: { totalTokens: 1000, contextTokens: 1_000_000, status: 'running' },
    contextWindow: 1_000_000,
    config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
  });
  assert.equal(busy.healthy, false, 'running = busy → must rotate, never reuse');
  assert.ok(busy.reasons.includes('session_busy:running'), `reasons=${busy.reasons.join('|')}`);

  // 'active' remains the healthy gateway status (idle session reused).
  const idle = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 1000, run_number: 1 },
    gatewayInfo: { totalTokens: 1000, contextTokens: 1_000_000, status: 'active' },
    contextWindow: 1_000_000,
    config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
  });
  assert.equal(idle.healthy, true, 'active gateway status stays reusable');
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

// ── PLATFORM-010 A4: corruption marker detection ──

test('detectSessionCorruptionMarkers: null/empty input → null', () => {
  assert.equal(detectSessionCorruptionMarkers(null), null);
  assert.equal(detectSessionCorruptionMarkers([]), null);
  assert.equal(detectSessionCorruptionMarkers(undefined), null);
});

test('detectSessionCorruptionMarkers: healthy session history → null', () => {
  const history = [
    { role: 'user', content: 'Build a feature' },
    { role: 'assistant', content: 'I will build it' },
    { role: 'toolResult', content: JSON.stringify({ success: true }) },
  ];
  assert.equal(detectSessionCorruptionMarkers(history), null);
});

test('detectSessionCorruptionMarkers: memory-flush marker detected → returns marker + count', () => {
  const history = [
    { role: 'user', content: 'Write a file' },
    { role: 'toolResult', content: 'Error: Path escapes sandbox root /home/node/.openclaw/workspaces/main' },
    { role: 'assistant', content: 'Let me try another approach...' },
    { role: 'toolResult', content: 'Error: Memory flush writes are restricted in this session' },
  ];
  const result = detectSessionCorruptionMarkers(history);
  assert.ok(result !== null);
  assert.equal(result!.count, 2);
  assert.ok(result!.marker.includes('sandbox') || result!.marker.includes('Path escapes'));
});

test('detectSessionCorruptionMarkers: restricted marker in tool response → detected', () => {
  const history = [
    { role: 'toolResult', content: 'Error: write operation restricted in sandbox mode' },
  ];
  const result = detectSessionCorruptionMarkers(history);
  assert.ok(result !== null);
  assert.equal(result!.count, 1);
});

test('containsUnhealthyMarker: detects markers in text', () => {
  assert.equal(containsUnhealthyMarker('Path escapes sandbox root in file write'), true);
  assert.equal(containsUnhealthyMarker('Memory flush writes are restricted'), true);
  assert.equal(containsUnhealthyMarker('some normal output'), false);
  assert.equal(containsUnhealthyMarker(null), false);
  assert.equal(containsUnhealthyMarker(''), false);
});

// ── PLATFORM-010 A4: corruption markers in health evaluation ──

test('evaluateSessionHealth: memory-flush markers → unhealthy (corruption)', () => {
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 50_000, run_number: 1 },
    config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
    corruptionMarkers: { marker: 'Path escapes sandbox root', count: 11, firstOccurrence: 'Error details...' },
  });
  assert.equal(verdict.healthy, false);
  assert.ok(verdict.reasons.some(r => r.startsWith('session_corrupted')));
  assert.equal(verdict.corruptionMarker, 'Path escapes sandbox root');
  assert.equal(verdict.corruptionCount, 11);
});

test('evaluateSessionHealth: no corruption markers → corruption fields are null/0', () => {
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 50_000, run_number: 1 },
    config: { maxTotalTokens: 1_000_000, ctxHighWaterPct: 90 },
    corruptionMarkers: null,
  });
  assert.equal(verdict.healthy, true);
  assert.equal(verdict.corruptionMarker, null);
  assert.equal(verdict.corruptionCount, 0);
});

// ── PLATFORM-010 A4: corruption markers trigger rotation ──

test('resolveDispatchSession: corrupted session (markers) → rotated to new key', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const corrupted = insertSession({
    agent_id: agentId,
    task_id: taskId,
    openclaw_session_id: `mission-control-test-builder-${taskId}`,
    total_tokens: 50_000,
    run_number: 1,
  });
  const key = `${PREFIX}${corrupted.openclaw_session_id}`;

  const res = resolveDispatchSession({
    taskId,
    agentId,
    agentName: 'Test Builder',
    gatewaySessions: [{ key, totalTokens: 50_000, contextTokens: 1_000_000 }],
    corruptionMarkersBySession: {
      [key]: { marker: 'Memory flush writes are restricted', count: 3, firstOccurrence: 'Error...' },
    },
    existingSession: corrupted,
    sessionKeyPrefix: PREFIX,
    config: cfg,
  });

  assert.equal(res.rotated, true, 'corrupted session must be rotated');
  assert.ok(res.rotationReasons.some(r => r.startsWith('session_corrupted')));
  assert.ok(res.session.openclaw_session_id.includes('-r2-'));
});

test('UNHEALTHY_SESSION_MARKERS: all markers are lowercased for case-insensitive matching', () => {
  for (const marker of UNHEALTHY_SESSION_MARKERS) {
    assert.ok(typeof marker === 'string' && marker.length > 0);
  }
});

// ── PLATFORM-013: busy-session guard ──

test('evaluateSessionHealth: gateway hasActiveRun=true → unhealthy (session_busy:active_run)', () => {
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 1000, run_number: 1 },
    gatewayInfo: { status: 'active', hasActiveRun: true, activeRunIds: ['run-abc'] },
    config: cfg,
  });
  assert.equal(verdict.healthy, false);
  assert.ok(verdict.reasons.some(r => r === 'session_busy:active_run'));
});

test('evaluateSessionHealth: gateway status processing → unhealthy (session_busy:processing)', () => {
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 1000, run_number: 1 },
    gatewayInfo: { status: 'processing' },
    config: cfg,
  });
  assert.equal(verdict.healthy, false);
  assert.ok(verdict.reasons.some(r => r === 'session_busy:processing'));
});

test('evaluateSessionHealth: healthy idle session with no active run → healthy (no churn)', () => {
  const verdict = evaluateSessionHealth({
    dbSession: { status: 'active', total_tokens: 1000, run_number: 1 },
    gatewayInfo: { status: 'active', hasActiveRun: false, activeRunIds: [] },
    config: cfg,
  });
  assert.equal(verdict.healthy, true);
  assert.deepEqual(verdict.reasons, []);
});

test('resolveDispatchSession: session with ACTIVE RUN on gateway → rotated to NEW key (P013 acceptance)', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const busy = insertSession({
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
    gatewaySessions: [{ key: `${PREFIX}${busy.openclaw_session_id}`, status: 'active', hasActiveRun: true, activeRunIds: ['run-xyz'] }],
    existingSession: busy,
    sessionKeyPrefix: PREFIX,
    config: cfg,
  });

  assert.equal(res.rotated, true, 'busy session must be rotated, never reused');
  assert.equal(res.reusedExistingSession, false);
  assert.ok(res.rotationReasons.includes('session_busy:active_run'));
  assert.equal(res.runNumber, 2, 'busy session → runNumber+1');
  assert.notEqual(res.session.openclaw_session_id, busy.openclaw_session_id);
  assert.ok(res.session.openclaw_session_id.includes('-r2-'));

  const oldRow = queryOne<{ status: string }>('SELECT status FROM openclaw_sessions WHERE id = ?', [busy.id]);
  assert.equal(oldRow!.status, 'rotated');
});

test('resolveDispatchSession: session with gateway status queued → rotated (P013 expanded criteria)', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const queued = insertSession({
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
    gatewaySessions: [{ key: `${PREFIX}${queued.openclaw_session_id}`, status: 'queued' }],
    existingSession: queued,
    sessionKeyPrefix: PREFIX,
    config: cfg,
  });

  assert.equal(res.rotated, true);
  assert.ok(res.rotationReasons.some(r => r.startsWith('session_busy:')));
  assert.equal(res.runNumber, 2);
});

test('isBusySessionError: detects takeover/lock signatures, ignores unrelated errors', () => {
  assert.equal(isBusySessionError('EmbeddedAttemptSessionTakeoverError: session file changed while embedded prompt lock was released'), true);
  assert.equal(isBusySessionError('Session is busy, another turn is active'), true);
  assert.equal(isBusySessionError('Request timeout: chat.send'), false);
  assert.equal(isBusySessionError('Failed to connect to OpenClaw Gateway'), false);
  assert.equal(isBusySessionError(null), false);
  assert.equal(isBusySessionError(''), false);
});

test('rotateToFreshSession: marks previous rotated and creates runNumber+1 row', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const prev = insertSession({
    agent_id: agentId,
    task_id: taskId,
    openclaw_session_id: `mission-control-test-builder-${taskId}`,
    run_number: 2,
  });

  const rotated = rotateToFreshSession({
    taskId,
    agentId,
    agentName: 'Test Builder',
    previousSession: prev,
    reason: 'busy_session:auto-recovery',
  });

  assert.equal(rotated.runNumber, 3);
  assert.notEqual(rotated.session.openclaw_session_id, prev.openclaw_session_id);
  assert.ok(rotated.session.openclaw_session_id.includes('-r3-'));
  const oldRow = queryOne<{ status: string; rotation_reason: string | null }>(
    'SELECT status, rotation_reason FROM openclaw_sessions WHERE id = ?',
    [prev.id]
  );
  assert.equal(oldRow!.status, 'rotated');
  assert.equal(oldRow!.rotation_reason, 'busy_session:auto-recovery');
  const newRow = queryOne<{ status: string }>('SELECT status FROM openclaw_sessions WHERE id = ?', [rotated.session.id]);
  assert.equal(newRow!.status, 'active');
});

// ── PLATFORM-013: isSessionBusy — hybrid pre-reuse check ──

test('isSessionBusy: local sessions.json explicit status decides by status (fast path)', () => {
  const localSessions: Record<string, { status?: string | null; lastInteractionAt?: number }> = {
    'agent:tester:mission-control-t-1': { status: 'processing', lastInteractionAt: Date.now() },
    'agent:tester:mission-control-t-2': { status: 'queued', lastInteractionAt: Date.now() },
    'agent:tester:mission-control-t-3': { status: 'running', lastInteractionAt: Date.now() },
    'agent:tester:mission-control-t-4': { status: 'active', lastInteractionAt: Date.now() },
    'agent:tester:mission-control-t-5': { status: 'done', lastInteractionAt: Date.now() },
    'agent:tester:mission-control-t-6': { status: 'failed', lastInteractionAt: Date.now() },
  };
  for (const key of ['mission-control-t-1', 'mission-control-t-2', 'mission-control-t-3']) {
    const res = isSessionBusy({ sessionKey: `agent:tester:${key}`, localSessions });
    assert.equal(res.busy, true, `${key} must be busy`);
    assert.equal(res.source, 'sessions.json');
    assert.ok(res.reason!.startsWith('busy_session:'));
  }
  for (const key of ['mission-control-t-4', 'mission-control-t-5', 'mission-control-t-6']) {
    const res = isSessionBusy({ sessionKey: `agent:tester:${key}`, localSessions });
    assert.equal(res.busy, false, `${key} must NOT be busy (P008 handles terminal)`);
    assert.equal(res.source, 'sessions.json');
  }
});

test('isSessionBusy: gateway rows are the authoritative busy signal (running/queued/processing)', () => {
  const gatewaySessions: GatewaySessionInfo[] = [
    { key: 'agent:tester:x', status: 'running' },
    { key: 'agent:tester:y', status: 'queued' },
    { key: 'agent:tester:z', status: 'processing' },
    { key: 'agent:tester:done1', status: 'done' },
    { key: 'agent:tester:failed1', status: 'failed' },
    { key: 'agent:tester:active1', status: 'active' },
  ];
  for (const key of ['x', 'y', 'z']) {
    const res = isSessionBusy({ sessionKey: `agent:tester:${key}`, gatewaySessions });
    assert.equal(res.busy, true, `gateway ${key} must be busy`);
    assert.equal(res.source, 'gateway');
    assert.ok(res.reason!.startsWith('busy_session:'));
  }
  for (const key of ['done1', 'failed1', 'active1']) {
    const res = isSessionBusy({ sessionKey: `agent:tester:${key}`, gatewaySessions });
    assert.equal(res.busy, false, `gateway ${key} must NOT be busy`);
    assert.equal(res.source, 'gateway');
  }
});

test('isSessionBusy: hasActiveRun=true → busy even when gateway status looks idle', () => {
  const res = isSessionBusy({
    sessionKey: 'agent:tester:x',
    gatewaySessions: [{ key: 'agent:tester:x', status: 'active', hasActiveRun: true, activeRunIds: ['r1'] }],
  });
  assert.equal(res.busy, true);
  assert.equal(res.reason, 'busy_session:active_run');
});

test('isSessionBusy: no local status + gateway row found → gateway wins', () => {
  // 2026.7 sessions.json has no status field → must fall through to the poll.
  const localSessions: Record<string, { lastInteractionAt: number }> = {
    'agent:tester:x': { lastInteractionAt: Date.now() },
  };
  const res = isSessionBusy({
    sessionKey: 'agent:tester:x',
    localSessions,
    gatewaySessions: [{ key: 'agent:tester:x', status: 'running' }],
  });
  assert.equal(res.busy, true);
  assert.equal(res.source, 'gateway');
  assert.equal(res.reason, 'busy_session:running');
});

test('isSessionBusy: unknown key + no gateway row → not busy', () => {
  const res = isSessionBusy({
    sessionKey: 'agent:tester:brand-new',
    gatewaySessions: [],
    localSessions: {},
  });
  assert.equal(res.busy, false);
  assert.equal(res.source, 'none');
});

test('isSessionBusy: gateway unreachable → safe side via fresh local interaction', () => {
  const now = Date.now();
  // Fresh interaction → treat as busy (rotating beats a takeover-error stall).
  const fresh = isSessionBusy({
    sessionKey: 'agent:tester:x',
    gatewaySessions: null,
    localSessions: { 'agent:tester:x': { lastInteractionAt: now - 10_000 } },
    now,
  });
  assert.equal(fresh.busy, true);
  assert.equal(fresh.reason, 'busy_session:recent_interaction');
  assert.equal(fresh.source, 'sessions.json');

  // Stale interaction → not busy.
  const stale = isSessionBusy({
    sessionKey: 'agent:tester:x',
    gatewaySessions: null,
    localSessions: { 'agent:tester:x': { lastInteractionAt: now - LOCAL_SESSION_BUSY_FRESHNESS_MS - 60_000 } },
    now,
  });
  assert.equal(stale.busy, false);
  assert.equal(stale.source, 'sessions.json');
});

test('rotationReasonLabel: busy reasons map to busy_session, others keep first reason', () => {
  assert.equal(rotationReasonLabel(['session_busy:running']), 'busy_session');
  assert.equal(rotationReasonLabel(['session_busy:active_run', 'total_tokens_exceeded:1>2']), 'busy_session');
  assert.equal(rotationReasonLabel(['gateway_status:failed']), 'gateway_status:failed');
  assert.equal(rotationReasonLabel(['total_tokens_exceeded:9>1']), 'total_tokens_exceeded:9>1');
  assert.equal(rotationReasonLabel([]), 'unhealthy');
  assert.equal(rotationReasonLabel(null), 'unhealthy');
});

test('resolveDispatchSession: busyOverride busy → rotated to NEW key (runNumber+1) with session_busy reason', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const busy = insertSession({
    agent_id: agentId,
    task_id: taskId,
    openclaw_session_id: `mission-control-test-builder-${taskId}`,
    total_tokens: 10_000,
    run_number: 1,
  });

  // Gateway list unavailable (poll failed) but the pre-reuse local check says busy.
  const res = resolveDispatchSession({
    taskId,
    agentId,
    agentName: 'Test Builder',
    gatewaySessions: [],
    existingSession: busy,
    sessionKeyPrefix: PREFIX,
    busyOverride: { busy: true, reason: 'busy_session:recent_interaction', source: 'sessions.json' },
    config: cfg,
  });

  assert.equal(res.rotated, true, 'busyOverride must force rotation');
  assert.equal(res.reusedExistingSession, false);
  assert.ok(res.rotationReasons.includes('busy_session:recent_interaction'));
  assert.equal(res.runNumber, 2);
  assert.ok(res.session.openclaw_session_id.includes('-r2-'));
  const oldRow = queryOne<{ status: string }>('SELECT status FROM openclaw_sessions WHERE id = ?', [busy.id]);
  assert.equal(oldRow!.status, 'rotated');
});

test('resolveDispatchSession: busyOverride not busy → session reused (no churn)', () => {
  const { agentId, taskId } = seedAgentAndTask();
  const idle = insertSession({
    agent_id: agentId,
    task_id: taskId,
    openclaw_session_id: `mission-control-test-builder-${taskId}`,
    total_tokens: 10_000,
    run_number: 1,
  });

  const res = resolveDispatchSession({
    taskId,
    agentId,
    agentName: 'Test Builder',
    gatewaySessions: [],
    existingSession: idle,
    sessionKeyPrefix: PREFIX,
    busyOverride: { busy: false, status: 'active', source: 'gateway' },
    config: cfg,
  });

  assert.equal(res.rotated, false);
  assert.equal(res.reusedExistingSession, true);
  assert.equal(res.session.id, idle.id);
});
