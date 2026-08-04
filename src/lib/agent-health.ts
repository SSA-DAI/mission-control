import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { buildCheckpointContext } from '@/lib/checkpoint';
import { cancelCodexRunsForTask } from '@/lib/codex/dispatch';
import type { Agent, AgentHealth, AgentHealthState, SemanticAgentHealthState, Task } from '@/lib/types';

const RECENT_SIGNAL_MINUTES = 5;
const CHAT_REPLY_GRACE_MINUTES = 30;
const NEEDS_ATTENTION_MINUTES = 45;
const GENUINELY_STUCK_MINUTES = 90;
const AUTO_NUDGE_AFTER_STALLS = 3;

const ACTIVE_TASK_STATUSES = ['assigned', 'in_progress', 'testing', 'verification'] as const;

// ---- PLATFORM-007: orphaned-task auto-dispatch backoff + circuit-breaker ----
// Module-scope state so it survives across health-check cycles.  (Previous draft
// declared this Map inside runHealthCheckCycle, which reset it every cycle and
// made the backoff/breaker ineffective — the 319× no-op loop would recur.)
const MAX_ORPHAN_DISPATCH_ATTEMPTS = 5;
const ORPHAN_BACKOFF_BASE_MS = 2 * 60 * 1000; // 2 minutes base
const orphanDispatchState = new Map<string, { attempts: number; lastAttemptMs: number }>(); // taskId → state

type StoredAgentHealthState = 'idle' | 'working' | 'stalled' | 'stuck' | 'zombie' | 'offline';
type HealthSeverity = 'info' | 'success' | 'warning' | 'danger';

interface TimedRow {
  created_at: string;
}

interface ActivitySignal extends TimedRow {
  id: string;
  activity_type: string;
  message: string;
}

interface NoteSignal extends TimedRow {
  id: string;
  role: 'user' | 'assistant';
  status: string;
  content: string;
}

interface SessionSignal {
  id: string;
  runtime: 'openclaw' | 'codex';
  session_id: string;
  status: string;
  session_type: string;
  created_at: string;
  updated_at: string;
}

interface NudgeTaskState {
  status: string;
  planning_dispatch_error?: string | null;
  status_reason?: string | null;
  updated_at: string;
}

export interface AgentHealthEvaluation {
  agent_id: string;
  task_id?: string;
  health_state: StoredAgentHealthState;
  display_state: SemanticAgentHealthState;
  display_label: string;
  severity: HealthSeverity;
  reason: string;
  confidence: number;
  last_activity_at?: string;
  consecutive_stall_eligible: boolean;
  signals: {
    task_status?: string;
    has_active_session: boolean;
    active_session_id?: string;
    active_session_created_at?: string;
    active_session_updated_at?: string;
    latest_activity_at?: string;
    latest_activity_type?: string;
    latest_activity_message?: string;
    latest_deliverable_at?: string;
    latest_checkpoint_at?: string;
    latest_chat_user_at?: string;
    latest_chat_user_status?: string;
    assistant_reply_after_latest_user: boolean;
    completion_after_latest_user: boolean;
    minutes_since_meaningful_signal?: number;
  };
  thresholds_minutes: {
    recent_signal: number;
    chat_reply_grace: number;
    needs_attention: number;
    genuinely_stuck: number;
  };
}

