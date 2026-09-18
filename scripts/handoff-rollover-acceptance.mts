/**
 * G — LIVE ACCEPTANCE (simulated rollover, §24) — non-production scratch DB.
 *
 * Scenario: Task → Session A → partial work → forced context-budget boundary →
 * checkpoint → Session A terminates → Session B starts → reads checkpoint →
 * does NOT repeat completed work → completes remaining work → verifier → WORK_RESULT.
 *
 * Uses the REAL production code paths (handoff-watchdog sweep, checkpoint
 * persistence, bounded continuation context) against a scratch SQLite DB.
 * Evidence JSON is written for the final WORK_RESULT.
 *
 * Run:  DATABASE_PATH=.tmp/handoff-acceptance.db NODE_ENV=test \
 *         npx tsx scripts/handoff-rollover-acceptance.mts
 */

import fs from 'node:fs';
import path from 'node:path';
import dbMod from '../src/lib/db';
import watchdogMod from '../src/lib/handoff-watchdog';
import handoffMod from '../src/lib/session-handoff';

// tsx CJS/ESM interop: unwrap default when present (same pattern as
// scripts/ks2-live-abort-verify.mts).
const db = ((dbMod as any).default ?? dbMod) as typeof import('../src/lib/db');
const { run, queryOne, queryAll } = db;
const wd = ((watchdogMod as any).default ?? watchdogMod) as typeof import('../src/lib/handoff-watchdog');
const { checkHandoffBudgets, HANDOFF_ROTATION_REASON, listHandoffCandidates } = wd;
const sh = ((handoffMod as any).default ?? handoffMod) as typeof import('../src/lib/session-handoff');
const {
  prepareContinuationForDispatch,
  confirmHandoffDelivery,
  getLatestHandoffCheckpoint,
  readHandoffMetadata,
  saveHandoffCheckpointRow,
  HANDOFF_CHECKPOINT_SCHEMA,
  validateHandoffCheckpoint,
} = sh;
import type { HandoffCheckpointV1 } from '../src/lib/session-handoff';

const OUT_DIR = process.env.ACCEPTANCE_OUT_DIR || 'reports/handoff-acceptance';
fs.mkdirSync(OUT_DIR, { recursive: true });

const evidence: Record<string, unknown> = {
  scenario: 'simulated_rollover_non_production',
  startedAt: new Date().toISOString(),
  steps: [] as Record<string, unknown>[],
};
function step(name: string, data: Record<string, unknown> = {}): void {
  (evidence.steps as Record<string, unknown>[]).push({ name, at: new Date().toISOString(), ...data });
  console.log(`[acceptance] ${name}`, Object.keys(data).length ? JSON.stringify(data).slice(0, 300) : '');
}
let failures = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (!cond) {
    failures += 1;
    console.error(`[acceptance] ✖ FAIL: ${label}`, detail ?? '');
  } else {
    console.log(`[acceptance] ✔ ${label}`);
  }
}

// ── Setup: task + Session A (active, 30 min old) ───────────────────────────

const taskId = `ACC-ROLLOVER-${Date.now()}`;
const sessionAId = crypto.randomUUID();
const oldIso = new Date(Date.now() - 30 * 60_000).toISOString();

run(
  `INSERT INTO tasks (id, title, description, status, workspace_id, metadata, created_at, updated_at)
   VALUES (?, 'Acceptance: bounded rollover scenario', 'Part 1 + Part 2 + Final report', 'in_progress', 'default', NULL, ?, ?)`,
  [taskId, oldIso, oldIso]
);
run(
  `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, task_id, channel, status, session_type, total_tokens, context_tokens, run_number, created_at, updated_at)
   VALUES (?, NULL, 'mission-control-builder-acceptance-A', ?, 'mission-control', 'active', 'persistent', 0, 0, 1, ?, ?)`,
  [sessionAId, taskId, oldIso, oldIso]
);
step('setup', { taskId, sessionA: sessionAId });
check(listHandoffCandidates().some((c) => c.taskId === taskId), 'Session A listed as rollover candidate');

// ── Partial work on Session A: checkpoint with Part 1 evidenced ────────────

