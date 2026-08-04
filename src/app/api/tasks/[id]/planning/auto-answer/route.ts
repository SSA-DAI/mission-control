import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { extractJSON, getMessagesFromOpenClaw } from '@/lib/planning-utils';
import { mapRoleToCanonical, ensureCanonicalAgent, type CanonicalRole } from '@/lib/canonical-agents';
import { v4 as uuidv4 } from 'uuid';
import type { Task, PlanningQuestionPayload } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Configurable limits (PLATFORM-004a constraints)
const MAX_ITERATIONS = 10;
const OVERALL_TIMEOUT_MS = 60_000; // 60 seconds
const RESPONSE_POLL_INTERVAL_MS = 2_000; // 2 seconds between polls
const RESPONSE_POLL_MAX_WAIT_MS = 20_000; // max wait per individual response

/**
 * POST /api/tasks/:id/planning/auto-answer
 *
 * PLATFORM-004a: Backend loop that answers all remaining planning questions
 * using the recommended values from the planning agent, then approves and dispatches.
 *
 * Flow:
 * 1. Start planning if not started
 * 2. Loop (max 10 iterations, 60s timeout):
 *    a. Get planning state from DB + OpenClaw
 *    b. If completion detected → approve + dispatch
 *    c. If question → extract recommended answer (fallback to "A"), send answer
 *    d. Wait for response, repeat
 * 3. Fail-fast: if stall detected → set status_reason + broadcast event
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;
  const db = getDb();
  const startTime = Date.now();

  try {
    // Get task
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as (Task & { workspace_id: string }) | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Connect to OpenClaw
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    // Step 1: Start planning if not started
    if (!task.planning_session_key) {
      console.log(`[Auto-Answer] Starting planning for task ${taskId}`);
      const missionControlUrl = getMissionControlUrl();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (process.env.MC_API_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
      }

      const planningRes = await fetch(`${missionControlUrl}/api/tasks/${taskId}/planning`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      if (!planningRes.ok) {
        const errData = await planningRes.json().catch(() => ({}));
        return stallResponse(
          taskId,
          `Failed to start planning: ${errData.error || planningRes.statusText}`,
          'planning_start_failed'
        );
      }
    }

    // Re-read task to get updated planning_session_key
    let currentTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as (Task & { workspace_id: string }) | undefined;
    if (!currentTask?.planning_session_key) {
      return stallResponse(taskId, 'Planning session not created', 'no_session_key');
    }

    // Step 2: Main loop
    const iterationLog: Array<{ iteration: number; action: string; questionSnippet?: string; recommended?: string }> = [];
    let answered = 0;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      // Check overall timeout
      if (Date.now() - startTime > OVERALL_TIMEOUT_MS) {
        return stallResponse(taskId, `Auto-answer timed out after ${MAX_ITERATIONS} iterations`, 'timeout', iterationLog);
      }

      // Re-read task for latest state
      currentTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as (Task & { workspace_id: string }) | undefined;

      if (!currentTask) {
        return stallResponse(taskId, 'Task disappeared during auto-answer', 'task_gone', iterationLog);
      }

      // Check if already complete
      if (currentTask.planning_complete) {
        console.log(`[Auto-Answer] Planning already complete for task ${taskId}, dispatching`);
        const dispatchResult = await triggerDispatch(taskId);
        return NextResponse.json({
          success: true,
          iterations: iteration,
          answered,
          alreadyComplete: true,
          dispatched: dispatchResult.success,
          dispatchError: dispatchResult.error,
          iterationLog,
        });
      }

      // Get current messages from DB
      const messages = currentTask.planning_messages ? JSON.parse(currentTask.planning_messages) : [];

      // Fetch fresh messages from OpenClaw
      const freshMessages = await getMessagesFromOpenClaw(currentTask.planning_session_key!);
      const storedAssistantCount = messages.filter((m: { role: string }) => m.role === 'assistant').length;

      // If OpenClaw has more assistant messages, sync them
      if (freshMessages.length > storedAssistantCount) {
        const newMsgs = freshMessages.slice(storedAssistantCount);
        for (const msg of newMsgs) {
          messages.push({ role: 'assistant', content: msg.content, timestamp: Date.now() });
        }
        // Save to DB
        run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(messages), taskId]);
      }

      // Find the latest assistant message
      const lastAssistantMsg = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
      if (!lastAssistantMsg) {
        // No assistant message yet — the planning agent hasn't responded to the initial prompt
        // Wait and retry
        await sleep(RESPONSE_POLL_INTERVAL_MS);
        continue;
      }

      // Parse the message
      const parsed = extractJSON(lastAssistantMsg.content) as PlanningQuestionPayload | null;

      if (!parsed) {
        // Invalid JSON from agent — stall
        console.warn(`[Auto-Answer] Iteration ${iteration}: Could not parse assistant message as JSON`);
        return stallResponse(
          taskId,
          `Planning agent response is not valid JSON (iteration ${iteration})`,
          'invalid_json',
          iterationLog
        );
      }

      // Check for completion
      if (parsed.status === 'complete') {
        console.log(`[Auto-Answer] Iteration ${iteration}: Completion detected!`);
        iterationLog.push({ iteration, action: 'complete_detected' });

        // Approve + dispatch
        const approveResult = await approveAndDispatch(taskId, parsed);
        return NextResponse.json({
          success: true,
          iterations: iteration,
          answered,
          completionDetected: true,
          dispatched: approveResult.dispatched,
          dispatchError: approveResult.dispatchError,
          spec: parsed.spec,
          agents: parsed.agents,
          iterationLog,
        });
      }

      // Check for question
      if (parsed.question && parsed.options) {
        // Extract recommended answer — fallback to first option (A)
        const recommended = parsed.recommended || 'A';
        const recommendedReason = parsed.recommended_reason || 'Fallback: first option assumed safest';

        if (!parsed.recommended) {
          console.warn(`[Auto-Answer] Iteration ${iteration}: No recommended field — falling back to option "A"`);
        }

        // Validate that recommended option exists
        const optionIds = parsed.options.map(o => o.id);
        const effectiveRecommended = optionIds.includes(recommended) ? recommended : (optionIds[0] || 'A');

        if (!optionIds.includes(recommended)) {
          console.warn(`[Auto-Answer] Iteration ${iteration}: Recommended "${recommended}" not in options, using "${effectiveRecommended}"`);
        }

        // Determine answer text
        const selectedOption = parsed.options.find(o => o.id === effectiveRecommended);
        const answerText = effectiveRecommended.toLowerCase() === 'other'
          ? (selectedOption?.label || 'Other')
          : (selectedOption?.label || effectiveRecommended);

        const questionSnippet = parsed.question.substring(0, 80);
        iterationLog.push({
          iteration,
          action: `answered_question`,
          questionSnippet,
          recommended: effectiveRecommended,
        });

        console.log(`[Auto-Answer] Iteration ${iteration}: Answering "${questionSnippet}..." with "${effectiveRecommended}"`);

        // Send the answer via OpenClaw chat.send (same approach as answer endpoint)
        const answerPayload = effectiveRecommended.toLowerCase() === 'other'
          ? `Other: ${answerText}`
          : answerText;

        const answerPrompt = `User's answer: ${answerPayload}

Based on this answer and the conversation so far, either:
1. Ask your next question (if you need more information)
2. Complete the planning (if you have enough information)

For another question, respond with JSON. Include "recommended" (option ID you suggest) and "recommended_reason" (short reason, 1 sentence max) — these are REQUIRED fields:
{
  "question": "Your next question?",
  "options": [
    {"id": "A", "label": "Option A"},
    {"id": "B", "label": "Option B"},
    {"id": "other", "label": "Other"}
  ],
  "recommended": "A",
  "recommended_reason": "This is the safest choice based on the answers so far"
}

If planning is complete, respond with JSON:
{
  "status": "complete",
  "spec": {
    "title": "Task title",
    "summary": "Summary of what needs to be done",
    "deliverables": ["List of deliverables"],
    "success_criteria": ["How we know it's done"],
    "constraints": {}
  },
  "agents": [
    {
      "name": "Agent Name",
      "role": "Agent role",
      "avatar_emoji": "🎯",
      "soul_md": "Agent personality...",
      "instructions": "Specific instructions..."
    }
  ],
  "execution_plan": {
    "approach": "How to execute",
    "steps": ["Step 1", "Step 2"]
  }
}

IMPORTANT: All JSON responses must be compact (under 6KB) and complete. For questions, "recommended" and "recommended_reason" are REQUIRED. NEVER emit truncated or invalid JSON.`;

        // Add user message to DB
        messages.push({ role: 'user', content: answerText, timestamp: Date.now() });
        run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(messages), taskId]);

        // Send to OpenClaw
        try {
          await client.call('chat.send', {
            sessionKey: currentTask.planning_session_key,
            message: answerPrompt,
            idempotencyKey: `auto-answer-${taskId}-${iteration}-${Date.now()}`,
          });
        } catch (sendError) {
          console.error(`[Auto-Answer] Iteration ${iteration}: Failed to send to OpenClaw:`, sendError);
          return stallResponse(
            taskId,
            `Failed to send answer to planning agent (iteration ${iteration}): ${(sendError as Error).message}`,
            'send_failed',
            iterationLog
          );
        }

        answered++;

        // Wait for agent response
        const responseReceived = await waitForAgentResponse(currentTask.planning_session_key!, messages.length);
        if (!responseReceived) {
          console.warn(`[Auto-Answer] Iteration ${iteration}: No response from agent within timeout`);
        }

        // Continue to next iteration
        continue;
      }

      // Question/options missing → stall
      console.warn(`[Auto-Answer] Iteration ${iteration}: Message has no question+options and no completion status`);
      return stallResponse(
        taskId,
        `Planning agent response has no question, options, or completion marker (iteration ${iteration})`,
        'invalid_response',
        iterationLog
      );
    }

    // Max iterations reached
    return stallResponse(
      taskId,
      `Auto-answer reached max iterations (${MAX_ITERATIONS}) without completing planning`,
      'max_iterations',
      iterationLog
    );
  } catch (error) {
    console.error('[Auto-Answer] Unexpected error:', error);
    return stallResponse(
      taskId,
      `Auto-answer failed: ${(error as Error).message}`,
      'unexpected_error'
    );
  }
}

/**
 * Wait for the planning agent to send a new assistant message.
 * Returns true if a new message was received, false on timeout.
 */
