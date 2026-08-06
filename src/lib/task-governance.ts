import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { notifyLearner } from '@/lib/learner';
import { generateInsights, saveInsights } from '@/lib/session-insights';
import { generateImprovedPrompt } from '@/lib/prompt-improver';
import type { Task } from '@/lib/types';

const ACTIVE_STATUSES = ['assigned', 'in_progress', 'convoy_active', 'testing', 'review', 'verification'];

// ── PLATFORM-019: evidence gate message detail ────────────────────────────
// Single source of truth for per-stage evidence requirements. Both the boolean
// gates (hasStageEvidence / taskCanBeDone) AND the enriched error messages
// (generateEvidenceErrorMessage / evaluateEvidenceGate) read from these maps,
// so the thresholds can never drift between "what blocks a transition" and
// "what the error message reports".

export const ACCEPTED_EVIDENCE_ACTIVITY_TYPES = ['completed', 'file_created', 'updated'] as const;

export interface EvidenceRequirement {
  deliverables: number;
  activities: number;
  knowledge: number;
}

/** Thresholds per gate stage — derived from the pre-existing gate logic:
 *  stage entry (testing/review/verification) requires deliverable >= 1 and
 *  activity >= 1 (hasStageEvidence); done additionally requires a learner
 *  knowledge entry >= 1 (PLATFORM-004b hasLearnerKnowledge). */
export const STAGE_EVIDENCE_REQUIREMENTS: Record<string, EvidenceRequirement> = {
  testing: { deliverables: 1, activities: 1, knowledge: 0 },
  review: { deliverables: 1, activities: 1, knowledge: 0 },
  verification: { deliverables: 1, activities: 1, knowledge: 0 },
  done: { deliverables: 1, activities: 1, knowledge: 1 },
};

export interface EvidenceCounts {
  deliverables: number;
  activities: number;
  knowledge: number;
}

export interface EvidenceCategoryBreakdown {
  current: number;
  required: number;
  missing: number;
}

export interface EvidenceDetails {
  deliverables: EvidenceCategoryBreakdown;
  activities: EvidenceCategoryBreakdown & { acceptedTypes: readonly string[] };
  knowledge: EvidenceCategoryBreakdown;
}

export interface EvidenceGateResult {
  met: boolean;
  message: string;
  details: EvidenceDetails;
}

export function evidenceRequirementsForStage(stage: string): EvidenceRequirement {
  return STAGE_EVIDENCE_REQUIREMENTS[stage] ?? STAGE_EVIDENCE_REQUIREMENTS.done;
}

