import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { extractJSON } from '@/lib/planning-utils';
import { startPlanningSession, buildPlanningPrompt, clearRequestGuard } from '@/lib/planning-watchdog';
// File system imports removed - using OpenClaw API instead

export const dynamic = 'force-dynamic';

// Default planning session prefix for OpenClaw
// Can be overridden per-agent via the session_key_prefix column on agents table
// PLATFORM-001: never fall back to a session prefix with no gateway agent.
// 'agent:main:' is the canonical orchestrator prefix (PLATFORM-006: main = manager).
// 'agent:manager:' remains a valid canonical alias in agent-prefix.ts.
const DEFAULT_SESSION_KEY_PREFIX = 'agent:main:';

// GET /api/tasks/[id]/planning - Get planning state
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      status: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_spec?: string;
      planning_agents?: string;
      auto_restart_count?: number;
      planning_updated_at?: string;
    } | undefined;
    
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Parse planning messages from JSON
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];

    // Find the latest question (last assistant message with question structure)
    const lastAssistantMessage = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
    let currentQuestion = null;

    if (lastAssistantMessage) {
      // Use extractJSON to handle code blocks and surrounding text
      const parsed = extractJSON(lastAssistantMessage.content) as Record<string, unknown> | null;
      if (parsed && parsed.question) {
        currentQuestion = {
          question: parsed.question,
          options: parsed.options,
          recommended: parsed.recommended,
          recommended_reason: parsed.recommended_reason,
        };
      }
    }

    return NextResponse.json({
      taskId,
      sessionKey: task.planning_session_key,
      messages,
      currentQuestion,
      isComplete: !!task.planning_complete,
      spec: task.planning_spec ? JSON.parse(task.planning_spec) : null,
      agents: task.planning_agents ? JSON.parse(task.planning_agents) : null,
      isStarted: messages.length > 0,
      // PLATFORM-014: watchdog visibility for the UI banner
      status: task.status,
      autoRestartCount: task.auto_restart_count ?? 0,
      planningUpdatedAt: task.planning_updated_at ?? null,
      awaitingHumanDecision: task.status === 'menunggu_keputusan_manusia',
    });
  } catch (error) {
    console.error('Failed to get planning state:', error);
    return NextResponse.json({ error: 'Failed to get planning state' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/planning - Start planning session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const customSessionKeyPrefix = body.session_key_prefix;

    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      status: string;
      workspace_id: string;
      planning_session_key?: string;
      planning_messages?: string;
      auto_restart_count?: number;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // PLATFORM-014: a task awaiting a human decision cannot silently start a new
    // session through the normal path — cancel first (POST /planning/cancel).
    if (task.status === 'menunggu_keputusan_manusia') {
      return NextResponse.json({
        error: 'Task is awaiting a human decision after repeated planning stalls',
        awaitingHumanDecision: true,
        message: 'Cancel planning (POST /planning/cancel) to reset, then start planning again.',
      }, { status: 409 });
    }

    // Check if planning already started
    if (task.planning_session_key) {
      return NextResponse.json({ error: 'Planning already started', sessionKey: task.planning_session_key }, { status: 400 });
    }

    // Check if there are other orchestrators available before starting planning with the default master agent
    // Get the default master agent for this workspace
    const defaultMaster = queryOne<{ id: string; session_key_prefix?: string }>(
      `SELECT id, session_key_prefix FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
      [task.workspace_id]
    );

    // Get assigned agent if any (for session_key_prefix)
    const taskWithAgent = getDb().prepare(`
      SELECT a.session_key_prefix 
      FROM tasks t 
      LEFT JOIN agents a ON t.assigned_agent_id = a.id 
      WHERE t.id = ?
    `).get(taskId) as { session_key_prefix?: string } | undefined;

    const otherOrchestrators = queryAll<{
      id: string;
      name: string;
      role: string;
    }>(
      `SELECT id, name, role
       FROM agents
       WHERE is_master = 1
       AND id != ?
       AND workspace_id = ?
       AND status != 'offline'`,
      [defaultMaster?.id ?? '', task.workspace_id]
    );

    if (otherOrchestrators.length > 0) {
      return NextResponse.json({
        error: 'Other orchestrators available',
        message: `There ${otherOrchestrators.length === 1 ? 'is' : 'are'} ${otherOrchestrators.length} other orchestrator${otherOrchestrators.length === 1 ? '' : 's'} available in this workspace: ${otherOrchestrators.map(o => o.name).join(', ')}. Please assign this task to them directly.`,
        otherOrchestrators,
      }, { status: 409 }); // 409 Conflict
    }

    // Create session key for this planning task
    // Priority: custom prefix > assigned agent's prefix > master agent's prefix > default prefix
    const basePrefix = customSessionKeyPrefix || taskWithAgent?.session_key_prefix || defaultMaster?.session_key_prefix || DEFAULT_SESSION_KEY_PREFIX;

    // PLATFORM-014: shared session bootstrap (prompt + OpenClaw send + DB write)
    // with the same behavior as the original inline implementation.
    const started = await startPlanningSession(taskId, { prefix: basePrefix });
    if (!started.ok) {
      return NextResponse.json({ error: 'Failed to start planning: ' + started.error }, { status: 500 });
    }
    const sessionKey = started.sessionKey!;
    const planningPrompt = buildPlanningPrompt(task);
    const messages = [{ role: 'user', content: planningPrompt, timestamp: Date.now() }];

    // Return immediately - frontend will poll for updates
    // This eliminates the aggressive polling loop that was making 30+ OpenClaw API calls
    return NextResponse.json({
      success: true,
      sessionKey,
      messages,
      note: 'Planning started. Poll GET endpoint for updates.',
    });
  } catch (error) {
    console.error('Failed to start planning:', error);
    return NextResponse.json({ error: 'Failed to start planning: ' + (error as Error).message }, { status: 500 });
  }
}

// DELETE /api/tasks/[id]/planning - Cancel planning session
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    // Get task to check session key
    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      status: string;
    }>(
      'SELECT * FROM tasks WHERE id = ?',
      [taskId]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Clear planning-related fields (hard reset — use POST /planning/cancel for
    // the state-preserving safe cancel, PLATFORM-014).
    run(`
      UPDATE tasks
      SET planning_session_key = NULL,
          planning_messages = NULL,
          planning_complete = 0,
          planning_spec = NULL,
          planning_agents = NULL,
          planning_dispatch_error = NULL,
          auto_restart_count = 0,
          answered_question_indices = NULL,
          planning_updated_at = datetime('now'),
          status = 'inbox',
          status_reason = 'Planning cancelled (hard reset)',
          updated_at = datetime('now')
      WHERE id = ?
    `, [taskId]);

    clearRequestGuard(taskId);

    // Broadcast task update
    const updatedTask = queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) {
      broadcast({
        type: 'task_updated',
        payload: updatedTask as any, // Cast to any to satisfy SSEEvent payload union type
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to cancel planning:', error);
    return NextResponse.json({ error: 'Failed to cancel planning: ' + (error as Error).message }, { status: 500 });
  }
}