function parseTimestampMs(value?: string | null): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const normalized = trimmed.includes('T')
    ? (hasTimezone ? trimmed : `${trimmed}Z`)
    : `${trimmed.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Date.parse(trimmed);
}

function normalizeTimestamp(value?: string | null): string | undefined {
  if (!value) return undefined;
  const ms = parseTimestampMs(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : value;
}

function minutesSince(value?: string | null): number | undefined {
  const ms = parseTimestampMs(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.max(0, (Date.now() - ms) / 60000);
}

function latestByTimestamp<T>(items: T[], getTimestamp: (item: T) => string | undefined | null): T | undefined {
  return [...items].sort((a, b) => parseTimestampMs(getTimestamp(b)) - parseTimestampMs(getTimestamp(a)))[0];
}

function maxTimestamp(...values: Array<string | undefined | null>): string | undefined {
  const best = values
    .filter((v): v is string => Boolean(v))
    .sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a))[0];
  return normalizeTimestamp(best);
}

function parseMetadata(metadata?: AgentHealth['metadata']): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  if (typeof metadata === 'object') return metadata;
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isCompletionLike(activity: ActivitySignal): boolean {
  const msg = activity.message.toLowerCase();
  return activity.activity_type === 'completed'
    || msg.includes('task_complete')
    || msg.includes('test_pass')
    || msg.includes('verify_pass')
    || msg.includes('stage handoff')
    || msg.includes('task dispatched to');
}

function isBlockedLike(activity?: ActivitySignal): boolean {
  if (!activity) return false;
  const msg = activity.message.toLowerCase();
  return msg.includes('blocked') || msg.includes('cannot proceed') || msg.includes('failed:') || msg.includes('validation failed');
}

function getActiveTaskForAgent(agentId: string): Task | undefined {
  return queryOne<Task>(
    `SELECT * FROM tasks
     WHERE assigned_agent_id = ?
       AND status IN (${ACTIVE_TASK_STATUSES.map(() => '?').join(',')})
     ORDER BY updated_at DESC
     LIMIT 1`,
    [agentId, ...ACTIVE_TASK_STATUSES]
  );
}

function isActiveSession(session: SessionSignal): boolean {
  return session.status === 'active' || session.status === 'running';
}

function formatSessionId(session: SessionSignal): string {
  return `${session.runtime}:${session.session_id}`;
}

function getRuntimeSessions(agentId: string, taskId: string): SessionSignal[] {
  return queryAll<SessionSignal>(
    `SELECT id, 'openclaw' AS runtime, openclaw_session_id AS session_id, status, session_type, created_at, updated_at
     FROM openclaw_sessions
     WHERE agent_id = ?
       AND (task_id = ? OR task_id IS NULL)
     UNION ALL
     SELECT id, 'codex' AS runtime, id AS session_id, status, 'codex' AS session_type, created_at, updated_at
     FROM codex_sessions
     WHERE agent_id = ?
       AND task_id = ?
     ORDER BY created_at DESC`,
    [agentId, taskId, agentId, taskId]
  );
}

function getActiveRuntimeSessions(agentId: string, taskId: string): SessionSignal[] {
  return getRuntimeSessions(agentId, taskId).filter(isActiveSession);
}

function getSignals(task: Task, agentId: string) {
  const sessions = getRuntimeSessions(agentId, task.id);
  const activeSession = sessions.find(isActiveSession);

  const activities = queryAll<ActivitySignal>(
    `SELECT id, activity_type, message, created_at
     FROM task_activities
     WHERE task_id = ?
       AND message NOT LIKE 'Agent health:%'
     ORDER BY created_at DESC`,
    [task.id]
  );
  const latestActivity = latestByTimestamp(activities, a => a.created_at);

  const latestDeliverable = queryOne<{ created_at: string }>(
    `SELECT created_at FROM task_deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
    [task.id]
  );

  const latestCheckpoint = queryOne<{ created_at: string }>(
    `SELECT created_at FROM work_checkpoints WHERE task_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 1`,
    [task.id, agentId]
  );

  const notes = queryAll<NoteSignal>(
    `SELECT id, role, status, content, created_at
     FROM task_notes
     WHERE task_id = ?
     ORDER BY created_at DESC`,
    [task.id]
  );
  const latestUserNote = latestByTimestamp(notes.filter(n => n.role === 'user'), n => n.created_at);
  const latestUserAtMs = parseTimestampMs(latestUserNote?.created_at);
  const assistantAfterLatestUser = latestUserNote
    ? notes.some(n => n.role === 'assistant' && parseTimestampMs(n.created_at) > latestUserAtMs)
    : false;
  const completionAfterLatestUser = latestUserNote
    ? activities.some(a => isCompletionLike(a) && parseTimestampMs(a.created_at) > latestUserAtMs)
    : false;

  const latestMeaningfulSignalAt = maxTimestamp(
    latestActivity?.created_at,
    latestDeliverable?.created_at,
    latestCheckpoint?.created_at,
    task.updated_at,
    activeSession?.updated_at
  );

  return {
    activeSession,
    latestActivity,
    latestDeliverableAt: normalizeTimestamp(latestDeliverable?.created_at),
    latestCheckpointAt: normalizeTimestamp(latestCheckpoint?.created_at),
    latestUserNote,
    assistantAfterLatestUser,
    completionAfterLatestUser,
    latestMeaningfulSignalAt,
  };
}

