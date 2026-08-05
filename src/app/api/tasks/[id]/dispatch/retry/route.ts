import { NextResponse } from 'next/server';
import { queryAll, queryOne, run } from '@/lib/db';
import { dispatchTaskFromServer } from '@/lib/server-dispatch';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

type ActiveRuntimeSession = {
  runtime: 'openclaw' | 'codex';
  session_id: string;
  status: string;
  created_at: string;
};

type DispatchRetryClassification = {
  code: 'needs_agent' | 'needs_runtime_setup' | 'repo_access' | 'no_session_recorded' | 'not_allowed' | 'dispatch_failed';
  retryable: boolean;
  userMessage: string;
};

function getActiveRuntimeSessions(taskId: string, agentId: string): ActiveRuntimeSession[] {
  return queryAll<ActiveRuntimeSession>(
    `SELECT 'openclaw' AS runtime, openclaw_session_id AS session_id, status, created_at
     FROM openclaw_sessions
     WHERE task_id = ?
       AND agent_id = ?
       AND status = 'active'
     UNION ALL
     SELECT 'codex' AS runtime, id AS session_id, status, created_at
     FROM codex_sessions
     WHERE task_id = ?
       AND agent_id = ?
       AND status = 'running'
     ORDER BY created_at DESC`,
    [taskId, agentId, taskId, agentId]
  );
}

function classifyDispatchRetryFailure(error: string): DispatchRetryClassification {
  const normalized = error.toLowerCase();

  if (normalized.includes('no routable agent') || normalized.includes('no agent') || normalized.includes('assigned agent not found')) {
    return {
      code: 'needs_agent',
      retryable: false,
      userMessage: 'Assign an available agent before retrying dispatch.',
    };
  }

  if (normalized.includes('codex runtime is not ready') || normalized.includes('not authenticated') || normalized.includes('openclaw gateway')) {
    return {
      code: 'needs_runtime_setup',
      retryable: false,
      userMessage: 'Fix the selected runtime connection in Settings, then retry dispatch.',
    };
  }

  if (normalized.includes('git auth') || normalized.includes('repo access') || normalized.includes('repository not found') || normalized.includes('could not read from remote repository')) {
    return {
      code: 'repo_access',
      retryable: false,
      userMessage: 'Confirm repository access, then retry dispatch.',
    };
  }

  if (normalized.includes('no active replacement session') || normalized.includes('no active runtime session')) {
    return {
      code: 'no_session_recorded',
      retryable: true,
      userMessage: 'Dispatch did not leave a tracked runtime session. Retry dispatch after checking runtime health.',
    };
  }

  return {
    code: 'dispatch_failed',
    retryable: true,
    userMessage: 'Dispatch failed. Retry after reviewing the error details.',
  };
}

function recordRetryFailure(taskId: string, error: string) {
  const classification = classifyDispatchRetryFailure(error);
  const now = new Date().toISOString();

  run(
    `UPDATE tasks
     SET planning_dispatch_error = ?,
         status_reason = ?,
         updated_at = ?
     WHERE id = ?`,
    [`Retry dispatch failed: ${error}`, classification.userMessage, now, taskId]
  );

  const refreshedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (refreshedTask) {
    broadcast({ type: 'task_updated', payload: refreshedTask });
  }

  return classification;
}

/**
 * POST /api/tasks/[id]/dispatch/retry
 *
 * Retries dispatch for any blocked task that still has an assigned agent. Unlike
 * the planning retry route, this does not require planning_complete and verifies
 * that dispatch actually created a tracked runtime session.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (task.status === 'done') {
      const classification: DispatchRetryClassification = {
        code: 'not_allowed',
        retryable: false,
        userMessage: 'Completed tasks cannot be retried for dispatch.',
      };
      return NextResponse.json({ error: classification.userMessage, ...classification }, { status: 409 });
    }

    if (!task.assigned_agent_id) {
      const error = 'Task has no assigned agent';
      const classification = recordRetryFailure(taskId, error);
      return NextResponse.json({ error, ...classification }, { status: 400 });
    }

    run(
      `UPDATE tasks
       SET planning_dispatch_error = NULL,
           status_reason = NULL,
           updated_at = datetime('now')
       WHERE id = ?`,
      [taskId]
    );

    const dispatchResult = await dispatchTaskFromServer(taskId);
    if (!dispatchResult.success) {
      const error = dispatchResult.error || 'Dispatch failed';
      const classification = recordRetryFailure(taskId, error);
      return NextResponse.json({ error, ...classification }, { status: dispatchResult.status || 500 });
    }

    const activeSessions = getActiveRuntimeSessions(taskId, task.assigned_agent_id);
    if (activeSessions.length === 0) {
      const error = 'Dispatch returned success but no active runtime session was recorded.';
      const classification = recordRetryFailure(taskId, error);
      return NextResponse.json({ error, ...classification }, { status: 502 });
    }

    const refreshedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (refreshedTask) {
      broadcast({ type: 'task_updated', payload: refreshedTask });
    }

    // PLATFORM-008 (A1/A2): surface rotation + token diagnostics from the
    // dispatch endpoint so retry callers see the new session key.
    const body = dispatchResult.body || {};
    const rotated = body.rotated === true;
    const rotationReasons = Array.isArray(body.rotation_reasons) ? body.rotation_reasons : [];
    const tokenWarning = body.session_token_warning || null;

    if (rotated) {
      const rotatedAt = new Date().toISOString();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, 'session_rotated', ?, ?)`,
        [
          crypto.randomUUID(),
          taskId,
          task.assigned_agent_id,
          `Retry dispatch rotated to fresh session ${activeSessions[0].session_id}${rotationReasons.length > 0 ? ` — ${rotationReasons.join('; ')}` : ''}`,
          rotatedAt,
        ]
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Dispatch retry started',
      runtime: activeSessions[0].runtime,
      session_id: activeSessions[0].session_id,
      rotated,
      ...(rotationReasons.length > 0 ? { rotation_reasons: rotationReasons } : {}),
      ...(tokenWarning ? { session_token_warning: tokenWarning } : {}),
      task: refreshedTask,
    });
  } catch (error) {
    console.error('[Dispatch Retry] Failed to retry dispatch:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const classification = recordRetryFailure(taskId, message);

    return NextResponse.json({
      error: message,
      ...classification,
    }, { status: 500 });
  }
}
