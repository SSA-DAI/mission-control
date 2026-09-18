/**
 * GLOBAL SESSION CONTEXT & COMPACTION REMEDIATION (2026-09-18) — bounded-session
 * lifecycle core.
 *
 * Problem: "ONE TASK = ONE UNBOUNDED SESSION". Long autonomous tasks accumulate
 * conversation context until compaction fails mid-turn ("Auto-compaction could
 * not recover this turn") and the task can no longer progress without losing
 * state or repeating work.
 *
 * Fix: TASK → BOUNDED SESSION → CHECKPOINT → FRESH SESSION → RESUME → ...
 * SESSION IS EPHEMERAL. TASK STATE IS DURABLE. Git + checkpoint + evidence +
 * Mission Control state are authoritative.
 *
 * This module provides:
 *  - the canonical HANDOFF_CHECKPOINT_V1 schema (Identity / Source State /
 *    Completed Work / Remaining Work / Validation State / Evidence / Decisions /
 *    Blockers / Next Action) with validation (CHECKPOINT_INCOMPLETE fail-closed);
 *  - atomic file writes (temp → validate → rename | snapshot);
 *  - mechanical checkpoint synthesis from Mission Control DB state (used when a
 *    session must be replaced but no agent-authored checkpoint exists);
 *  - bounded continuation context assembly (NEVER the full conversation);
 *  - context-budget evaluation (live context + conservative proxies) with
 *    enough reserve left to write the checkpoint safely;
 *  - checklist classification (PASS_ALREADY_EVIDENCED / REQUIRES_EXECUTION /
 *    BLOCKED / INVALIDATED_BY_CHANGE) with no-replay rules;
 *  - lifecycle observability events compatible with task_activities/events.
 *
 * Read-only w.r.t. production memory/graph/code surfaces. This module only
 * manages execution/session lifecycle state inside Mission Control.
 */

import fs from 'fs';
import path from 'path';
import { queryAll, queryOne, run } from '@/lib/db';
import type { OpenClawSession, Task, WorkCheckpoint } from '@/lib/types';

// ── Configuration ───────────────────────────────────────────────────────────

/** Live-context high-water mark for a WARNING (fraction of model window). */
export const DEFAULT_BUDGET_WARN_PCT = 60;
/** Live-context high-water mark that REQUIRES a checkpoint+rollover. */
export const DEFAULT_BUDGET_ROLLOVER_PCT = 78;
/** Reserve tokens that must remain available to write a checkpoint safely. */
export const DEFAULT_BUDGET_RESERVE_TOKENS = 150000;
/** Proxies when no live context estimate is available (conservative). */
export const DEFAULT_TRANSCRIPT_ROLLOVER_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_TOTAL_TOKENS_ROLLOVER = 6_000_000;
export const DEFAULT_TRANSCRIPT_WARN_BYTES = 5 * 1024 * 1024; // 5 MB
export const DEFAULT_TOTAL_TOKENS_WARN = 4_000_000;
/** Bounded continuation context cap (chars) — hard bound on resume input. */
export const CONTINUATION_CONTEXT_MAX_CHARS = 9000;

export interface ContextBudgetConfig {
  warnPct: number;
  rolloverPct: number;
  reserveTokens: number;
  transcriptRolloverBytes: number;
  transcriptWarnBytes: number;
  totalTokensRollover: number;
  totalTokensWarn: number;
  /** master switch — when false the watchdog only records warnings, never rolls over. */
  autoRolloverEnabled: boolean;
}