function buildEvaluation(
  agentId: string,
  healthState: StoredAgentHealthState,
  displayState: SemanticAgentHealthState,
  displayLabel: string,
  severity: HealthSeverity,
  reason: string,
  confidence: number,
  activeTask?: Task,
  signals?: ReturnType<typeof getSignals>,
  consecutiveStallEligible = false
): AgentHealthEvaluation {
  const latestActivityAt = normalizeTimestamp(signals?.latestActivity?.created_at);
  const latestMeaningfulSignalAt = signals?.latestMeaningfulSignalAt;

  return {
    agent_id: agentId,
    task_id: activeTask?.id,
    health_state: healthState,
    display_state: displayState,
    display_label: displayLabel,
    severity,
    reason,
    confidence,
    last_activity_at: latestMeaningfulSignalAt || latestActivityAt,
    consecutive_stall_eligible: consecutiveStallEligible,
    signals: {
      task_status: activeTask?.status,
      has_active_session: Boolean(signals?.activeSession),
      active_session_id: signals?.activeSession?.session_id,
      active_session_created_at: normalizeTimestamp(signals?.activeSession?.created_at),
      active_session_updated_at: normalizeTimestamp(signals?.activeSession?.updated_at),
      latest_activity_at: latestActivityAt,
      latest_activity_type: signals?.latestActivity?.activity_type,
      latest_activity_message: signals?.latestActivity?.message,
      latest_deliverable_at: signals?.latestDeliverableAt,
      latest_checkpoint_at: signals?.latestCheckpointAt,
      latest_chat_user_at: normalizeTimestamp(signals?.latestUserNote?.created_at),
      latest_chat_user_status: signals?.latestUserNote?.status,
      assistant_reply_after_latest_user: Boolean(signals?.assistantAfterLatestUser),
      completion_after_latest_user: Boolean(signals?.completionAfterLatestUser),
      minutes_since_meaningful_signal: minutesSince(latestMeaningfulSignalAt || latestActivityAt),
    },
    thresholds_minutes: {
      recent_signal: RECENT_SIGNAL_MINUTES,
      chat_reply_grace: CHAT_REPLY_GRACE_MINUTES,
      needs_attention: NEEDS_ATTENTION_MINUTES,
      genuinely_stuck: GENUINELY_STUCK_MINUTES,
    },
  };
}

/**
 * Evaluate health state for a single agent using durable Mission Control signals.
 *
 * Stored DB state intentionally stays within the existing CHECK constraint
 * (`working`/`stalled`/`stuck`/etc.). The richer operator-facing state lives in
 * metadata/display_state so the UI can say “working silently” instead of raising
 * a false “stalled” alarm after five quiet minutes.
 */
