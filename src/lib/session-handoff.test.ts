/**
 * GLOBAL SESSION CONTEXT & COMPACTION REMEDIATION — deterministic tests for
 * the bounded-session handoff core (§23 matrix, cases 1–12).
 *
 *   1. checkpoint creation          7. new session identity
 *   2. checkpoint validation        8. source SHA preservation
 *   3. completed-item preservation  9. evidence preservation
 *   4. remaining-item restoration  10. no replay of evidenced PASS item
 *   5. continuation session creation  11. invalid checkpoint rejection
 *   6. same Task ID across continuation 12. interrupted session recovery
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run, queryOne } from './db';
import {
  HANDOFF_CHECKPOINT_SCHEMA,
  validateHandoffCheckpoint,
  renderHandoffCheckpoint,
  writeHandoffCheckpointAtomic,
  saveHandoffCheckpointRow,
  getLatestHandoffCheckpoint,
  getContinuationIndex,
  synthesizeHandoffCheckpoint,
  buildBoundedContinuationContext,
  evaluateContextBudget,
  resolveContextBudgetConfig,
  readHandoffMetadata,
  writeHandoffMetadata,
  prepareResumeFromCheckpoint,
  CONTINUATION_CONTEXT_MAX_CHARS,
  type HandoffCheckpointV1,
} from './session-handoff';

// ── helpers ─────────────────────────────────────────────────────────────────

function seedTask(opts: { status?: string; metadata?: string | null } = {}): string {
  const taskId = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, metadata, created_at, updated_at)
     VALUES (?, 'Handoff Test Task', 'test', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [taskId, opts.status ?? 'in_progress', opts.metadata ?? null]
  );
  return taskId;
}

function seedSession(taskId: string, opts: { suffix?: string; status?: string; createdAt?: string } = {}): string {
  const id = crypto.randomUUID();
  const openclawSessionId = `mission-control-handoff-test-${taskId}${opts.suffix ? `-${opts.suffix}` : ''}`;
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, task_id, channel, status, session_type, total_tokens, context_tokens, run_number, created_at, updated_at)
     VALUES (?, NULL, ?, ?, 'mission-control', ?, 'persistent', 0, 0, 1, ?, ?)`,
    [id, openclawSessionId, taskId, opts.status ?? 'active', opts.createdAt ?? new Date().toISOString(), opts.createdAt ?? new Date().toISOString()]
  );
  return id;
}

function makeCheckpoint(overrides: Partial<HandoffCheckpointV1> = {}): HandoffCheckpointV1 {
  return {
    schema: HANDOFF_CHECKPOINT_SCHEMA,
    identity: {
      project: 'test-project',
      taskId: 'task-1',
      executionId: 'exec-1',
      stage: 'in_progress',
      agent: 'builder',
      runtime: 'openclaw',
      continuationIndex: 1,
      timestamp: '2026-09-18T16:00:00Z',
    },
    source: { repository: 'repo', branch: 'main', headSha: 'abc1234' },
    completed: [
      {
        id: 'C-1',
        text: 'Collector implemented',
        class: 'PASS_ALREADY_EVIDENCED',
        result: 'green',
        evidence: ['/tmp/evidence/c1.md'],
        test: '37/37',
        commit: 'abc1234',
      },
    ],
    remaining: [
      { id: 'R-1', text: 'Implement probe X', class: 'REQUIRES_EXECUTION' },
    ],
    validation: { testsRun: ['suite-a'], passCount: 37, failCount: 0, testsPending: ['probe-x'] },
    evidence: { local: ['/tmp/evidence/c1.md'], git: ['repo@abc1234'], box: ['box:123/WORK_RESULT.md'] },
    decisions: ['Do not raise reserveTokensFloor as the primary fix.'],
    blockers: [],
    nextAction: 'Run probe X.',
    generatedBy: 'agent',
    ...overrides,
  };
}

function cleanupTask(taskId: string): void {
  run('DELETE FROM work_checkpoints WHERE task_id = ?', [taskId]);
  run('DELETE FROM task_activities WHERE task_id = ?', [taskId]);
  run('DELETE FROM openclaw_sessions WHERE task_id = ?', [taskId]);
  run('DELETE FROM tasks WHERE id = ?', [taskId]);
}

// ── 1. checkpoint creation ──────────────────────────────────────────────────

test('case 1: checkpoint creation — valid checkpoint persists to work_checkpoints with handoff payload', () => {
  const taskId = seedTask();
  try {
    const cp = makeCheckpoint();
    cp.identity.taskId = taskId;
    const row = saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'manual', cp });

    assert.ok(row.id);
    assert.equal(row.task_id, taskId);
    const parsed = JSON.parse(row.context_data!) as { handoff: HandoffCheckpointV1 };
    assert.equal(parsed.handoff.schema, HANDOFF_CHECKPOINT_SCHEMA);
    assert.equal(parsed.handoff.completed.length, 1);
  } finally {
    cleanupTask(taskId);
  }
});

// ── 2. checkpoint validation ────────────────────────────────────────────────

test('case 2: checkpoint validation — complete checkpoint OK; missing fields rejected as CHECKPOINT_INCOMPLETE', () => {
  const ok = validateHandoffCheckpoint(makeCheckpoint());
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'OK');

  const noNext = makeCheckpoint({ nextAction: '' });
  const v1 = validateHandoffCheckpoint(noNext);
  assert.equal(v1.ok, false);
  assert.ok(v1.missing.includes('nextAction'));

  const noSource = makeCheckpoint({ source: {} });
  const v2 = validateHandoffCheckpoint(noSource);
  assert.equal(v2.ok, false);
  assert.ok(v2.missing.some((m) => m.startsWith('source')));

  const noRemaining = makeCheckpoint({ remaining: [] });
  const v3 = validateHandoffCheckpoint(noRemaining);
  assert.equal(v3.ok, false);
  assert.ok(v3.missing.includes('remaining'));
});

// ── 3. completed-item preservation ──────────────────────────────────────────

test('case 3: completed items (PASS_ALREADY_EVIDENCED + evidence) survive round-trip through DB and renderer', () => {
  const taskId = seedTask();
  try {
    const cp = makeCheckpoint();
    cp.identity.taskId = taskId;
    saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'auto', cp });

    const found = getLatestHandoffCheckpoint(taskId);
    assert.ok(found);
    const c = found!.cp.completed[0];
    assert.equal(c.id, 'C-1');
    assert.equal(c.class, 'PASS_ALREADY_EVIDENCED');
    assert.deepEqual(c.evidence, ['/tmp/evidence/c1.md']);
    assert.equal(c.test, '37/37');
    assert.equal(c.commit, 'abc1234');

    const md = renderHandoffCheckpoint(found!.cp);
    assert.match(md, /\[PASS_ALREADY_EVIDENCED\] C-1/);
    assert.match(md, /Do NOT replay|PASS_ALREADY_EVIDENCED must NOT be rerun/);
  } finally {
    cleanupTask(taskId);
  }
});

// ── 4. remaining-item restoration ───────────────────────────────────────────

test('case 4: remaining items are restored verbatim and each is independently actionable', () => {
  const taskId = seedTask();
  try {
    const cp = makeCheckpoint();
    cp.identity.taskId = taskId;
    cp.remaining = [
      { id: 'R-2', text: 'Execute probe Y (command: bin/run-probe.sh y)', class: 'REQUIRES_EXECUTION' },
      { id: 'R-3', text: 'Wait for owner gate response', class: 'BLOCKED' },
    ];
    saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'auto', cp });

    const found = getLatestHandoffCheckpoint(taskId);
    assert.equal(found!.cp.remaining.length, 2);
    assert.equal(found!.cp.remaining[0].id, 'R-2');
    assert.match(found!.cp.remaining[0].text, /bin\/run-probe\.sh y/);
    assert.equal(found!.cp.remaining[1].class, 'BLOCKED');

    const ctx = buildBoundedContinuationContext(taskId);
    assert.ok(ctx);
    assert.match(ctx!.text, /R-2 \[REQUIRES_EXECUTION\]: Execute probe Y/);
    assert.match(ctx!.text, /R-3 \[BLOCKED\]/);
    // No vague instruction allowed
    assert.doesNotMatch(ctx!.text, /continue previous work/i);
  } finally {
    cleanupTask(taskId);
  }
});

// ── 5. continuation session creation (bounded context) ──────────────────────

test('case 5: continuation session creation — bounded context ≤ cap, includes no-replay rules and next action', () => {
  const taskId = seedTask();
  try {
    const cp = makeCheckpoint();
    cp.identity.taskId = taskId;
    saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'auto', cp });

    const ctx = buildBoundedContinuationContext(taskId);
    assert.ok(ctx);
    assert.ok(ctx!.chars <= CONTINUATION_CONTEXT_MAX_CHARS);
    assert.match(ctx!.text, /CONTINUATION CONTEXT \(bounded — session handoff\)/);
    assert.match(ctx!.text, /Full historical conversation is deliberately omitted/);
    assert.match(ctx!.text, /Next Action \(execute FIRST\)/);
    assert.match(ctx!.text, /do NOT repeat PASS_ALREADY_EVIDENCED work/);
    // never embeds full conversation
    assert.doesNotMatch(ctx!.text, /conversation history/i);
  } finally {
    cleanupTask(taskId);
  }
});

// ── 6. same Task ID across continuation + 7. new session identity ───────────

test('case 6+7: same Task ID across continuation; continuation index derives from session identity', () => {
  const taskId = seedTask();
  try {
    const t1 = new Date(Date.now() - 60_000).toISOString();
    const t2 = new Date().toISOString();
    seedSession(taskId, { createdAt: t1 });
    seedSession(taskId, { suffix: 'r2', status: 'rotated', createdAt: t2 });

    const cp = makeCheckpoint();
    cp.identity.taskId = taskId;
    saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'auto', cp });

    // Same task id is used by every checkpoint lookup.
    const found = getLatestHandoffCheckpoint(taskId);
    assert.equal(found!.cp.identity.taskId, taskId);

    // Continuation index counts session rows (>= 2 with a second identity).
    const idx = getContinuationIndex(taskId);
    assert.ok(idx >= 2);

    // Rotated sessions keep distinct gateway identities.
    const ids = [
      queryOne<{ openclaw_session_id: string }>(
        `SELECT openclaw_session_id FROM openclaw_sessions WHERE task_id = ? ORDER BY created_at ASC`,
        [taskId]
      )!.openclaw_session_id,
      queryOne<{ openclaw_session_id: string }>(
        `SELECT openclaw_session_id FROM openclaw_sessions WHERE task_id = ? ORDER BY created_at DESC`,
        [taskId]
      )!.openclaw_session_id,
    ];
    assert.notEqual(ids[0], ids[1]);
  } finally {
    cleanupTask(taskId);
  }
});

// ── 8. source SHA preservation ──────────────────────────────────────────────

test('case 8: source SHA survives persistence and appears in the bounded continuation context', () => {
  const taskId = seedTask();
  try {
    const cp = makeCheckpoint();
    cp.identity.taskId = taskId;
    cp.source = { repository: 'SSA-DAI/mission-control', branch: 'awanfleet-runtime-3a2ca342', headSha: 'deadbeefcafe' };
    saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'auto', cp });

    const found = getLatestHandoffCheckpoint(taskId);
    assert.equal(found!.cp.source.headSha, 'deadbeefcafe');

    const ctx = buildBoundedContinuationContext(taskId);
    assert.match(ctx!.text, /Source HEAD: deadbeefcafe/);
    assert.match(ctx!.text, /branch awanfleet-runtime-3a2ca342/);
  } finally {
    cleanupTask(taskId);
  }
});

// ── 9. evidence preservation ────────────────────────────────────────────────

test('case 9: evidence paths survive (local/git/box/ids) and are injected into the continuation context', () => {
  const taskId = seedTask();
  try {
    const cp = makeCheckpoint();
    cp.identity.taskId = taskId;
    cp.evidence = {
      local: ['/evidence/local.md'],
      git: ['repo@abc1234'],
      box: ['box:408894294463/WORK_RESULT.md'],
      ids: { box_file: '123456' },
    };
    saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'auto', cp });

    const found = getLatestHandoffCheckpoint(taskId);
    assert.deepEqual(found!.cp.evidence.local, ['/evidence/local.md']);
    assert.deepEqual(found!.cp.evidence.box, ['box:408894294463/WORK_RESULT.md']);

    const ctx = buildBoundedContinuationContext(taskId);
    assert.match(ctx!.text, /box:408894294463\/WORK_RESULT\.md/);
    assert.match(ctx!.text, /local: \/evidence\/local\.md/);
  } finally {
    cleanupTask(taskId);
  }
});

// ── 10. no replay of evidenced PASS item ────────────────────────────────────

test('case 10: PASS_ALREADY_EVIDENCED items are listed under DO NOT REPLAY and remaining under EXECUTE', () => {
  const taskId = seedTask();
  try {
    const cp = makeCheckpoint();
    cp.identity.taskId = taskId;
    saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'auto', cp });

    const ctx = buildBoundedContinuationContext(taskId);
    const text = ctx!.text;
    const doneSection = text.split('### Remaining — EXECUTE')[0];
    const todoSection = text.split('### Remaining — EXECUTE')[1];
    assert.ok(doneSection.includes('C-1'));
    assert.ok(doneSection.includes('DO NOT REPLAY'));
    assert.ok(todoSection.includes('R-1'));
    assert.ok(!todoSection.includes('C-1:'), 'completed item must not appear in the EXECUTE list');
  } finally {
    cleanupTask(taskId);
  }
});

// ── 11. invalid checkpoint rejection ────────────────────────────────────────

test('case 11: invalid checkpoint rejection — validator fails closed and bounded context refuses it', () => {
  const taskId = seedTask();
  try {
    // Persist a checkpoint that is structurally invalid (no remaining, no nextAction).
    const bad = makeCheckpoint({ remaining: [], nextAction: '' });
    bad.identity.taskId = taskId;
    const row = saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'auto', cp: bad });
    assert.ok(row.id);

    const found = getLatestHandoffCheckpoint(taskId);
    assert.ok(found);
    const v = validateHandoffCheckpoint(found!.cp);
    assert.equal(v.ok, false);
    assert.equal(v.status, 'CHECKPOINT_INCOMPLETE');

    // Bounded context must refuse invalid checkpoints (fail closed).
    const ctx = buildBoundedContinuationContext(taskId);
    assert.equal(ctx, null);
  } finally {
    cleanupTask(taskId);
  }
});

// ── 12. interrupted session recovery ────────────────────────────────────────

test('case 12: interrupted session recovery — prepareResumeFromCheckpoint marks CONTINUATION_PENDING with valid checkpoint; no-op without one', () => {
  const taskId = seedTask();
  const noCpTask = seedTask();
  try {
    // No checkpoint → cannot prepare resume (fail closed, task untouched).
    const none = prepareResumeFromCheckpoint(noCpTask, 'compaction_failure', 'sess-x');
    assert.equal(none.prepared, false);
    assert.equal(readHandoffMetadata((queryOne<{ metadata: string | null }>('SELECT metadata FROM tasks WHERE id = ?', [noCpTask])!).metadata).handoff_status, undefined);

    // Valid checkpoint → prepared, task marked, activity recorded.
    const cp = makeCheckpoint();
    cp.identity.taskId = taskId;
    saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'auto', cp });
    const ok = prepareResumeFromCheckpoint(taskId, 'compaction_failure', 'sess-1');
    assert.equal(ok.prepared, true);

    const meta = readHandoffMetadata(
      queryOne<{ metadata: string | null }>('SELECT metadata FROM tasks WHERE id = ?', [taskId])!.metadata
    );
    assert.equal(meta.handoff_status, 'CONTINUATION_PENDING');
    assert.equal(meta.handoff_checkpoint_id, ok.checkpointId);

    const activity = queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM task_activities WHERE task_id = ? AND activity_type = 'continuation_pending'`,
      [taskId]
    );
    assert.ok((activity?.cnt ?? 0) >= 1);

    // Idempotent for the same ended session.
    const dup = prepareResumeFromCheckpoint(taskId, 'compaction_failure', 'sess-1');
    assert.equal(dup.prepared, false);
    assert.equal(dup.reason, 'already_prepared');
  } finally {
    cleanupTask(taskId);
    cleanupTask(noCpTask);
  }
});

// ── supporting invariants ────────────────────────────────────────────────────

test('budget: rollover requires a STRONG signal (live ctr high-water + insufficient reserve, or huge proxies)', () => {
  const cfg = resolveContextBudgetConfig({} as NodeJS.ProcessEnv);

  // Live context high-water with insufficient reserve → rollover.
  const r1 = evaluateContextBudget(
    { liveContextTokens: 880_000, contextWindow: 1_000_000, totalTokens: 900_000 },
    cfg
  );
  assert.equal(r1.level, 'rollover_required');
  assert.equal(r1.liveCtxPct, 88);

  // Reserve 200k < floor? no — must check REMAINING reserve vs 150k floor.
  // 850k/1M → reserve 150k is NOT < 150k → warning only; use 870k for rollover above.
  const r1b = evaluateContextBudget(
    { liveContextTokens: 850_000, contextWindow: 1_000_000, totalTokens: 900_000 },
    cfg
  );
  assert.equal(r1b.level, 'warning');

  // Same percentage but reserve sufficient → warning only (no churn).
  const r2 = evaluateContextBudget(
    { liveContextTokens: 790_000, contextWindow: 5_000_000, totalTokens: 900_000 },
    cfg
  );
  assert.notEqual(r2.level, 'rollover_required');

  // Huge transcript → rollover even without live telemetry.
  const r3 = evaluateContextBudget({ transcriptBytes: 12 * 1024 * 1024 }, cfg);
  assert.equal(r3.level, 'rollover_required');

  // Normal session → ok.
  const r4 = evaluateContextBudget(
    { liveContextTokens: 100_000, contextWindow: 1_000_000, totalTokens: 150_000, transcriptBytes: 1_000_000 },
    cfg
  );
  assert.equal(r4.level, 'ok');
});

test('synthesis: mechanical checkpoint from DB state is valid and reconcile-first (never "continue previous work")', () => {
  const taskId = seedTask();
  try {
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, NULL, 'completed', 'Step one done', datetime('now'))`,
      [crypto.randomUUID(), taskId]
    );
    const cp = synthesizeHandoffCheckpoint(taskId, 'budget pressure', 'in_progress');
    assert.ok(cp);
    assert.equal(cp!.generatedBy, 'system-synthesis');
    assert.equal(validateHandoffCheckpoint(cp!).ok, true);
    assert.equal(cp!.remaining[0].id, 'R-RECONCILE');
    assert.doesNotMatch(cp!.nextAction, /continue previous work/i);
    const completedTexts = cp!.completed.map((c) => c.class);
    assert.ok(completedTexts.every((c) => c === 'PASS_ALREADY_EVIDENCED'));
  } finally {
    cleanupTask(taskId);
  }
});

test('atomic writer: temp → rename with snapshot; canonical file present and parseable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-atomic-'));
  try {
    const md = renderHandoffCheckpoint(makeCheckpoint());
    const res = writeHandoffCheckpointAtomic(dir, md);
    assert.equal(res.ok, true);
    assert.ok(fs.existsSync(path.join(dir, 'HANDOFF_CHECKPOINT.md')));
    assert.ok(res.snapshotPath && fs.existsSync(res.snapshotPath));
    const content = fs.readFileSync(path.join(dir, 'HANDOFF_CHECKPOINT.md'), 'utf8');
    assert.match(content, /HANDOFF_CHECKPOINT_V1/);
    // No temp files left behind
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.equal(leftovers.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('metadata: handoff state merges into tasks.metadata without clobbering other keys', () => {
  const taskId = seedTask({ metadata: JSON.stringify({ stage_restart_count: 2, custom: 'keep-me' }) });
  try {
    writeHandoffMetadata(taskId, { handoff_status: 'ROLLOVER_REQUESTED', handoff_checkpoint_id: 'cp-1', handoff_continuation_index: 2 });
    const raw = JSON.parse(queryOne<{ metadata: string }>('SELECT metadata FROM tasks WHERE id = ?', [taskId])!.metadata) as Record<string, unknown>;
    assert.equal(raw.stage_restart_count, 2);
    assert.equal(raw.custom, 'keep-me');
    const meta = readHandoffMetadata(JSON.stringify(raw));
    assert.equal(meta.handoff_status, 'ROLLOVER_REQUESTED');
    assert.equal(meta.handoff_checkpoint_id, 'cp-1');
  } finally {
    cleanupTask(taskId);
  }
});