function num(v: string | undefined, dflt: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function resolveContextBudgetConfig(env: NodeJS.ProcessEnv = process.env): ContextBudgetConfig {
  return {
    warnPct: num(env.PLATFORM_HANDOFF_BUDGET_WARN_PCT, DEFAULT_BUDGET_WARN_PCT),
    rolloverPct: num(env.PLATFORM_HANDOFF_BUDGET_ROLLOVER_PCT, DEFAULT_BUDGET_ROLLOVER_PCT),
    reserveTokens: num(env.PLATFORM_HANDOFF_RESERVE_TOKENS, DEFAULT_BUDGET_RESERVE_TOKENS),
    transcriptRolloverBytes: num(env.PLATFORM_HANDOFF_TRANSCRIPT_ROLLOVER_BYTES, DEFAULT_TRANSCRIPT_ROLLOVER_BYTES),
    transcriptWarnBytes: num(env.PLATFORM_HANDOFF_TRANSCRIPT_WARN_BYTES, DEFAULT_TRANSCRIPT_WARN_BYTES),
    totalTokensRollover: num(env.PLATFORM_HANDOFF_TOTAL_TOKENS_ROLLOVER, DEFAULT_TOTAL_TOKENS_ROLLOVER),
    totalTokensWarn: num(env.PLATFORM_HANDOFF_TOTAL_TOKENS_WARN, DEFAULT_TOTAL_TOKENS_WARN),
    autoRolloverEnabled: env.PLATFORM_HANDOFF_AUTO_ROLLOVER !== '0',
  };
}

// ── Budget evaluation (pure) ────────────────────────────────────────────────

export type BudgetLevel = 'ok' | 'warning' | 'rollover_required';

export interface ContextBudgetInput {
  /** Live context tokens (best estimate) — null when unknown. */
  liveContextTokens?: number | null;
  /** Model context window — null when unknown. */
  contextWindow?: number | null;
  /** Cumulative run tokens (secondary signal). */
  totalTokens?: number | null;
  /** Estimated transcript size in bytes (secondary signal). */
  transcriptBytes?: number | null;
  /** Session age in ms (informational). */
  sessionAgeMs?: number | null;
}

export interface ContextBudgetVerdict {
  level: BudgetLevel;
  reasons: string[];
  liveCtxPct: number | null;
  reserveRemaining: number | null;
  signals: Record<string, number | null>;
}

/**
 * Pure budget evaluation. Rollover requires a STRONG signal (live-context
 * high-water with an insufficient reserve, or a very large transcript /
 * cumulative tokens) — warnings are informational and must not churn sessions.
 */
export function evaluateContextBudget(
  input: ContextBudgetInput,
  config: ContextBudgetConfig = resolveContextBudgetConfig()
): ContextBudgetVerdict {
  const reasons: string[] = [];
  const signals: Record<string, number | null> = {
    liveContextTokens: input.liveContextTokens ?? null,
    contextWindow: input.contextWindow ?? null,
    totalTokens: input.totalTokens ?? null,
    transcriptBytes: input.transcriptBytes ?? null,
    sessionAgeMs: input.sessionAgeMs ?? null,
  };

  let level: BudgetLevel = 'ok';
  let liveCtxPct: number | null = null;
  let reserveRemaining: number | null = null;

  const live = input.liveContextTokens ?? null;
  const window = input.contextWindow ?? null;
  if (live !== null && window !== null && window > 0) {
    liveCtxPct = Math.round((live / window) * 100);
    reserveRemaining = Math.max(0, window - live);
    if (liveCtxPct >= config.rolloverPct) {
      if (reserveRemaining < config.reserveTokens) {
        level = 'rollover_required';
        reasons.push(
          `ctx_budget:live=${liveCtxPct}%>=${config.rolloverPct}% and reserve=${reserveRemaining}<${config.reserveTokens}`
        );
      } else {
        if (level === 'ok') level = 'warning';
        reasons.push(`ctx_budget:live=${liveCtxPct}%>=${config.rolloverPct}% (reserve ok)`);
      }
    } else if (liveCtxPct >= config.warnPct && level === 'ok') {
      level = 'warning';
      reasons.push(`ctx_budget:live=${liveCtxPct}%>=${config.warnPct}%`);
    }
  }

  const tx = input.transcriptBytes ?? null;
  if (tx !== null && tx >= config.transcriptRolloverBytes) {
    level = 'rollover_required';
    reasons.push(`ctx_budget:transcript=${tx}>=${config.transcriptRolloverBytes}`);
  } else if (tx !== null && tx >= config.transcriptWarnBytes && level === 'ok') {
    level = 'warning';
    reasons.push(`ctx_budget:transcript=${tx}>=${config.transcriptWarnBytes}`);
  }

  const tot = input.totalTokens ?? null;
  if (tot !== null && tot >= config.totalTokensRollover) {
    level = 'rollover_required';
    reasons.push(`ctx_budget:total_tokens=${tot}>=${config.totalTokensRollover}`);
  } else if (tot !== null && tot >= config.totalTokensWarn && level === 'ok') {
    level = 'warning';
    reasons.push(`ctx_budget:total_tokens=${tot}>=${config.totalTokensWarn}`);
  }

  return { level, reasons, liveCtxPct, reserveRemaining, signals };
}

// ── Canonical checkpoint schema ─────────────────────────────────────────────

export const HANDOFF_CHECKPOINT_SCHEMA = 'HANDOFF_CHECKPOINT_V1';

/** Classification markers for checklist items (§7 — no work replay). */
export type ChecklistClass =
  | 'PASS_ALREADY_EVIDENCED'
  | 'REQUIRES_EXECUTION'
  | 'BLOCKED'
  | 'INVALIDATED_BY_CHANGE';

export interface ChecklistItem {
  id: string;
  text: string;
  class: ChecklistClass;
  result?: string;
  evidence?: string[];
  test?: string;
  commit?: string;
}

export interface HandoffCheckpointV1 {
  schema: typeof HANDOFF_CHECKPOINT_SCHEMA;
  identity: {
    project: string;
    taskId: string;
    executionId: string;
    stage: string;
    agent: string;
    runtime: string;
    /** continuation ordinal: 1 = original session, 2+ = continuation sessions. */
    continuationIndex: number;
    timestamp: string;
  };
  source: {
    repository?: string;
    branch?: string;
    headSha?: string;
    baseSha?: string;
    worktreeStatus?: string;
    filesChanged?: string[];
  };
  completed: ChecklistItem[];
  remaining: ChecklistItem[];
  validation: {
    testsRun?: string[];
    passCount?: number | null;
    failCount?: number | null;
    unresolvedFailures?: string[];
    testsPending?: string[];
  };
  evidence: {
    local?: string[];
    git?: string[];
    box?: string[];
    ids?: Record<string, string>;
  };
  decisions: string[];
  blockers: string[];
  nextAction: string;
  /** provenance: how this checkpoint was produced. */
  generatedBy: 'agent' | 'system-synthesis' | 'manual';
  reason?: string;
}

export interface HandoffValidation {
  ok: boolean;
  status: 'OK' | 'CHECKPOINT_INCOMPLETE';
  missing: string[];
}

/** Required content per §4/§17 — a checkpoint without these is INCOMPLETE. */
export function validateHandoffCheckpoint(cp: Partial<HandoffCheckpointV1> | null | undefined): HandoffValidation {
  const missing: string[] = [];
  if (!cp || typeof cp !== 'object') {
    return { ok: false, status: 'CHECKPOINT_INCOMPLETE', missing: ['checkpoint'] };
  }
  const id = cp.identity;
  if (!id) missing.push('identity');
  else {
    if (!id.taskId) missing.push('identity.taskId');
    if (!id.stage) missing.push('identity.stage');
    if (!id.timestamp) missing.push('identity.timestamp');
  }
  const src = cp.source;
  // §4 Source State: repository / branch / HEAD SHA / worktree status — the
  // fields that apply depend on the task kind (repo-backed vs in-place). Fail
  // closed when NOTHING identifies the source, but do not demand a SHA from
  // tasks that legitimately have no repository.
  if (!src || (!src.headSha && !src.repository && !src.worktreeStatus)) missing.push('source(headSha|repository|worktreeStatus)');
  if (!Array.isArray(cp.completed) && !Array.isArray(cp.remaining)) {
    missing.push('completed/remaining');
  }
  if (!Array.isArray(cp.remaining) || cp.remaining.length === 0) missing.push('remaining');
  if (!cp.evidence || (Array.isArray(cp.evidence.local) && cp.evidence.local.length === 0 &&
      Array.isArray(cp.evidence.git) && cp.evidence.git.length === 0 &&
      Array.isArray(cp.evidence.box) && cp.evidence.box.length === 0 &&
      (!cp.evidence.ids || Object.keys(cp.evidence.ids).length === 0))) {
    missing.push('evidence');
  }
  if (!cp.nextAction || !cp.nextAction.trim()) missing.push('nextAction');
  return missing.length === 0
    ? { ok: true, status: 'OK', missing: [] }
    : { ok: false, status: 'CHECKPOINT_INCOMPLETE', missing };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function fmtItems(items: ChecklistItem[] | undefined): string {
  if (!items || items.length === 0) return '- (none)';
  return items
    .map((it) => {
      const bits = [`[${it.class}] ${it.id} — ${it.text}`];
      if (it.result) bits.push(`result: ${it.result}`);
      if (it.evidence && it.evidence.length > 0) bits.push(`evidence: ${it.evidence.join(' | ')}`);
      if (it.test) bits.push(`test: ${it.test}`);
      if (it.commit) bits.push(`commit: ${it.commit}`);
      return `- ${bits.join(' ; ')}`;
    })
    .join('\n');
}

/** Render the canonical HANDOFF_CHECKPOINT.md markdown (§4 minimum schema). */
export function renderHandoffCheckpoint(cp: HandoffCheckpointV1): string {
  const id = cp.identity;
  const s = cp.source || {};
  const v = cp.validation || {};
  const ev = cp.evidence || {};
  return `# HANDOFF_CHECKPOINT.md

> ${HANDOFF_CHECKPOINT_SCHEMA} — bounded-session handoff checkpoint.
> SESSION IS EPHEMERAL. TASK STATE IS DURABLE. Do not rely on conversational history.

## Identity
- Project: ${id.project}
- Task ID: ${id.taskId}
- Execution ID: ${id.executionId}
- Continuation: #${id.continuationIndex}
- Stage: ${id.stage}
- Agent: ${id.agent}
- Runtime: ${id.runtime}
- timestamp: ${id.timestamp}
- generated_by: ${cp.generatedBy}${cp.reason ? ` (reason: ${cp.reason})` : ''}

## Source State
- repository: ${s.repository ?? 'n/a'}
- branch: ${s.branch ?? 'n/a'}
- HEAD SHA: ${s.headSha ?? 'n/a'}
- base SHA: ${s.baseSha ?? 'n/a'}
- worktree status: ${s.worktreeStatus ?? 'n/a'}
- files changed: ${(s.filesChanged && s.filesChanged.length > 0) ? s.filesChanged.join(', ') : 'none recorded'}

## Completed Work
${fmtItems(cp.completed)}

## Remaining Work
${fmtItems(cp.remaining)}

## Validation State
- tests already run: ${(v.testsRun && v.testsRun.length > 0) ? v.testsRun.join('; ') : 'none recorded'}
- PASS/FAIL counts: ${v.passCount ?? '?'} / ${v.failCount ?? '?'}
- unresolved failures: ${(v.unresolvedFailures && v.unresolvedFailures.length > 0) ? v.unresolvedFailures.join('; ') : 'none'}
- tests that still need execution: ${(v.testsPending && v.testsPending.length > 0) ? v.testsPending.join('; ') : 'none recorded'}

## Evidence
- local: ${(ev.local && ev.local.length > 0) ? ev.local.join(' | ') : 'none'}
- Git: ${(ev.git && ev.git.length > 0) ? ev.git.join(' | ') : 'none'}
- Box: ${(ev.box && ev.box.length > 0) ? ev.box.join(' | ') : 'none'}
- IDs: ${ev.ids && Object.keys(ev.ids).length > 0 ? Object.entries(ev.ids).map(([k, x]) => `${k}=${x}`).join('; ') : 'none'}

## Decisions / Constraints
${(cp.decisions && cp.decisions.length > 0) ? cp.decisions.map((d) => `- ${d}`).join('\n') : '- (none recorded)'}

## Blockers
${(cp.blockers && cp.blockers.length > 0) ? cp.blockers.map((b) => `- ${b}`).join('\n') : '- None blocking continuation.'}

## Next Action
${cp.nextAction}

## No-Replay Rules
- Items marked PASS_ALREADY_EVIDENCED must NOT be rerun unless: source changed; dependency changed; evidence invalidated; or the final verifier explicitly requires an independent rerun (record the reason when rerunning).
- Do NOT replay the full historical conversation. This checkpoint + the canonical task specification are the continuation input.
`;
}

// ── Atomic write (§18) ──────────────────────────────────────────────────────

export interface AtomicWriteResult {
  ok: boolean;
  wrotePath?: string;
  snapshotPath?: string;
  error?: string;
}

/**
 * Atomic checkpoint write: temp file in the same directory → fsync → rename to
 * HANDOFF_CHECKPOINT.md. Optionally keep a timestamped snapshot for audit.
 * Never partially overwrites the canonical file.
 */
export function writeHandoffCheckpointAtomic(
  dir: string,
  markdown: string,
  opts?: { keepSnapshot?: boolean; timestamp?: Date }
): AtomicWriteResult {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ts = (opts?.timestamp ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
    const final = path.join(dir, 'HANDOFF_CHECKPOINT.md');
    const tmp = path.join(dir, `.HANDOFF_CHECKPOINT.md.tmp-${process.pid}-${Date.now()}`);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, markdown, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, final);
    let snapshotPath: string | undefined;
    if (opts?.keepSnapshot !== false) {
      snapshotPath = path.join(dir, `HANDOFF_CHECKPOINT.${ts}.md`);
      try {
        fs.writeFileSync(snapshotPath, markdown, 'utf8');
      } catch {
        snapshotPath = undefined;
      }
    }
    return { ok: true, wrotePath: final, snapshotPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── DB persistence of checkpoints (work_checkpoints) ───────────────────────

export interface HandoffCheckpointRow {
  id: string;
  task_id: string;
  agent_id: string | null;
  checkpoint_type: string;
  state_summary: string;
  files_snapshot: string | null;
  context_data: string | null;
  created_at: string;
}

/**
 * Persist a handoff checkpoint into work_checkpoints. context_data carries the
 * structured HANDOFF_CHECKPOINT_V1 JSON under { handoff: {...} } so it is
 * discoverable without schema changes (backward compatible).
 *
 * Schema note: work_checkpoints.agent_id is NOT NULL with an FK to agents(id)
 * (pre-existing constraint, no migration in this remediation). Handoff
 * checkpoints are task/system-level, so the agent is resolved: explicit param
 * → task.assigned_agent_id → any workspace agent (stable ORDER BY). Fails
 * loudly if none resolves — callers record HANDOFF_BLOCKED and leave the
 * session running (§26).
 */
function resolveCheckpointAgentId(taskId: string, agentId: string | null): string {
  if (agentId) {
    const hit = queryOne<{ id: string }>('SELECT id FROM agents WHERE id = ?', [agentId]);
    if (hit) return hit.id;
  }
  const task = queryOne<{ assigned_agent_id: string | null; workspace_id?: string | null }>(
    'SELECT assigned_agent_id, workspace_id FROM tasks WHERE id = ?',
    [taskId]
  );
  if (task?.assigned_agent_id) {
    const assigned = queryOne<{ id: string }>('SELECT id FROM agents WHERE id = ?', [task.assigned_agent_id]);
    if (assigned) return assigned.id;
  }
  const fallback = queryOne<{ id: string }>('SELECT id FROM agents ORDER BY created_at ASC LIMIT 1');
  if (fallback) return fallback.id;
  throw new Error(`No agent available to attribute handoff checkpoint for task ${taskId}`);
}

export function saveHandoffCheckpointRow(params: {
  taskId: string;
  agentId: string | null;
  checkpointType: 'auto' | 'manual' | 'crash_recovery';
  cp: HandoffCheckpointV1;
  filesSnapshot?: Array<{ path: string; hash: string; size: number }>;
}): HandoffCheckpointRow {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const resolvedAgentId = resolveCheckpointAgentId(params.taskId, params.agentId);
  const summary = `${params.cp.identity.stage} — completed ${params.cp.completed.filter((c) => c.class === 'PASS_ALREADY_EVIDENCED').length}, remaining ${params.cp.remaining.length}; next: ${params.cp.nextAction.slice(0, 200)}`;
  run(
    `INSERT INTO work_checkpoints (id, task_id, agent_id, checkpoint_type, state_summary, files_snapshot, context_data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.taskId,
      resolvedAgentId,
      params.checkpointType,
      summary,
      params.filesSnapshot ? JSON.stringify(params.filesSnapshot) : null,
      JSON.stringify({ handoff: params.cp }),
      now,
    ]
  );
  return queryOne<HandoffCheckpointRow>('SELECT * FROM work_checkpoints WHERE id = ?', [id])!;
}

/** Latest handoff checkpoint (HANDOFF_CHECKPOINT_V1) for a task, if any. */
export function getLatestHandoffCheckpoint(taskId: string): { row: HandoffCheckpointRow; cp: HandoffCheckpointV1 } | null {
  const rows = queryAll<HandoffCheckpointRow>(
    `SELECT * FROM work_checkpoints WHERE task_id = ? AND context_data IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 20`,
    [taskId]
  );
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.context_data || '{}') as { handoff?: HandoffCheckpointV1 };
      if (parsed.handoff && parsed.handoff.schema === HANDOFF_CHECKPOINT_SCHEMA) {
        return { row, cp: parsed.handoff };
      }
    } catch {
      // ignore malformed rows
    }
  }
  return null;
}

/** Count of session continuations recorded for the task (rotation + handoff). */
export function getContinuationIndex(taskId: string, agentId?: string | null): number {
  const row = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM openclaw_sessions WHERE task_id = ? ${agentId ? 'AND agent_id = ?' : ''}`,
    agentId ? [taskId, agentId] : [taskId]
  );
  return Math.max(1, (row?.c ?? 0));
}

// ── Mechanical checkpoint synthesis (§3/§16 fallback) ──────────────────────

interface ActivityRow {
  activity_type: string;
  message: string;
  metadata: string | null;
  created_at: string;
}

interface DeliverableRow {
  deliverable_type: string;
  title: string;
  path: string | null;
  created_at: string;
}

/**
 * Synthesize a VALID mechanical checkpoint from Mission Control DB state when
 * a session must be replaced but the agent could not author one. Honest by
 * construction: evidence only from registered deliverables/activities; the
 * first remaining item instructs the continuation to reconcile the checklist
 * from the canonical task spec (never "continue previous work").
 */
export function synthesizeHandoffCheckpoint(taskId: string, reason: string, stageOverride?: string): HandoffCheckpointV1 | null {
  const task = queryOne<Task & { assigned_agent_name?: string }>(
    `SELECT t.*, a.name AS assigned_agent_name FROM tasks t LEFT JOIN agents a ON t.assigned_agent_id = a.id WHERE t.id = ?`,
    [taskId]
  );
  if (!task) return null;

  const activities = queryAll<ActivityRow>(
    `SELECT activity_type, message, metadata, created_at FROM task_activities WHERE task_id = ? ORDER BY created_at DESC LIMIT 40`,
    [taskId]
  );
  const deliverables = queryAll<DeliverableRow>(
    `SELECT deliverable_type, title, path, created_at FROM task_deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT 20`,
    [taskId]
  );
  const sessions = queryAll<OpenClawSession>(
    `SELECT * FROM openclaw_sessions WHERE task_id = ? ORDER BY created_at DESC LIMIT 10`,
    [taskId]
  );

  const completed: ChecklistItem[] = [];
  let i = 0;
  const seenTitles = new Set<string>();
  for (const d of deliverables) {
    const key = `${d.title}`;
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    completed.push({
      id: `S-${++i}`,
      text: `Deliverable registered: ${d.title}`,
      class: 'PASS_ALREADY_EVIDENCED',
      result: `registered ${d.created_at} [${d.deliverable_type}]`,
      evidence: d.path ? [d.path] : [],
    });
  }
  for (const a of activities) {
    if (a.activity_type === 'completed') {
      completed.push({
        id: `A-${++i}`,
        text: `Reported completion: ${a.message.slice(0, 220)}`,
        class: 'PASS_ALREADY_EVIDENCED',
        result: a.created_at,
        evidence: [],
      });
    }
  }

  const remaining: ChecklistItem[] = [
    {
      id: 'R-RECONCILE',
      text:
        'Reconstruct the remaining checklist from the canonical task specification vs the completed/evidence list above; update this checkpoint with the agent-authored detail (each item independently actionable).',
      class: 'REQUIRES_EXECUTION',
    },
    {
      id: 'R-CONTINUE',
      text: `Continue executing the task specification from the first not-yet-evidenced item. Reason this checkpoint is mechanical: ${reason}.`,
      class: 'REQUIRES_EXECUTION',
    },
    {
      id: 'R-VERIFY',
      text: 'Run the required validation/tests for the task and record PASS/FAIL counts + evidence before completion.',
      class: 'REQUIRES_EXECUTION',
    },
  ];

  const lastActive = sessions.find((s) => s.status === 'active');
  const evidenceLocal = deliverables.filter((d) => d.path).map((d) => d.path as string);
  const boxRefs = deliverables
    .filter((d) => (d.path ?? '').includes('box:') || (d.path ?? '').includes('box.com'))
    .map((d) => d.path as string);

  const cp: HandoffCheckpointV1 = {
    schema: HANDOFF_CHECKPOINT_SCHEMA,
    identity: {
      project: `mission-control-task:${task.title}`,
      taskId: task.id,
      executionId: lastActive?.openclaw_session_id ?? `session-less-${task.id}`,
      continuationIndex: Math.max(1, sessions.length),
      stage: stageOverride ?? task.status,
      agent: task.assigned_agent_name ?? 'unknown',
      runtime: 'openclaw',
      timestamp: new Date().toISOString(),
    },
    source: {
      repository: task.repo_url ?? undefined,
      branch: task.repo_branch ?? undefined,
      worktreeStatus: task.workspace_path ? `workspace: ${task.workspace_path}` : 'in-place (no isolated workspace recorded)',
      filesChanged: evidenceLocal.slice(0, 20),
    },
    completed,
    remaining,
    validation: {
      testsRun: [],
      passCount: null,
      failCount: null,
      unresolvedFailures: [],
      testsPending: ['task acceptance tests (not yet recorded — verify before completion)'],
    },
    evidence: {
      local: evidenceLocal.slice(0, 20),
      git: task.repo_url ? [`${task.repo_url}@${task.repo_branch ?? 'unknown-branch'}`] : [],
      box: boxRefs.slice(0, 10),
      ids: { task_id: task.id },
    },
    decisions: [
      'Mechanical checkpoint synthesized by Mission Control (bounded-session lifecycle) — semantic items must be reconciled by the continuation agent.',
    ],
    blockers: [],
    nextAction:
      'Load the canonical task specification + this checkpoint only. Do NOT replay completed items (PASS_ALREADY_EVIDENCED). Reconcile remaining checklist (R-RECONCILE) first, then execute.',
    generatedBy: 'system-synthesis',
    reason,
  };

  const validation = validateHandoffCheckpoint(cp);
  if (!validation.ok) {
    // A synthesized checkpoint that fails validation must not be persisted as valid.
    return null;
  }
  return cp;
}

// ── Task handoff metadata (tasks.metadata JSON, no migration) ──────────────

/**
 * Handoff lifecycle state carried on tasks.metadata (JSON, merge-safe):
 *  - ARMED: a valid checkpoint exists; ready for the next budget rollover.
 *  - ROLLOVER_REQUESTED: watchdog decided to roll over; the next dispatch of
 *    this task MUST inject the bounded continuation context.
 *  - CONTINUATION_PENDING: rollover attempted but the fresh session could not
 *    start; retry on future sweeps (preserve checkpoint + task state).
 *  - COMPLETED: task finished; no further handoff injections.
 */
export type HandoffStatus = 'ARMED' | 'ROLLOVER_REQUESTED' | 'CONTINUATION_PENDING' | 'COMPLETED';

export interface HandoffTaskMetadata {
  handoff_status?: HandoffStatus;
  handoff_checkpoint_id?: string;
  handoff_continuation_index?: number;
  handoff_retry_count?: number;
  handoff_updated_at?: string;
}

/** Read handoff metadata from a tasks.metadata JSON string (never throws). */
export function readHandoffMetadata(metadataJson: string | null | undefined): HandoffTaskMetadata {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as { handoff?: HandoffTaskMetadata } & HandoffTaskMetadata;
    const handoff = parsed?.handoff ?? parsed;
    return {
      handoff_status: handoff?.handoff_status,
      handoff_checkpoint_id: handoff?.handoff_checkpoint_id,
      handoff_continuation_index: handoff?.handoff_continuation_index,
      handoff_retry_count: handoff?.handoff_retry_count,
      handoff_updated_at: handoff?.handoff_updated_at,
    };
  } catch {
    return {};
  }
}

/** Merge a handoff metadata patch into tasks.metadata (preserves other keys). */
export function writeHandoffMetadata(taskId: string, patch: HandoffTaskMetadata): HandoffTaskMetadata {
  const row = queryOne<{ metadata: string | null }>('SELECT metadata FROM tasks WHERE id = ?', [taskId]);
  let root: Record<string, unknown> = {};
  try {
    root = row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
  } catch {
    root = {};
  }
  const current = readHandoffMetadata(row?.metadata ?? null);
  const merged: HandoffTaskMetadata = { ...current, ...patch, handoff_updated_at: new Date().toISOString() };
  root.handoff = merged;
  run('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ?', [JSON.stringify(root), new Date().toISOString(), taskId]);
  return merged;
}

// ── Lifecycle observability (§25) ──────────────────────────────────────────

export const HANDOFF_ACTIVITY_TYPES = [
  'context_budget_warning',
  'checkpoint_started',
  'checkpoint_completed',
  'checkpoint_failed',
  'session_handoff_started',
  'continuation_session_started',
  'checkpoint_resume_verified',
  'session_handoff_failed',
  'continuation_pending',
] as const;

export type HandoffActivityType = (typeof HANDOFF_ACTIVITY_TYPES)[number];

export function logHandoffActivity(
  taskId: string,
  activityType: HandoffActivityType,
  message: string,
  metadata?: Record<string, unknown>
): void {
  try {
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      [crypto.randomUUID(), taskId, activityType, message, metadata ? JSON.stringify(metadata) : null, new Date().toISOString()]
    );
  } catch (error) {
    console.warn(`[Handoff] Failed to log activity ${activityType} for task ${taskId}:`, error);
  }
}

/** Latest activity timestamp (ms) of a given type for a task, or null. */
export function lastHandoffActivityMs(taskId: string, activityType: HandoffActivityType): number | null {
  const row = queryOne<{ created_at: string }>(
    `SELECT created_at FROM task_activities WHERE task_id = ? AND activity_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [taskId, activityType]
  );
  if (!row?.created_at) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(row.created_at) ? `${row.created_at.replace(' ', 'T')}Z` : row.created_at);
  return Number.isNaN(t) ? null : t;
}

/** Latest activity of a type with parsed metadata (for session-scoped guards). */
export function lastHandoffActivity(
  taskId: string,
  activityType: HandoffActivityType
): { createdAtMs: number | null; metadata: Record<string, unknown> | null } | null {
  const row = queryOne<{ created_at: string; metadata: string | null }>(
    `SELECT created_at, metadata FROM task_activities WHERE task_id = ? AND activity_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [taskId, activityType]
  );
  if (!row) return null;
  let metadata: Record<string, unknown> | null = null;
  try {
    metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null;
  } catch {
    metadata = null;
  }
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(row.created_at) ? `${row.created_at.replace(' ', 'T')}Z` : row.created_at);
  return { createdAtMs: Number.isNaN(t) ? null : t, metadata };
}

// ── Bounded continuation context (§6) ──────────────────────────────────────

/**
 * Build the bounded continuation context injected into a FRESH session.
 * Contains ONLY: canonical task identity, the latest valid HANDOFF_CHECKPOINT,
 * evidence references, and the no-replay rules. NEVER the full conversation.
 * Hard char bound (CONTINUATION_CONTEXT_MAX_CHARS).
 */
export function buildBoundedContinuationContext(taskId: string): { text: string; chars: number; checkpointId: string; continuationIndex: number } | null {
  const found = getLatestHandoffCheckpoint(taskId);
  if (!found) return null;
  const { cp, row } = found;
  const validation = validateHandoffCheckpoint(cp);
  if (!validation.ok) return null;

  const completed = cp.completed.filter((c) => c.class === 'PASS_ALREADY_EVIDENCED');
  const remaining = cp.remaining;

  const lines: string[] = [];
  lines.push('---');
  lines.push('## CONTINUATION CONTEXT (bounded — session handoff)');
  lines.push(`This session CONTINUES an existing task. Full historical conversation is deliberately omitted.`);
  lines.push(`Checkpoint: ${row.id} (${cp.schema}), generated_by=${cp.generatedBy}, at ${cp.identity.timestamp}.`);
  lines.push(`Continuation #${cp.identity.continuationIndex}. Stage: ${cp.identity.stage}.`);
  if (cp.source?.headSha) lines.push(`Source HEAD: ${cp.source.headSha}${cp.source.branch ? ` (branch ${cp.source.branch})` : ''}.`);
  if (cp.source?.repository) lines.push(`Repository: ${cp.source.repository}.`);
  lines.push('');
  lines.push('### Completed — DO NOT REPLAY (PASS_ALREADY_EVIDENCED)');
  if (completed.length === 0) lines.push('- (none yet evidenced)');
  else for (const c of completed.slice(0, 12)) lines.push(`- ${c.id}: ${c.text}${c.evidence && c.evidence.length > 0 ? ` [evidence: ${c.evidence.slice(0, 3).join(', ')}]` : ''}`);
  lines.push('');
  lines.push('### Remaining — EXECUTE (in order)');
  if (remaining.length === 0) lines.push('- (none — proceed to final validation)');
  else for (const r of remaining.slice(0, 14)) lines.push(`- ${r.id} [${r.class}]: ${r.text}`);
  lines.push('');
  lines.push('### Validation State');
  lines.push(`- tests run: ${(cp.validation?.testsRun ?? []).join('; ') || 'none recorded'}`);
  lines.push(`- counts: ${cp.validation?.passCount ?? '?'} PASS / ${cp.validation?.failCount ?? '?'} FAIL`);
  lines.push(`- still to run: ${(cp.validation?.testsPending ?? []).join('; ') || 'none recorded'}`);
  lines.push('');
  lines.push('### Evidence');
  const ev = cp.evidence ?? {};
  if (ev.local?.length) lines.push(`- local: ${ev.local.slice(0, 8).join(' | ')}`);
  if (ev.git?.length) lines.push(`- git: ${ev.git.slice(0, 6).join(' | ')}`);
  if (ev.box?.length) lines.push(`- box: ${ev.box.slice(0, 6).join(' | ')}`);
  lines.push('');
  lines.push('### Blockers');
  lines.push((cp.blockers && cp.blockers.length > 0) ? cp.blockers.map((b) => `- ${b}`).join('\n') : '- none');
  lines.push('');
  lines.push('### Next Action (execute FIRST)');
  lines.push(cp.nextAction);
  lines.push('');
  lines.push('Rules: do NOT repeat PASS_ALREADY_EVIDENCED work; do NOT ask for historical conversation; if a completed item is invalidated by your changes, record the reason and re-run only that item; create a NEW handoff checkpoint at the next result boundary or context-budget warning.');
  lines.push('---');

  let text = lines.join('\n');
  let truncated = false;
  if (text.length > CONTINUATION_CONTEXT_MAX_CHARS) {
    text = text.slice(0, CONTINUATION_CONTEXT_MAX_CHARS - 200) + '\n...[continuation context truncated — see HANDOFF_CHECKPOINT for full detail]';
    truncated = true;
  }
  return { text, chars: text.length, checkpointId: row.id, continuationIndex: cp.identity.continuationIndex };
}

/** Touch helper used when injecting file-based checkpoints (native/manual). */
export function externalCheckpointPathCandidates(task: Task): string[] {
  const out: string[] = [];
  if (task.workspace_path) out.push(path.join(task.workspace_path, 'HANDOFF_CHECKPOINT.md'));
  return out;
}

/** Find a HANDOFF_CHECKPOINT.md file on disk for a task (workspace first). */
export function findExternalCheckpointFile(task: Task): string | null {
  for (const p of externalCheckpointPathCandidates(task)) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

// ── §16 recovery: RESUME_FROM_CHECKPOINT ───────────────────────────────────

/**
 * If a session ends because of context overflow / compaction failure / provider
 * timeout / gateway restart / model failure, Mission Control must first search
 * for the latest VALID checkpoint and prepare RESUME_FROM_CHECKPOINT — never
 * restart the task from the beginning.
 *
 * This helper: finds the latest valid HANDOFF_CHECKPOINT_V1, marks the task
 * CONTINUATION_PENDING (so the NEXT dispatch — stage watchdog / manual retry —
 * injects the bounded continuation context), and records a
 * `continuation_pending` activity. Deduplicated per ended session so repeated
 * sweeps do not spam the timeline.
 */
export function prepareResumeFromCheckpoint(
  taskId: string,
  reason: string,
  endedSessionId?: string
): { prepared: boolean; checkpointId?: string; reason?: string } {
  const found = getLatestHandoffCheckpoint(taskId);
  if (!found || !validateHandoffCheckpoint(found.cp).ok) {
    return { prepared: false, reason: 'no_valid_checkpoint' };
  }

  if (endedSessionId) {
    const dup = queryOne<{ id: string }>(
      `SELECT id FROM task_activities
        WHERE task_id = ? AND activity_type = 'continuation_pending'
          AND metadata LIKE ? LIMIT 1`,
      [taskId, `%"sessionId":"${endedSessionId}"%`]
    );
    if (dup) return { prepared: false, reason: 'already_prepared', checkpointId: found.row.id };
  }

  writeHandoffMetadata(taskId, {
    handoff_status: 'CONTINUATION_PENDING',
    handoff_checkpoint_id: found.row.id,
    handoff_continuation_index: found.cp.identity.continuationIndex,
  });
  logHandoffActivity(
    taskId,
    'continuation_pending',
    `RESUME_FROM_CHECKPOINT prepared (${reason}) — next dispatch injects bounded continuation from checkpoint ${found.row.id}`,
    { checkpointId: found.row.id, reason, sessionId: endedSessionId ?? null }
  );
  return { prepared: true, checkpointId: found.row.id };
}
