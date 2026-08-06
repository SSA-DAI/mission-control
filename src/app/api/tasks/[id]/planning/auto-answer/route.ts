import { NextRequest, NextResponse } from 'next/server';
import { getDb, queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { extractJSON, getMessagesFromOpenClaw } from '@/lib/planning-utils';
import { resolvePlanningAgent, type CanonicalRole } from '@/lib/canonical-agents';
import { populateTaskRolesFromAgents } from '@/lib/workflow-engine';
import { markPlanningAgents } from '@/lib/agent-cleanup';
import {
  appendAnswerWithGuard,
  lastAssistantMessageIndex,
  markAnswerDelivered,
} from '@/lib/planning-answer-idempotency';
import {
  runAutoAnswerLoop,
  getAutoAnswerTimeoutMs,
  MAX_AUTO_ANSWER_ITERATIONS,
  type AutoAnswerProgressEntry,
} from '@/lib/auto-answer-loop';
import { v4 as uuidv4 } from 'uuid';
import type { Task, PlanningQuestionPayload, PlanningAgentSpec } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Configurable limits (PLATFORM-004a constraints)
// PLATFORM-020: primary stall gate is now a wall-clock time budget
// (AUTO_ANSWER_TIMEOUT_MS, default 10 min) — iteration counts do not reflect
// real elapsed time and caused false stalls (PLATFORM-009). max_iterations
// remains as a SECONDARY hard ceiling (50) to catch infinite loops.
const MAX_ITERATIONS = MAX_AUTO_ANSWER_ITERATIONS; // 50 — hard ceiling (safety net)
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
 * 2. Loop (PLATFORM-020: time budget AUTO_ANSWER_TIMEOUT_MS default 10 menit
 *    as PRIMARY gate, max 50 iterasi as hard ceiling):
 *    a. Get planning state from DB + OpenClaw
 *    b. If completion detected → approve + dispatch
 *    c. If question → extract recommended answer (fallback to "A"), send answer
 *    d. Wait for response, repeat
 * 3. Fail-fast: if stall detected → set status_reason + broadcast event.
 *    Stall reasons are now time-based (time_budget_exhausted) with a clear
 *    message listing the remaining question + manual next step.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;
  const db = getDb();

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

    // Step 2: Main loop — PLATFORM-020: run inside the time-budget engine.
    // PRIMARY stall gate = wall-clock budget (AUTO_ANSWER_TIMEOUT_MS, default
    // 10 menit); max_iterations (50) = SECONDARY hard ceiling. Every iteration
    // emits a progress entry (iteration, action, question, elapsed ms).
    const iterationLog: AutoAnswerProgressEntry[] = [];
    let answered = 0;
    // PLATFORM-016: the P010 BUG-1 in-memory guard (lastAnsweredQuestionIdx +
    // evaluatePendingQuestion) is REPLACED by the DB-persistent unified guard
    // (appendAnswerWithGuard). Duplicate prevention now survives driver
    // restarts and also covers the manual POST /planning/answer path.

    const timeoutMs = getAutoAnswerTimeoutMs();
    const outcome = await runAutoAnswerLoop({
      timeoutMs,
      maxIterations: MAX_ITERATIONS,
      iterate: async ({ iteration }) => {
        // Re-read task for latest state
        currentTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as (Task & { workspace_id: string }) | undefined;

        if (!currentTask) {
          return { kind: 'stall', code: 'task_gone', reason: 'Task disappeared during auto-answer' };
        }

        // Check if already complete
        if (currentTask.planning_complete) {
          console.log(`[Auto-Answer] Iteration ${iteration}: Planning already complete for task ${taskId}, dispatching`);
          const dispatchResult = await triggerDispatch(taskId);
          return {
            kind: 'complete',
            payload: NextResponse.json({
              success: true,
              iterations: iteration,
              answered,
              alreadyComplete: true,
              dispatched: dispatchResult.success,
              dispatchError: dispatchResult.error,
              iterationLog,
            }),
            log: { action: 'complete_detected' },
          };
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
          run('UPDATE tasks SET planning_messages = ?, planning_updated_at = datetime(\'now\') WHERE id = ?', [JSON.stringify(messages), taskId]);
        }

        // Find the latest assistant message
        const lastAssistantMsg = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');
        if (!lastAssistantMsg) {
          // No assistant message yet — the planning agent hasn't responded to the initial prompt
          // Wait and retry
          await sleep(RESPONSE_POLL_INTERVAL_MS);
          return { kind: 'continue', note: 'menunggu respons awal planning agent', log: { action: 'waiting_initial_response' } };
        }

        // Parse the message
        const parsed = extractJSON(lastAssistantMsg.content) as PlanningQuestionPayload | null;

        if (!parsed) {
          // Invalid JSON from agent — stall
          console.warn(`[Auto-Answer] Iteration ${iteration}: Could not parse assistant message as JSON`);
          return { kind: 'stall', code: 'invalid_json', reason: `Planning agent response is not valid JSON (iteration ${iteration})`, log: { action: 'invalid_json' } };
        }

        // Check for completion
        if (parsed.status === 'complete') {
          console.log(`[Auto-Answer] Iteration ${iteration}: Completion detected!`);

          // Approve + dispatch
          const approveResult = await approveAndDispatch(taskId, parsed);
          return {
            kind: 'complete',
            payload: NextResponse.json({
              success: true,
              iterations: iteration,
              answered,
              completionDetected: true,
              dispatched: approveResult.dispatched,
              dispatchError: approveResult.dispatchError,
              spec: parsed.spec,
              agents: parsed.agents,
              iterationLog,
            }),
            log: { action: 'complete_detected' },
          };
        }

        // Check for question
        if (parsed.question && parsed.options) {
          // PLATFORM-016: identify the pending question by its position (index of
          // the last assistant message). The unified DB guard decides whether this
          // question was already answered (persisted across restarts) — the P010
          // BUG-1 in-memory check is gone.
          const questionIdx = lastAssistantMessageIndex(messages);
          if (questionIdx === -1) {
            // No pending question in the stored log — wait and retry.
            await sleep(RESPONSE_POLL_INTERVAL_MS);
            return { kind: 'continue', note: 'belum ada pertanyaan pending di log', log: { action: 'waiting_pending_question' } };
          }

          // Extract recommended answer — fallback to first option (A)
          const recommended = parsed.recommended || 'A';

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

          const answerPayload = effectiveRecommended.toLowerCase() === 'other'
            ? `Other: ${answerText}`
            : answerText;

          // PLATFORM-016 unified guard: append (or skip) atomically based on the
          // DB-persisted answered_question_indices. Same question + same answer =
          // idempotent (no re-append, no re-send); same question + different
          // answer = conflict (rejected); new question = first answer.
          const outcome = appendAnswerWithGuard({
            taskId,
            questionIndex: questionIdx,
            answerValue: answerPayload,
            answerText,
          });

          if (outcome.status === 'ok') {
            console.log(`[Auto-Answer] Iteration ${iteration}: Answering "${questionSnippet}..." with "${effectiveRecommended}"`);

            // Send the answer via OpenClaw chat.send (same approach as answer endpoint)
            const answerPrompt = buildAnswerPrompt(answerPayload);
            try {
              await client.call('chat.send', {
                sessionKey: currentTask.planning_session_key,
                message: answerPrompt,
                idempotencyKey: `auto-answer-${taskId}-${iteration}-${Date.now()}`,
              });
              markAnswerDelivered(taskId, questionIdx, outcome.message.id);
            } catch (sendError) {
              console.error(`[Auto-Answer] Iteration ${iteration}: Failed to send to OpenClaw:`, sendError);
              return {
                kind: 'stall',
                code: 'send_failed',
                reason: `Failed to send answer to planning agent (iteration ${iteration}): ${(sendError as Error).message}`,
                log: { action: 'send_failed', questionSnippet, recommended: effectiveRecommended },
              };
            }

            answered++;

            // Wait for agent response (currentMessageCount includes the just-appended answer)
            const responseReceived = await waitForAgentResponse(currentTask.planning_session_key!, messages.length + 1);
            if (!responseReceived) {
              console.warn(`[Auto-Answer] Iteration ${iteration}: No response from agent within timeout`);
            }

            // Continue to next iteration
            return {
              kind: 'continue',
              note: questionSnippet,
              log: { action: 'answered_question', questionSnippet, recommended: effectiveRecommended },
            };
          }

          if (outcome.status === 'idempotent') {
            // Already answered (DB-persistent). Re-deliver only if the previous
            // delivery failed; otherwise wait for the agent's next message.
            if (!outcome.existing.delivered) {
              console.log(`[Auto-Answer] Iteration ${iteration}: Question ${questionIdx} answered but undelivered — re-sending`);
              const answerPrompt = buildAnswerPrompt(answerPayload);
              try {
                await client.call('chat.send', {
                  sessionKey: currentTask.planning_session_key,
                  message: answerPrompt,
                  idempotencyKey: `auto-answer-${taskId}-${iteration}-${Date.now()}`,
                });
                markAnswerDelivered(taskId, questionIdx, outcome.existing.messageId);
              } catch (sendError) {
                console.error(`[Auto-Answer] Iteration ${iteration}: Failed to re-send to OpenClaw:`, sendError);
                return {
                  kind: 'stall',
                  code: 'send_failed',
                  reason: `Failed to send answer to planning agent (iteration ${iteration}): ${(sendError as Error).message}`,
                  log: { action: 'send_failed', questionSnippet },
                };
              }
            }
            console.log(`[Auto-Answer] Iteration ${iteration}: Question at idx ${questionIdx} already answered — waiting for new response`);
            await sleep(RESPONSE_POLL_INTERVAL_MS);
            return { kind: 'continue', note: questionSnippet, log: { action: 'question_already_answered', questionSnippet } };
          }

          if (outcome.status === 'conflict') {
            // A different answer was already recorded for this question — never
            // append or forward. Log and wait for the agent to move on.
            console.warn(
              `[Auto-Answer] Iteration ${iteration}: Question ${questionIdx} already answered with a DIFFERENT value (existing="${outcome.normalizedExisting}", submitted="${outcome.normalizedSubmitted}") — rejected`
            );
            await sleep(RESPONSE_POLL_INTERVAL_MS);
            return { kind: 'continue', note: questionSnippet, log: { action: 'answer_conflict_rejected', questionSnippet } };
          }

          // no_question / invalid_index — defensive; the pending question was just
          // validated above, so this should not happen. Wait and retry.
          console.warn(`[Auto-Answer] Iteration ${iteration}: Guard outcome ${outcome.status} for question ${questionIdx} — waiting`);
          await sleep(RESPONSE_POLL_INTERVAL_MS);
          return { kind: 'continue', note: questionSnippet, log: { action: 'guard_skip', questionSnippet } };
        }

        // Question/options missing → stall
        console.warn(`[Auto-Answer] Iteration ${iteration}: Message has no question+options and no completion status`);
        return {
          kind: 'stall',
          code: 'invalid_response',
          reason: `Planning agent response has no question, options, or completion marker (iteration ${iteration})`,
          log: { action: 'invalid_response' },
        };
      },
      onProgress: (entry) => {
        iterationLog.push(entry);
        console.log(
          `[Auto-Answer] iter ${entry.iteration}: ${entry.action}${entry.questionSnippet ? ` — "${entry.questionSnippet}"` : ''}${entry.recommended ? ` → ${entry.recommended}` : ''} (elapsed ${entry.elapsedMs}ms)`
        );
      },
    });

    // Terminal outcome from the loop engine.
    if (outcome.outcome === 'complete') {
      return outcome.payload as NextResponse;
    }

    // Stall — time budget exhausted / max iterations / explicit stall.
    return stallResponse(taskId, outcome.reason, outcome.code, iterationLog);
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
  const taskRow = db.prepare('SELECT workspace_id FROM tasks WHERE id = ?').get(taskId) as { workspace_id: string } | undefined;
  const workspaceId = taskRow?.workspace_id || 'default';

  // PLATFORM-012: resolve planning agents (canonical-first, shared with
  // planning-completion). Canonical roles reuse existing agents; non-canonical
  // roles create custom agents when ALLOW_DYNAMIC_AGENTS=true.
  // PLATFORM-017: per-spec resolved agent ids for dispatch marking. Declared
  // outside the agent-creation block so the marking below always sees them.
  const resolvedSpecs: PlanningAgentSpec[] = ((parsed.agents ?? []) as unknown[]).map((a) => ({ ...(a as Record<string, unknown>) }) as PlanningAgentSpec);

  if (parsed.agents && parsed.agents.length > 0) {
    const allowDynamicAgents = process.env.ALLOW_DYNAMIC_AGENTS !== 'false';
    const seenRoles = new Set<CanonicalRole>();

    const insertAgent = db.prepare(`
      INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, soul_md, session_key_prefix, planning_cycle_task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'standby', ?, ?, ?, datetime('now'), datetime('now'))
    `);

    for (let i = 0; i < parsed.agents.length; i++) {
      const agent = parsed.agents[i];
      const agentSpec = {
        name: (agent as any).name || '',
        role: (agent as any).role || '',
        instructions: (agent as any).instructions || '',
        avatar_emoji: (agent as any).avatar_emoji || '🤖',
        soul_md: (agent as any).soul_md || '',
      };

      const resolved = resolvePlanningAgent(workspaceId, agentSpec, allowDynamicAgents, seenRoles);
      if (!resolved) continue;
      resolvedSpecs[i].agent_id = resolved.agentId;

      if (resolved.isCanonical) {
        if (!firstAgentId) firstAgentId = resolved.agentId;
        console.log(`[Auto-Answer] Using canonical agent ${resolved.agentId} for role "${agentSpec.role}"`);
      } else {
        // Custom non-canonical agent — INSERT into DB
        if (!firstAgentId) firstAgentId = resolved.agentId;
        insertAgent.run(
          resolved.agentId,
          workspaceId,
          agentSpec.name,
          agentSpec.role,
          agentSpec.instructions,
          agentSpec.avatar_emoji,
          agentSpec.soul_md,
          resolved.prefix,
          taskId // PLATFORM-017: planning_cycle_task_id metadata tag
        );
        console.log(`[Auto-Answer] Created custom agent ${resolved.agentId} for non-canonical role "${agentSpec.role}"`);
      }
    }
  }

  // PLATFORM-017: persist enriched planning_agents with dispatch marking.
  const enrichedPlanningAgents = markPlanningAgents(resolvedSpecs, firstAgentId);

  // Mark planning complete + assign agent.
  // PLATFORM-014: auto_restart_count resets on successful completion.
  run(
    `UPDATE tasks SET
       planning_complete = 1,
       planning_spec = ?,
       planning_agents = ?,
       assigned_agent_id = ?,
       status = 'assigned',
       planning_dispatch_error = NULL,
       auto_restart_count = 0,
       status_reason = 'Auto-answered by Run workflow',
       updated_at = datetime('now')
     WHERE id = ?`,
    [
      JSON.stringify(parsed.spec || {}),
      JSON.stringify(enrichedPlanningAgents),
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

  // PLATFORM-015: populate task_roles for ALL workflow template stages with the
  // workspace's canonical agents (create-once) — guarantees stage transitions
  // resolve via task_roles instead of falling back to the previous stage's agent.
  try {
    populateTaskRolesFromAgents(taskId, workspaceId);
  } catch (err) {
    console.error('[Auto-Answer] populateTaskRolesFromAgents failed:', (err as Error).message);
  }

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
  iterationLog?: AutoAnswerProgressEntry[]
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

/**
 * Build the answer prompt sent to the planning agent (shared by the first-answer
 * and re-delivery paths).
 */
function buildAnswerPrompt(answerPayload: string): string {
  return `User's answer: ${answerPayload}

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
}

/** Simple sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