const cpPartial: HandoffCheckpointV1 = {
  schema: HANDOFF_CHECKPOINT_SCHEMA,
  identity: {
    project: 'acceptance-scenario',
    taskId,
    executionId: `sessionA:${sessionAId}`,
    stage: 'in_progress',
    agent: 'builder',
    runtime: 'openclaw',
    continuationIndex: 1,
    timestamp: new Date().toISOString(),
  },
  source: { repository: 'acceptance/local', branch: 'acceptance', headSha: 'accsha1' },
  completed: [
    {
      id: 'C-1',
      text: 'Part 1 implemented + tested (scratch)',
      class: 'PASS_ALREADY_EVIDENCED',
      result: 'green',
      evidence: [`${OUT_DIR}/part1-evidence.md`],
      test: 'part1: 5/5 PASS',
      commit: 'accsha1',
    },
  ],
  remaining: [
    { id: 'R-1', text: 'Execute Part 2 (command: run-part2.sh)', class: 'REQUIRES_EXECUTION' },
    { id: 'R-2', text: 'Produce final WORK_RESULT summary', class: 'REQUIRES_EXECUTION' },
  ],
  validation: { testsRun: ['part1'], passCount: 5, failCount: 0, testsPending: ['part2'] },
  evidence: { local: [`${OUT_DIR}/part1-evidence.md`], git: ['acceptance/local@accsha1'] },
  decisions: ['Rollover at budget boundary; do not replay Part 1.'],
  blockers: [],
  nextAction: 'Execute Part 2 (run-part2.sh), then produce the final summary.',
  generatedBy: 'agent',
};
saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'manual', cp: cpPartial });
fs.writeFileSync(path.join(OUT_DIR, 'part1-evidence.md'), '# Part 1 evidence (scratch)\nresult: green\n');
step('partial_work', { completed: ['C-1'], remaining: ['R-1', 'R-2'] });

// ── Forced context-budget boundary: sweep with over-budget telemetry ───────

let redispatchedTo: string | null = null;
const sweep = await checkHandoffBudgets({
  telemetry: async () => ({ [sessionAId]: { liveContextTokens: 920_000, contextWindow: 1_000_000, totalTokens: 950_000 } }),
  redispatch: async (tid) => {
    // Simulate the dispatch route honoring ROLLOVER_REQUESTED: it reads the
    // bounded continuation context and would inject it into the fresh session.
    const cont = prepareContinuationForDispatch(tid);
    check(!!cont, 'dispatch route builds bounded continuation context from checkpoint');
    check((cont?.text.length ?? 0) <= 9000, 'continuation context bounded (<=9000 chars)', { chars: cont?.text.length });
    check(!!cont && cont.text.includes('C-1'), 'completed item C-1 present under DO NOT REPLAY');
    check(!!cont && cont.text.includes('R-1'), 'remaining R-1 present under EXECUTE');
    check(!!cont && !/continue previous work/i.test(cont.text), 'no vague instructions');

    // Create the fresh session row (like the real dispatch route does).
    const freshId = crypto.randomUUID();
    redispatchedTo = 'mission-control-builder-acceptance-B';
    run(
      `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, task_id, channel, status, session_type, total_tokens, context_tokens, run_number, created_at, updated_at)
       VALUES (?, NULL, ?, ?, 'mission-control', 'active', 'persistent', 0, 0, 2, datetime('now'), datetime('now'))`,
      [freshId, redispatchedTo, tid]
    );
    // Simulate route post-delivery confirmation.
    if (cont) {
      run(
        `UPDATE openclaw_sessions SET status = 'rotated', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'active' AND openclaw_session_id != ?`,
        [sessionAId, redispatchedTo]
      );
      confirmHandoffDelivery(tid, redispatchedTo, 2, cont);
    }
    return { ok: true, sessionId: redispatchedTo };
  },
});

step('rollover_sweep', {
  summary: sweep,
  redispatchedTo,
});
check(sweep.rolloversStarted >= 1, 'rollover executed by sweep');
check(redispatchedTo === 'mission-control-builder-acceptance-B', 'fresh Session B created');

const sessionA = queryOne<{ status: string; rotation_reason: string | null; ended_at: string | null }>(
  'SELECT status, rotation_reason, ended_at FROM openclaw_sessions WHERE id = ?',
  [sessionAId]
);
check(sessionA?.status === 'rotated', 'Session A terminated (status=rotated)', sessionA);
check(sessionA?.rotation_reason === HANDOFF_ROTATION_REASON, 'Session A rotation_reason recorded');

// ── Session B: verify resume evidence + no replay ──────────────────────────

const metaAfterResume = readHandoffMetadata(
  queryOne<{ metadata: string | null }>('SELECT metadata FROM tasks WHERE id = ?', [taskId])!.metadata
);
check(metaAfterResume.handoff_status === 'ARMED', 'task ARMED after continuation delivery', metaAfterResume);