export function evaluateAgentHealth(agentId: string): AgentHealthEvaluation {
  const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (!agent || agent.status === 'offline') {
    return buildEvaluation(
      agentId,
      'offline',
      'offline',
      'Offline',
      'danger',
      'Agent is not available in Mission Control.',
      0.95
    );
  }

  const activeTask = getActiveTaskForAgent(agentId);
  if (!activeTask) {
    return buildEvaluation(
      agentId,
      'idle',
      'idle',
      'Idle',
      'info',
      'No active task is assigned to this agent.',
      0.95
    );
  }

  const signals = getSignals(activeTask, agentId);

  if (!signals.activeSession) {
    return buildEvaluation(
      agentId,
      'zombie',
      'no_heartbeat',
      'No active session',
      'danger',
      'The task is active, but Mission Control has no active runtime session recorded for the assigned agent.',
      0.9,
      activeTask,
      signals,
      true
    );
  }

  if (signals.latestUserNote && !signals.assistantAfterLatestUser) {
    if (signals.latestUserNote.status === 'pending') {
      return buildEvaluation(
        agentId,
        'working',
        'waiting_for_delivery',
        'Chat queued',
        'warning',
        'The latest operator chat message is still pending and has not been delivered to the active agent session.',
        0.9,
        activeTask,
        signals
      );
    }

    if (signals.completionAfterLatestUser) {
      return buildEvaluation(
        agentId,
        'working',
        'completed_not_surfaced',
        'Completed, chat not surfaced',
        'warning',
        'The agent produced a completion or handoff after the operator question, but no assistant chat note was captured after that question.',
        0.95,
        activeTask,
        signals
      );
    }

    const latestUserAge = minutesSince(signals.latestUserNote.created_at) ?? 0;
    if (latestUserAge > CHAT_REPLY_GRACE_MINUTES) {
      return buildEvaluation(
        agentId,
        'stalled',
        'needs_attention',
        'Chat reply overdue',
        'warning',
        `The latest operator chat message was delivered ${Math.round(latestUserAge)} minutes ago, but no assistant reply or completion signal has been captured.`,
        0.85,
        activeTask,
        signals,
        true
      );
    }

    return buildEvaluation(
      agentId,
      'working',
      'awaiting_reply',
      'Awaiting chat reply',
      'info',
      'The latest operator chat message was delivered to the active agent session and Mission Control is waiting for a reply.',
      0.85,
      activeTask,
      signals
    );
  }

  if (isBlockedLike(signals.latestActivity)) {
    return buildEvaluation(
      agentId,
      'stalled',
      'blocked',
      'Blocked',
      'danger',
      'The most recent task activity looks blocked or failed and needs operator attention.',
      0.85,
      activeTask,
      signals,
      true
    );
  }

  const signalAge = minutesSince(signals.latestMeaningfulSignalAt || signals.latestActivity?.created_at || activeTask.updated_at) ?? 0;

  if (signalAge <= RECENT_SIGNAL_MINUTES) {
    return buildEvaluation(
      agentId,
      'working',
      'active_recently',
      'Active recently',
      'success',
      'Mission Control recorded recent activity, a deliverable, checkpoint, status update, or session signal.',
      0.9,
      activeTask,
      signals
    );
  }

  if (signalAge <= NEEDS_ATTENTION_MINUTES) {
    return buildEvaluation(
      agentId,
      'working',
      'working_silently',
      'Working silently',
      'info',
      `The agent has an active session, but no Mission Control progress signal has been recorded for ${Math.round(signalAge)} minutes. This is normal for long autonomous builds.`,
      0.8,
      activeTask,
      signals
    );
  }

  if (signalAge <= GENUINELY_STUCK_MINUTES) {
    return buildEvaluation(
      agentId,
      'stalled',
      'needs_attention',
      'Needs attention',
      'warning',
      `The agent still has an active session, but Mission Control has not seen a meaningful progress signal for ${Math.round(signalAge)} minutes.`,
      0.75,
      activeTask,
      signals,
      true
    );
  }

  return buildEvaluation(
    agentId,
    'stuck',
    'genuinely_stuck',
    'Genuinely stuck',
    'danger',
    `The agent has an active session, but Mission Control has not seen a meaningful progress signal for ${Math.round(signalAge)} minutes.`,
    0.8,
    activeTask,
    signals,
    true
  );
}

/**
 * Check health state for a single agent.
 */
export function checkAgentHealth(agentId: string): AgentHealthState {
  return evaluateAgentHealth(agentId).health_state;
}

function serializeEvaluation(evaluation: AgentHealthEvaluation): string {
  return JSON.stringify({
    display_state: evaluation.display_state,
    display_label: evaluation.display_label,
    severity: evaluation.severity,
    reason: evaluation.reason,
    confidence: evaluation.confidence,
    signals: evaluation.signals,
    thresholds_minutes: evaluation.thresholds_minutes,
  });
}

