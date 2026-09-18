/**
 * GLOBAL ODE STALL REMEDIATION (2026-09-18) — human-decision recovery.
 *
 * A task parked at menunggu_keputusan_manusia is NOT in STAGE_STATUSES, so the
 * stage watchdog stops sweeping it. `POST /api/tasks/:id/dispatch/retry` used
 * to dispatch a fresh agent session anyway and leave the task parked:
 *
 *   00:14:03 [Dispatch] previousTaskStatus: menunggu_keputusan_manusia,
 *                     expectedTaskStatus: menunggu_keputusan_manusia
 *   00:14:04 session rotated to r11
 *   ...      r11 ran, ended without a callback, task stayed parked
 *
 * The retry is an explicit operator action ("continue this work"), so it must
 * also put the task back into the stage status owned by its assigned agent's
 * role — otherwise the recovered session is invisible to the watchdog and the
 * work is wasted.
 */

import { queryOne, run } from '@/lib/db';
import { mapRoleToCanonical } from '@/lib/canonical-agents';
import { stageStatusForRole } from '@/lib/stage-role-map';
import { HUMAN_DECISION_STATUS, resetStageRestartCount } from '@/lib/stage-watchdog';
import { broadcast } from '@/lib/events';
import { v4 as uuidv4 } from 'uuid';
import type { Task } from '@/lib/types';

export interface HumanDecisionRecoveryResult {
  /** True when the task was parked and has been moved back into a stage status. */
  restored: boolean;
  from: string;
  /** Restored stage status, null when nothing was restored. */
  to: string | null;
  /** Role used for the mapping (agent.role as stored). */
  agentRole: string | null;
  /** Why nothing was restored (deterministic reason code). */
  reason?: 'not_parked' | 'no_agent' | 'agent_not_found' | 'unmapped_role';
}

/**
 * If the task is parked at HUMAN_DECISION_STATUS, restore the stage status
 * implied by its assigned agent's role, clear the stale status_reason, grant a
 * fresh auto-recovery budget and record the transition. No-op (and no writes)
 * for any task that is not parked.
 */
export function restoreStageStatusFromHumanDecision(taskId: string): HumanDecisionRecoveryResult {
  const task = queryOne<Pick<Task, 'id' | 'status' | 'assigned_agent_id'>>(
    'SELECT id, status, assigned_agent_id FROM tasks WHERE id = ?',
    [taskId]
  );
  if (!task) return { restored: false, from: 'unknown', to: null, agentRole: null, reason: 'not_parked' };
  if (task.status !== HUMAN_DECISION_STATUS) {
    return { restored: false, from: String(task.status), to: null, agentRole: null, reason: 'not_parked' };
  }
  if (!task.assigned_agent_id) {
    return { restored: false, from: String(task.status), to: null, agentRole: null, reason: 'no_agent' };
  }

  const agent = queryOne<{ role?: string | null }>('SELECT role FROM agents WHERE id = ?', [
    task.assigned_agent_id,
  ]);
  if (!agent) {
    return { restored: false, from: String(task.status), to: null, agentRole: null, reason: 'agent_not_found' };
  }

  const rawRole = agent.role ?? null;
  const canonical = rawRole ? mapRoleToCanonical(rawRole) : null;
  const stageStatus = stageStatusForRole(rawRole) ?? stageStatusForRole(canonical);
  if (!stageStatus) {
    return { restored: false, from: String(task.status), to: null, agentRole: rawRole, reason: 'unmapped_role' };
  }

  run(
    `UPDATE tasks SET status = ?, status_reason = NULL, updated_at = datetime('now') WHERE id = ?`,
    [stageStatus, taskId]
  );
  // Fresh auto-recovery budget for the restored attempt (same contract as the
  // stage-handoff reset in PATCH /api/tasks/:id).
  resetStageRestartCount(taskId);

  const now = new Date().toISOString();
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      taskId,
      task.assigned_agent_id,
      'status_changed',
      `Retry from human decision: ${HUMAN_DECISION_STATUS} → ${stageStatus} (${canonical ?? rawRole ?? 'unknown'} stage, fresh auto-recovery budget)`,
      JSON.stringify({
        reason: 'human_decision_retry_restore',
        from: HUMAN_DECISION_STATUS,
        to: stageStatus,
        agentRole: rawRole,
        canonicalRole: canonical,
      }),
      now,
    ]
  );

  const refreshed = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (refreshed) broadcast({ type: 'task_updated', payload: refreshed });

  return { restored: true, from: HUMAN_DECISION_STATUS, to: stageStatus, agentRole: rawRole };
}