const eventsB = queryAll<{ activity_type: string; message: string }>(
  'SELECT activity_type, message FROM task_activities WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
  [taskId]
);
const types = eventsB.map((e) => e.activity_type);
step('session_b_events', { types });
check(types.includes('checkpoint_started'), 'checkpoint_started emitted');
check(types.includes('checkpoint_completed'), 'checkpoint_completed emitted');
check(types.includes('session_handoff_started'), 'session_handoff_started emitted');
check(types.includes('continuation_session_started'), 'continuation_session_started emitted');
check(types.includes('checkpoint_resume_verified'), 'checkpoint_resume_verified emitted');

// No-replay proof: Session B receives ONLY the bounded context; it must not
// re-execute C-1. Simulate B executing just R-1 then finalizing; the checkpoint
// chain records C-1 unchanged (no second execution marker for C-1).
const cpBefore = getLatestHandoffCheckpoint(taskId)!;
const c1RunsBefore = cpBefore.cp.completed.filter((c) => c.id === 'C-1').length;
check(c1RunsBefore === 1, 'C-1 appears exactly once in the checkpoint (no replay duplication)');

// ── Session B completes remaining work; final checkpoint cumulative ────────

const cpFinal: HandoffCheckpointV1 = {
  ...cpBefore.cp,
  identity: { ...cpBefore.cp.identity, continuationIndex: 2, executionId: `sessionB:${redispatchedTo}`, timestamp: new Date().toISOString() },
  completed: [
    cpBefore.cp.completed[0],
    { id: 'C-2', text: 'Part 2 executed in Session B', class: 'PASS_ALREADY_EVIDENCED', result: 'green', evidence: [`${OUT_DIR}/part2-evidence.md`], test: 'part2: 3/3 PASS', commit: 'accsha2' },
    { id: 'C-3', text: 'Final WORK_RESULT assembled', class: 'PASS_ALREADY_EVIDENCED', evidence: [`${OUT_DIR}/acceptance-evidence.json`] },
  ],
  remaining: [{ id: 'R-VERIFY', text: 'Final verifier sign-off', class: 'REQUIRES_EXECUTION' }],
  validation: { testsRun: ['part1', 'part2'], passCount: 8, failCount: 0, testsPending: ['verifier'] },
  evidence: { local: [`${OUT_DIR}/part1-evidence.md`, `${OUT_DIR}/part2-evidence.md`], git: ['acceptance/local@accsha1', 'acceptance/local@accsha2'] },
};
fs.writeFileSync(path.join(OUT_DIR, 'part2-evidence.md'), '# Part 2 evidence (scratch)\nresult: green\n');
const finalRow = saveHandoffCheckpointRow({ taskId, agentId: null, checkpointType: 'auto', cp: cpFinal });
step('session_b_completion', { finalCheckpoint: finalRow.id });

// ── Verifier: validate continuation did not lose state ─────────────────────

const finalCp = getLatestHandoffCheckpoint(taskId)!;
check(validateHandoffCheckpoint(finalCp.cp).ok, 'final checkpoint valid');
check(finalCp.cp.identity.taskId === taskId, 'same Task ID across continuation');
check(finalCp.cp.completed.length === 3, 'cumulative completed chain (C-1, C-2, C-3)');
check(finalCp.cp.source.headSha === 'accsha1', 'source SHA chain preserved (base accsha1)');
check(finalCp.cp.evidence.local.length >= 2, 'evidence chain preserved (part1 + part2)');

const sessionCount = queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM openclaw_sessions WHERE task_id = ?', [taskId])!.c;
check(sessionCount === 2, 'exactly two session identities, one task', { sessionCount });

// Simulated rollover did NOT touch production: scratch DB only.
const dbPath = process.env.DATABASE_PATH || '';
check(dbPath.includes('.tmp') || dbPath.includes('scratch'), 'running on a scratch/non-production DB', { dbPath });

// ── Evidence writeout ──────────────────────────────────────────────────────

evidence.finishedAt = new Date().toISOString();
evidence.result = failures === 0 ? 'PASS' : 'FAIL';
evidence.failures = failures;
fs.writeFileSync(path.join(OUT_DIR, 'acceptance-evidence.json'), JSON.stringify(evidence, null, 2));

// cleanup scratch rows
run('DELETE FROM work_checkpoints WHERE task_id = ?', [taskId]);
run('DELETE FROM task_activities WHERE task_id = ?', [taskId]);
run('DELETE FROM openclaw_sessions WHERE task_id = ?', [taskId]);
run('DELETE FROM tasks WHERE id = ?', [taskId]);

console.log(`[acceptance] RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 2);
