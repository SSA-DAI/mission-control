import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { getMissionControlUrl } from '@/lib/config';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/tasks/:id/run
 *
 * PLATFORM-004a: "Run" wrapper — one-click entry point from inbox.
 * Delegates to POST /planning to start an interactive Q&A session.
 * Only valid for tasks with status 'inbox'.
 *
 * Returns planning state info so the frontend can open the Q&A dialog.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Only allow Run for inbox tasks (or tasks without active planning)
    if (task.status !== 'inbox') {
      if (task.status === 'planning') {
        // Already planning — return current state so frontend can open the dialog
        return NextResponse.json({
          success: true,
          alreadyPlanning: true,
          sessionKey: task.planning_session_key,
          message: 'Planning already in progress — opening existing session',
        });
      }
      return NextResponse.json(
        { error: `Run is only available for inbox tasks (current status: ${task.status})` },
        { status: 400 }
      );
    }

    // Delegate to the planning endpoint via internal POST
    const missionControlUrl = getMissionControlUrl();
    const planningUrl = `${missionControlUrl}/api/tasks/${taskId}/planning`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.MC_API_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
    }

    const planningRes = await fetch(planningUrl, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    const planningData = await planningRes.json().catch(() => ({}));

    if (!planningRes.ok) {
      // Planning endpoint returns errors for various reasons (already started, other orchestrators, etc.)
      return NextResponse.json(
        {
          error: planningData.error || 'Failed to start planning',
          ...planningData,
        },
        { status: planningRes.status }
      );
    }

    // Success — planning started
    return NextResponse.json({
      success: true,
      sessionKey: planningData.sessionKey,
      messages: planningData.messages || [],
      note: 'Planning started. Q&A dialog will open for interactive planning.',
    });
  } catch (error) {
    console.error('[Run] Failed to start task:', error);
    return NextResponse.json(
      { error: 'Failed to start task: ' + (error as Error).message },
      { status: 500 }
    );
  }
}