function enrichHealthRecord(record: AgentHealth): AgentHealth {
  const metadata = parseMetadata(record.metadata);
  return {
    ...record,
    metadata,
    display_state: typeof metadata?.display_state === 'string' ? metadata.display_state as SemanticAgentHealthState : undefined,
    display_label: typeof metadata?.display_label === 'string' ? metadata.display_label : undefined,
    reason: typeof metadata?.reason === 'string' ? metadata.reason : undefined,
    severity: metadata?.severity === 'success' || metadata?.severity === 'warning' || metadata?.severity === 'danger' || metadata?.severity === 'info'
      ? metadata.severity
      : undefined,
  };
}

/**
 * Run a full health check cycle across all agents with active tasks.
 */
export async function runHealthCheckCycle(): Promise<AgentHealth[]> {
  const activeAgents = queryAll<{ id: string }>(
    `SELECT DISTINCT assigned_agent_id as id FROM tasks WHERE status IN (${ACTIVE_TASK_STATUSES.map(() => '?').join(',')}) AND assigned_agent_id IS NOT NULL`,
    [...ACTIVE_TASK_STATUSES]
  );

  // Also check agents that are in 'working' status but may have no tasks
  const workingAgents = queryAll<{ id: string }>(
    `SELECT id FROM agents WHERE status = 'working'`
  );

  const allAgentIds = Array.from(new Set([...activeAgents.map(a => a.id), ...workingAgents.map(a => a.id)]));
  const results: AgentHealth[] = [];
  const now = new Date().toISOString();

  for (const agentId of allAgentIds) {
    const evaluation = evaluateAgentHealth(agentId);
    const healthState = evaluation.health_state;
    const activeTask = evaluation.task_id ? queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [evaluation.task_id]) : undefined;
    const metadata = serializeEvaluation(evaluation);

    // Upsert health record
    const existing = queryOne<AgentHealth>(
      'SELECT * FROM agent_health WHERE agent_id = ?',
      [agentId]
    );

    const previousState = existing?.health_state as StoredAgentHealthState | undefined;
    const previousMetadata = parseMetadata(existing?.metadata);
    const previousDisplayState = previousMetadata?.display_state;

    const consecutiveStalls = evaluation.consecutive_stall_eligible
      ? (existing?.consecutive_stall_checks || 0) + 1
      : 0;

    if (existing) {
      run(
        `UPDATE agent_health SET health_state = ?, task_id = ?, last_activity_at = ?, consecutive_stall_checks = ?, metadata = ?, updated_at = ?
         WHERE agent_id = ?`,
        [healthState, activeTask?.id || null, evaluation.last_activity_at || now, consecutiveStalls, metadata, now, agentId]
      );
    } else {
      const healthId = uuidv4();
      run(
        `INSERT INTO agent_health (id, agent_id, task_id, health_state, last_activity_at, consecutive_stall_checks, metadata, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [healthId, agentId, activeTask?.id || null, healthState, evaluation.last_activity_at || now, consecutiveStalls, metadata, now]
      );
    }

    // Broadcast if health state or operator-facing display state changed
    const changed = previousState !== healthState || previousDisplayState !== evaluation.display_state;
    if (changed) {
      const healthRecord = queryOne<AgentHealth>('SELECT * FROM agent_health WHERE agent_id = ?', [agentId]);
      if (healthRecord) {
        broadcast({ type: 'agent_health_changed', payload: enrichHealthRecord(healthRecord) });
      }
    }

    // Log degraded states once per transition instead of spamming every cycle.
    if (activeTask && evaluation.severity !== 'info' && evaluation.severity !== 'success' && changed) {
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, 'status_changed', ?, ?, ?)`,
        [uuidv4(), activeTask.id, agentId, `Agent health: ${evaluation.display_label} — ${evaluation.reason}`, metadata, now]
      );
    }

    const updatedHealth = queryOne<AgentHealth>('SELECT * FROM agent_health WHERE agent_id = ?', [agentId]);
    if (updatedHealth) {
      results.push(enrichHealthRecord(updatedHealth));
      if (
        evaluation.display_state === 'genuinely_stuck' &&
        consecutiveStalls >= AUTO_NUDGE_AFTER_STALLS &&
        healthState === 'stuck'
      ) {
        // Auto-nudge is fire-and-forget and only runs after the richer model says
        // the agent is genuinely stuck, not merely working silently.
        nudgeAgent(agentId).catch(err =>
          console.error(`[Health] Auto-nudge failed for agent ${agentId}:`, err)
        );
      }
    }
  }

  // ---- PLATFORM-007: orphaned task sweep (backoff + circuit-breaker state lives at module scope) ----
  // Previous behaviour: dispatch every health cycle (every ~120s) with no limit —
  // caused 319× no-op dispatches over ~1.5h.  Now: per-task attempt tracking with
  // exponential backoff + hard circuit-breaker after MAX_ORPHAN_DISPATCH_ATTEMPTS.
  const ASSIGNED_STALE_MINUTES = 2;
  const orphanedTasks = queryAll<Task>(
    `SELECT * FROM tasks 
     WHERE status = 'assigned' 
       AND planning_complete = 1 
       AND (julianday('now') - julianday(updated_at)) * 1440 > ?`,
    [ASSIGNED_STALE_MINUTES]
  );

  for (const task of orphanedTasks) {
    const state = orphanDispatchState.get(task.id) || { attempts: 0, lastAttemptMs: 0 };

    // Circuit-breaker: stop trying after N failures
    if (state.attempts >= MAX_ORPHAN_DISPATCH_ATTEMPTS) {
      // Log the breaker trip only once
      if (state.attempts === MAX_ORPHAN_DISPATCH_ATTEMPTS) {
        const alertMsg = `Orphan dispatch circuit-breaker tripped for task "${task.title}" (${task.id}) after ${MAX_ORPHAN_DISPATCH_ATTEMPTS} failed attempts — needs human intervention.`;
        console.error(`[Health] ${alertMsg}`);
        run(
          `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
           VALUES (?, ?, ?, 'status_changed', ?, ?)`,
          [uuidv4(), task.id, task.assigned_agent_id, alertMsg, now]
        );
        // Bump attempts so we don't log again
        orphanDispatchState.set(task.id, { ...state, attempts: state.attempts + 1 });
      }
      continue;
    }

    // Exponential backoff: 2min base × 2^attempt
    const backoffMs = ORPHAN_BACKOFF_BASE_MS * Math.pow(2, state.attempts);
    if (state.lastAttemptMs > 0 && Date.now() - state.lastAttemptMs < backoffMs) {
      const remainingSec = Math.round((backoffMs - (Date.now() - state.lastAttemptMs)) / 1000);
      console.log(`[Health] Orphan task "${task.title}" backoff: attempt ${state.attempts + 1}/${MAX_ORPHAN_DISPATCH_ATTEMPTS}, next retry in ~${remainingSec}s`);
      continue;
    }

    console.log(`[Health] Orphaned assigned task detected: "${task.title}" (${task.id}) — attempt ${state.attempts + 1}/${MAX_ORPHAN_DISPATCH_ATTEMPTS}, auto-dispatching`);

    const missionControlUrl = getMissionControlUrl();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.MC_API_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
    }

    try {
      const res = await fetch(`${missionControlUrl}/api/tasks/${task.id}/dispatch`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        console.log(`[Health] Auto-dispatched orphaned task "${task.title}"`);
        run(
          `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
           VALUES (?, ?, ?, 'status_changed', 'Auto-dispatched by health sweeper (was stuck in assigned)', ?)`,
          [uuidv4(), task.id, task.assigned_agent_id, now]
        );
        // Reset on success
        orphanDispatchState.delete(task.id);
      } else {
        const errorText = await res.text();
        console.error(`[Health] Failed to auto-dispatch orphaned task "${task.title}": ${errorText}`);
        // Track failure for backoff
        orphanDispatchState.set(task.id, { attempts: state.attempts + 1, lastAttemptMs: Date.now() });
        run(
          `UPDATE tasks SET planning_dispatch_error = ?, updated_at = ? WHERE id = ?`,
          [`Health sweeper dispatch failed (attempt ${state.attempts + 1}/${MAX_ORPHAN_DISPATCH_ATTEMPTS}): ${errorText.substring(0, 180)}`, now, task.id]
        );
      }
    } catch (err) {
      console.error(`[Health] Auto-dispatch error for orphaned task "${task.title}":`, (err as Error).message);
      orphanDispatchState.set(task.id, { attempts: state.attempts + 1, lastAttemptMs: Date.now() });
    }
  }

  // Also set idle agents
  const idleAgents = queryAll<{ id: string }>(
    `SELECT id FROM agents WHERE status = 'standby' AND id NOT IN (SELECT assigned_agent_id FROM tasks WHERE status IN (${ACTIVE_TASK_STATUSES.map(() => '?').join(',')}) AND assigned_agent_id IS NOT NULL)`,
    [...ACTIVE_TASK_STATUSES]
  );
  for (const { id: agentId } of idleAgents) {
    const existing = queryOne<{ id: string }>('SELECT id FROM agent_health WHERE agent_id = ?', [agentId]);
    const metadata = JSON.stringify({
      display_state: 'idle',
      display_label: 'Idle',
      severity: 'info',
      reason: 'No active task is assigned to this agent.',
      confidence: 0.95,
    });
    if (existing) {
      run(
        `UPDATE agent_health SET health_state = 'idle', task_id = NULL, consecutive_stall_checks = 0, metadata = ?, updated_at = ? WHERE agent_id = ?`,
        [metadata, now, agentId]
      );
    } else {
      run(
        `INSERT INTO agent_health (id, agent_id, health_state, metadata, updated_at) VALUES (?, ?, 'idle', ?, ?)`,
        [uuidv4(), agentId, metadata, now]
      );
    }
  }

  return results;
}

