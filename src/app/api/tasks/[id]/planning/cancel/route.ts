import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { cancelPlanningSession, clearRequestGuard, logPlanningActivity } from '@/lib/planning-watchdog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/tasks/[id]/planning/cancel
 *
 * PLATFORM-014 — SAFE planning cancel.
 *
 * Unlike DELETE /api/tasks/[id]/planning (which hard-resets everything), this
 * endpoint PRESERVES the planning state:
 *   - planning_messages / planning_spec / planning_agents stay intact and are
 *     additionally archived into planning_history
 *   - planning_session_key is cleared so a fresh session can start
 *   - planning_complete is reset to 0, planning_dispatch_error cleared
 *   - auto_restart_count resets to 0 (human intervention = fresh budget)
 *   - status returns to 'inbox'
 *
 * Body (optional): { "reason": "why this was cancelled" }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const existing = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [taskId]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const reason = (body?.reason as string)?.trim() || 'Planning cancelled manually';

    const result = cancelPlanningSession(taskId, reason);

    clearRequestGuard(taskId);

    logPlanningActivity(
      taskId,
      'planning_cancelled',
      `Planning cancelled manually — state preserved (session ${result.action === 'cancelled' ? 'archived' : 'none'})`,
      { reason }
    );

    return NextResponse.json({
      success: true,
      action: result.action,
      task: result.task,
      message: result.action === 'cancelled'
        ? 'Planning cancelled — messages/spec preserved, task returned to inbox'
        : 'No active planning session to cancel — task returned to inbox',
    });
  } catch (error) {
    console.error('Failed to cancel planning:', error);
    return NextResponse.json({ error: 'Failed to cancel planning: ' + (error as Error).message }, { status: 500 });
  }
}