export function getEvidenceCounts(taskId: string): EvidenceCounts {
  const deliverable = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM task_deliverables WHERE task_id = ?', [taskId]);
  const activity = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM task_activities WHERE task_id = ? AND activity_type IN (${ACCEPTED_EVIDENCE_ACTIVITY_TYPES.map(() => '?').join(', ')})`,
    [taskId, ...ACCEPTED_EVIDENCE_ACTIVITY_TYPES]
  );
  const knowledge = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM knowledge_entries WHERE task_id = ?', [taskId]);
  return {
    deliverables: Number(deliverable?.count || 0),
    activities: Number(activity?.count || 0),
    knowledge: Number(knowledge?.count || 0),
  };
}

export function hasStageEvidence(taskId: string): boolean {
  const counts = getEvidenceCounts(taskId);
  return counts.deliverables > 0 && counts.activities > 0;
}

/**
 * PLATFORM-019: build the human-readable message + structured `details`
 * breakdown for a stage's evidence gate from ACTUAL current counts. Pure
 * function (no DB) — fully unit-testable.
 *
 * Only categories REQUIRED by the stage are listed, e.g.:
 *   done:     "Cannot mark done: missing 0/1 deliverables, 0/1 activities (completed/file_created/updated), 0/1 knowledge entries"
 *   testing:  "Evidence gate failed: missing 0/1 deliverables, 0/1 activities (completed/file_created/updated)"
 */
export function generateEvidenceErrorMessage(
  stage: string,
  current: EvidenceCounts
): { message: string; details: EvidenceDetails } {
  const req = evidenceRequirementsForStage(stage);
  const details: EvidenceDetails = {
    deliverables: {
      current: current.deliverables,
      required: req.deliverables,
      missing: Math.max(0, req.deliverables - current.deliverables),
    },
    activities: {
      current: current.activities,
      required: req.activities,
      missing: Math.max(0, req.activities - current.activities),
      acceptedTypes: [...ACCEPTED_EVIDENCE_ACTIVITY_TYPES],
    },
    knowledge: {
      current: current.knowledge,
      required: req.knowledge,
      missing: Math.max(0, req.knowledge - current.knowledge),
    },
  };

  const missingParts: string[] = [];
  if (req.deliverables > 0 && current.deliverables < req.deliverables) missingParts.push(`${current.deliverables}/${req.deliverables} deliverables`);
  if (req.activities > 0 && current.activities < req.activities) missingParts.push(`${current.activities}/${req.activities} activities (${ACCEPTED_EVIDENCE_ACTIVITY_TYPES.join('/')})`);
  if (req.knowledge > 0 && current.knowledge < req.knowledge) missingParts.push(`${current.knowledge}/${req.knowledge} knowledge entries`);

  const prefix = stage === 'done' ? 'Cannot mark done:' : 'Evidence gate failed:';
  const message = missingParts.length > 0 ? `${prefix} missing ${missingParts.join(', ')}` : `${prefix} all evidence requirements met`;
  return { message, details };
}

/**
 * PLATFORM-019: full evidence gate evaluation for a stage — counts evidence
 * from the DB, compares against the stage's requirements, and returns a
 * consistent { met, message, details } result. Used by PATCH /api/tasks/:id
 * for every gate transition (testing/review/verification/done).
 */
export function evaluateEvidenceGate(taskId: string, stage: string): EvidenceGateResult {
  const current = getEvidenceCounts(taskId);
  const req = evidenceRequirementsForStage(stage);
  const met =
    current.deliverables >= req.deliverables &&
    current.activities >= req.activities &&
    current.knowledge >= req.knowledge;
  const { message, details } = generateEvidenceErrorMessage(stage, current);
  return { met, message, details };
}

/** True when status_reason contains 'fail' (the validation-failure flag from taskCanBeDone). */
export function hasValidationFailureFlag(taskId: string): boolean {
  const task = queryOne<{ status_reason?: string }>('SELECT status_reason FROM tasks WHERE id = ?', [taskId]);
  return ((task?.status_reason || '').toLowerCase().includes('fail'));
}

export function canUseBoardOverride(request: Request): boolean {
  if (process.env.BOARD_OVERRIDE_ENABLED !== 'true') return false;
  return request.headers.get('x-mc-board-override') === 'true';
}

export function auditBoardOverride(taskId: string, fromStatus: string, toStatus: string, reason?: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO events (id, type, task_id, message, metadata, created_at)
     VALUES (lower(hex(randomblob(16))), 'system', ?, ?, ?, ?)`,
    [taskId, `Board override: ${fromStatus} → ${toStatus}`, JSON.stringify({ boardOverride: true, reason: reason || null }), now]
  );
}

export function getFailureCountInStage(taskId: string, stage: string): number {
  const row = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM task_activities
     WHERE task_id = ? AND activity_type = 'status_changed' AND message LIKE ?`,
    [taskId, `%Stage failed: ${stage}%`]
  );
  return Number(row?.count || 0);
}

export function ensureFixerExists(workspaceId: string): { id: string; name: string; created: boolean } {
  const existing = queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM agents WHERE workspace_id = ? AND role IN ('fixer','senior') AND status != 'offline' ORDER BY role = 'fixer' DESC, updated_at DESC LIMIT 1`,
    [workspaceId]
  );
  if (existing) return { ...existing, created: false };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = 'Auto Fixer';
  run(
    `INSERT INTO agents (id, name, role, description, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
     VALUES (?, ?, 'fixer', 'Auto-created fixer for repeated stage failures', '🛠️', 'standby', 0, ?, 'local', ?, ?)`,
    [id, name, workspaceId, now, now]
  );
  return { id, name, created: true };
}