/**
 * Nudge a stuck agent: re-dispatch its task with the latest checkpoint context.
 */
export async function nudgeAgent(agentId: string): Promise<{ success: boolean; error?: string }> {
  const activeTask = getActiveTaskForAgent(agentId);

  if (!activeTask) {
    return { success: false, error: 'No active task for this agent' };
  }

  const now = new Date().toISOString();
  const missionControlUrl = getMissionControlUrl();
  const activeSessionsBefore = getActiveRuntimeSessions(agentId, activeTask.id);

  console.warn('[Health][Nudge] Starting auto-nudge', JSON.stringify({
    agentId,
    taskId: activeTask.id,
    taskStatus: activeTask.status,
    missionControlUrl,
    hasApiToken: Boolean(process.env.MC_API_TOKEN),
    activeSessionCountBefore: activeSessionsBefore.length,
    activeSessionIdsBefore: activeSessionsBefore.map(formatSessionId),
  }));

  const recoveryStatus = activeTask.status === 'in_progress' ? 'assigned' : activeTask.status;

  // End only this task's current session before replacing it.
  const openClawEndResult = run(
    `UPDATE openclaw_sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE agent_id = ? AND task_id = ? AND status = 'active'`,
    [now, now, agentId, activeTask.id]
  );
  const cancelledCodexRuns = cancelCodexRunsForTask(activeTask.id, agentId);
  console.warn('[Health][Nudge] Ended active sessions before re-dispatch', JSON.stringify({
    agentId,
    taskId: activeTask.id,
    endedSessionCount: openClawEndResult.changes + cancelledCodexRuns,
    endedOpenClawSessionCount: openClawEndResult.changes,
    cancelledCodexRunCount: cancelledCodexRuns,
    recoveryStatus,
  }));

  // Build checkpoint context
  const checkpointCtx = buildCheckpointContext(activeTask.id);

  // Append checkpoint to task description if available
  if (checkpointCtx) {
    const newDesc = (activeTask.description || '') + checkpointCtx;
    run(
      `UPDATE tasks SET description = ?, status = ?, planning_dispatch_error = NULL, updated_at = ? WHERE id = ?`,
      [newDesc, recoveryStatus, now, activeTask.id]
    );
  } else {
    run(
      `UPDATE tasks SET status = ?, planning_dispatch_error = NULL, updated_at = ? WHERE id = ?`,
      [recoveryStatus, now, activeTask.id]
    );
  }

  // Re-dispatch via API
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.MC_API_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
  }

  try {
    let lastError = 'Dispatch did not create an active session.';

    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await fetch(`${missionControlUrl}/api/tasks/${activeTask.id}/dispatch`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      const responseText = await res.text();

      console.warn('[Health][Nudge] Dispatch response received', JSON.stringify({
        agentId,
        taskId: activeTask.id,
        attempt,
        ok: res.ok,
        status: res.status,
        responseSnippet: responseText.slice(0, 500),
      }));

      const postDispatchTask = queryOne<NudgeTaskState>(
        `SELECT status, planning_dispatch_error, status_reason, updated_at
         FROM tasks
         WHERE id = ?`,
        [activeTask.id]
      );
      const activeSessionsAfter = getActiveRuntimeSessions(agentId, activeTask.id);

      console.warn('[Health][Nudge] Post-dispatch state', JSON.stringify({
        agentId,
        taskId: activeTask.id,
        attempt,
        taskStatus: postDispatchTask?.status,
        taskUpdatedAt: postDispatchTask?.updated_at,
        planningDispatchError: postDispatchTask?.planning_dispatch_error || null,
        statusReason: postDispatchTask?.status_reason || null,
        activeSessionCountAfter: activeSessionsAfter.length,
        activeSessionIdsAfter: activeSessionsAfter.map(formatSessionId),
      }));

      if (res.ok && activeSessionsAfter.length > 0) {
        run(
          `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
           VALUES (?, ?, ?, 'status_changed', 'Agent nudged — re-dispatching with checkpoint context', ?)`,
          [uuidv4(), activeTask.id, agentId, now]
        );

        run(
          `UPDATE agent_health SET consecutive_stall_checks = 0, health_state = 'working', updated_at = ? WHERE agent_id = ?`,
          [now, agentId]
        );

        return { success: true };
      }

      lastError = res.ok
        ? 'Dispatch returned success but no active replacement session was recorded.'
        : `Dispatch failed (${res.status}): ${responseText}`;

      if (attempt < 2) {
        console.warn('[Health][Nudge] Retrying recovery dispatch', JSON.stringify({
          agentId,
          taskId: activeTask.id,
          lastError,
        }));
      }
    }

    run(
      `UPDATE tasks SET planning_dispatch_error = ?, status_reason = ?, updated_at = ? WHERE id = ?`,
      [`Auto-nudge failed: ${lastError}`, `Auto-recovery failed: ${lastError}`, new Date().toISOString(), activeTask.id]
    );
    return { success: false, error: lastError };
  } catch (err) {
    console.error('[Health][Nudge] Auto-nudge dispatch threw', JSON.stringify({
      agentId,
      taskId: activeTask.id,
      error: (err as Error).message,
    }));
    run(
      `UPDATE tasks SET planning_dispatch_error = ?, status_reason = ?, updated_at = ? WHERE id = ?`,
      [`Auto-nudge threw: ${(err as Error).message}`, `Auto-recovery failed: ${(err as Error).message}`, new Date().toISOString(), activeTask.id]
    );
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Get health state for all agents.
 */
export function getAllAgentHealth(): AgentHealth[] {
  return queryAll<AgentHealth>('SELECT * FROM agent_health ORDER BY updated_at DESC').map(enrichHealthRecord);
}

/**
 * Get health state for a single agent.
 */
export function getAgentHealth(agentId: string): AgentHealth | null {
  const record = queryOne<AgentHealth>('SELECT * FROM agent_health WHERE agent_id = ?', [agentId]);
  return record ? enrichHealthRecord(record) : null;
}

export const __agentHealthTestUtils = {
  parseTimestampMs,
  normalizeTimestamp,
};