async function waitForAgentResponse(
  sessionKey: string,
  currentMessageCount: number
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < RESPONSE_POLL_MAX_WAIT_MS) {
    await sleep(RESPONSE_POLL_INTERVAL_MS);

    try {
      const messages = await getMessagesFromOpenClaw(sessionKey);
      if (messages.length > currentMessageCount) {
        return true;
      }
    } catch {
      // Continue polling
    }
  }

  return false;
}

/**
 * Approve the plan (create agents, save spec) and trigger dispatch.
 * Mirrors the force-complete endpoint's logic but used for auto-answer flow.
 */
async function approveAndDispatch(
  taskId: string,
  parsed: PlanningQuestionPayload
): Promise<{ dispatched: boolean; dispatchError?: string }> {
  const db = getDb();
  let firstAgentId: string | null = null;

  // Create canonical agents from spec
  if (parsed.agents && parsed.agents.length > 0) {
    const task = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(taskId) as { workspace_id: string } | undefined;
    const workspaceId = task?.workspace_id || 'default';
    const seenRoles = new Set<CanonicalRole>();

    for (const agent of parsed.agents) {
      const canonicalRole = mapRoleToCanonical((agent as any).role || (agent as any).name || '');
      if (!canonicalRole) continue;
      if (seenRoles.has(canonicalRole)) continue;
      seenRoles.add(canonicalRole);

      try {
        const canonicalId = ensureCanonicalAgent(workspaceId, canonicalRole);
        if (!firstAgentId) firstAgentId = canonicalId;
        console.log(`[Auto-Answer] Using canonical ${canonicalRole} agent ${canonicalId}`);
      } catch (err) {
        console.error(`[Auto-Answer] Failed to ensure canonical ${canonicalRole}:`, err);
      }
    }
  }

  // Mark planning complete + assign agent
  run(
    `UPDATE tasks SET
       planning_complete = 1,
       planning_spec = ?,
       planning_agents = ?,
       assigned_agent_id = ?,
       status = 'assigned',
       planning_dispatch_error = NULL,
       status_reason = 'Auto-answered by Run workflow',
       updated_at = datetime('now')
     WHERE id = ?`,
    [
      JSON.stringify(parsed.spec || {}),
      JSON.stringify(parsed.agents || []),
      firstAgentId,
      taskId,
    ]
  );

  // Log activity
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, 'status_changed', 'Planning auto-completed — dispatching', datetime('now'))`,
    [uuidv4(), taskId, firstAgentId]
  );

  // Broadcast task update
  const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }

  // Trigger dispatch
  const dispatchResult = await triggerDispatch(taskId);

  // Set dispatch error if needed
  if (dispatchResult.error) {
    run(
      `UPDATE tasks SET planning_dispatch_error = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?`,
      [dispatchResult.error, `Auto-answer dispatch failed: ${dispatchResult.error}`, taskId]
    );
    const failedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
    if (failedTask) broadcast({ type: 'task_updated', payload: failedTask });
  }

  return { dispatched: dispatchResult.success, dispatchError: dispatchResult.error };
}

/**
 * Trigger dispatch for a task via internal HTTP call.
 */
async function triggerDispatch(
  taskId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const missionControlUrl = getMissionControlUrl();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.MC_API_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
    }

    const res = await fetch(`${missionControlUrl}/api/tasks/${taskId}/dispatch`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (res.ok) {
      console.log(`[Auto-Answer] Dispatch successful for task ${taskId}`);
      return { success: true };
    } else {
      const errorText = await res.text();
      console.error(`[Auto-Answer] Dispatch failed: ${errorText}`);
      return { success: false, error: `Dispatch failed: ${errorText.substring(0, 200)}` };
    }
  } catch (err) {
    console.error(`[Auto-Answer] Dispatch error:`, err);
    return { success: false, error: `Dispatch error: ${(err as Error).message}` };
  }
}

/**
 * Handle stall state: set status_reason, broadcast event, return error response.
 */
function stallResponse(
  taskId: string,
  reason: string,
  stallCode: string,
  iterationLog?: Array<{ iteration: number; action: string; questionSnippet?: string; recommended?: string }>
): NextResponse {
  console.warn(`[Auto-Answer] STALL: ${reason} (code: ${stallCode})`);

  // Set status_reason + planning_dispatch_error
  const safeReason = reason.substring(0, 500);
  run(
    `UPDATE tasks SET
       planning_dispatch_error = ?,
       status_reason = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
    [`Auto-answer stalled: ${safeReason}`, `PLANNING_STALLED (${stallCode}): ${safeReason}`, taskId]
  );

  // Broadcast 'planning_stalled' event
  try {
    broadcast({
      type: 'task_updated' as any, // Use task_updated since planning_stalled isn't in SSEEventType
      payload: {
        id: taskId,
        planning_dispatch_error: `Auto-answer stalled: ${safeReason}`,
        status_reason: `PLANNING_STALLED (${stallCode}): ${safeReason}`,
      } as any,
    });
  } catch (err) {
    console.error('[Auto-Answer] Failed to broadcast stall event:', err);
  }

  // Log activity
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (?, ?, 'status_changed', ?, datetime('now'))`,
    [uuidv4(), taskId, `Auto-answer stalled (${stallCode}): ${safeReason}`]
  );

  return NextResponse.json(
    {
      success: false,
      stall_code: stallCode,
      reason: safeReason,
      stall: true,
      userMessage: '⚠️ Auto-answer stalled — menunggu keputusan manusia. Lihat banner di kartu task.',
      iterationLog,
      nextAction: 'Lanjutkan Manual',
    },
    { status: 200 } // Use 200 so frontend can display the stall info cleanly
  );
}

/** Simple sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