export async function escalateFailureIfNeeded(taskId: string, stage: string): Promise<void> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) return;

  if (getFailureCountInStage(taskId, stage) < 2) return;

  const fixer = ensureFixerExists(task.workspace_id);
  const now = new Date().toISOString();
  transaction(() => {
    run('UPDATE tasks SET assigned_agent_id = ?, status_reason = ?, updated_at = ? WHERE id = ?', [
      fixer.id,
      `Escalated after repeated failures in ${stage}`,
      now,
      taskId,
    ]);

    run(
      `INSERT OR REPLACE INTO task_roles (id, task_id, role, agent_id, created_at)
       VALUES (COALESCE((SELECT id FROM task_roles WHERE task_id = ? AND role = 'fixer'), lower(hex(randomblob(16)))), ?, 'fixer', ?, ?)`,
      [taskId, taskId, fixer.id, now]
    );

    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, 'status_changed', ?, ?)`,
      [taskId, fixer.id, `Escalated to ${fixer.name} after repeated failures in ${stage}`, now]
    );
  });

  if (fixer.created) {
    await notifyLearner(taskId, {
      previousStatus: stage,
      newStatus: stage,
      passed: true,
      context: `Auto-created fixer agent (${fixer.name}) due to repeated stage failures.`,
    });
  }
}

export async function recordLearnerOnTransition(taskId: string, previousStatus: string, newStatus: string, passed = true, failReason?: string): Promise<void> {
  await notifyLearner(taskId, { previousStatus, newStatus, passed, failReason });

  // Trigger insight generation when task reaches 'done'
  if (newStatus === 'done') {
    triggerInsightGeneration(taskId).catch(err =>
      console.error(`[Governance] Insight generation failed for task ${taskId}:`, err)
    );
  }
}

/** Generate and save insights for a completed task (fire-and-forget). */
async function triggerInsightGeneration(taskId: string): Promise<void> {
  const task = queryOne<{ id: string; product_id: string | null; title: string; description: string | null; status: string }>(
    'SELECT id, product_id, title, description, status FROM tasks WHERE id = ?',
    [taskId]
  );
  if (!task) return;

  const productId = task.product_id || 'unknown';
  const insights = generateInsights(taskId);
  if (!insights) return;

  let improvedPrompt: string | null = null;
  try {
    improvedPrompt = await generateImprovedPrompt({
      originalDescription: task.description || '',
      taskTitle: task.title,
      taskStatus: task.status,
      insights,
    });
  } catch {
    // Non-fatal — save insights without improved prompt
  }

  saveInsights(taskId, productId, insights, improvedPrompt || undefined);
  console.log(`[Governance] Insights generated for task ${taskId}`);
}

/**
 * PLATFORM-004b: learner knowledge gate.
 * The learner is a fire-and-forget hook (not a sequential stage); the done
 * transition is gated on the learner having written >=1 knowledge entry for
 * this task (task-scoped, auto-tagged task_id by the task-scoped learner session).
 */
export function hasLearnerKnowledge(taskId: string): boolean {
  const row = queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM knowledge_entries WHERE task_id = ?',
    [taskId]
  );
  return Number(row?.count || 0) >= 1;
}

export function taskCanBeDone(taskId: string): boolean {
  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  if (!task) return false;
  return !hasValidationFailureFlag(taskId) && hasStageEvidence(taskId) && hasLearnerKnowledge(taskId);
}

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function pickDynamicAgent(taskId: string, stageRole?: string | null): { id: string; name: string } | null {
  // PLATFORM-005: all agent queries must be scoped to the task's workspace
  const task = queryOne<{ workspace_id: string; planning_agents?: string }>(
    'SELECT workspace_id, planning_agents FROM tasks WHERE id = ?', [taskId]
  );
  if (!task) return null;
  const workspaceId = task.workspace_id;

  const plannerCandidates: string[] = [];
  if (task.planning_agents) {
    try {
      const parsed = JSON.parse(task.planning_agents) as Array<{ agent_id?: string; role?: string }>;
      for (const a of parsed) {
        if (a.role && stageRole && a.role.toLowerCase().includes(stageRole.toLowerCase()) && a.agent_id) plannerCandidates.push(a.agent_id);
      }
    } catch {}
  }

  const checked = new Set<string>();
  for (const candidateId of plannerCandidates) {
    const candidate = queryOne<{ id: string; name: string; is_master: number; status: string }>(
      'SELECT id, name, is_master, status FROM agents WHERE id = ? AND workspace_id = ? LIMIT 1',
      [candidateId, workspaceId]
    );
    if (!candidate || candidate.status === 'offline') continue;
    checked.add(candidate.id);
    return { id: candidate.id, name: candidate.name };
  }

  if (stageRole) {
    const byRole = queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM agents WHERE role = ? AND workspace_id = ? AND status != 'offline' ORDER BY status = 'standby' DESC, updated_at DESC LIMIT 1`,
      [stageRole, workspaceId]
    );
    if (byRole) return byRole;
  }

  const fallback = queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM agents WHERE workspace_id = ? AND status != 'offline' ORDER BY is_master ASC, updated_at DESC LIMIT 1`,
    [workspaceId]
  );
  if (fallback && !checked.has(fallback.id)) return fallback;

  return null;
}
