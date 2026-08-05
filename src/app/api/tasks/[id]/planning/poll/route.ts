import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { extractJSON, getMessagesFromOpenClaw, isTruncatedContent } from '@/lib/planning-utils';
import { resolvePollResponse } from '@/lib/planning-poll-decision';
import { handlePlanningCompletion } from '@/lib/planning-completion';

export const dynamic = 'force-dynamic';
// Planning timeout and poll interval configuration with validation
const PLANNING_TIMEOUT_MS = parseInt(process.env.PLANNING_TIMEOUT_MS || '30000', 10);
const PLANNING_POLL_INTERVAL_MS = parseInt(process.env.PLANNING_POLL_INTERVAL_MS || '2000', 10);
const PLANNING_STALE_MS = parseInt(process.env.PLANNING_STALE_MS || '600000', 10);
const PLANNING_SOFT_WARNING_MS = parseInt(process.env.PLANNING_SOFT_WARNING_MS || '90000', 10);
const PLANNING_HARD_TIMEOUT_MS = parseInt(process.env.PLANNING_HARD_TIMEOUT_MS || '300000', 10);

// Validate environment variables
if (isNaN(PLANNING_TIMEOUT_MS) || PLANNING_TIMEOUT_MS < 1000) {
  throw new Error('PLANNING_TIMEOUT_MS must be a valid number >= 1000ms');
}
if (isNaN(PLANNING_POLL_INTERVAL_MS) || PLANNING_POLL_INTERVAL_MS < 100) {
  throw new Error('PLANNING_POLL_INTERVAL_MS must be a valid number >= 100ms');
}
if (isNaN(PLANNING_STALE_MS) || PLANNING_STALE_MS < 1000) {
  throw new Error('PLANNING_STALE_MS must be a valid number >= 1000ms');
}

// GET /api/tasks/[id]/planning/poll - Check for new messages from OpenClaw
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_dispatch_error?: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task || !task.planning_session_key) {
      return NextResponse.json({ error: 'Planning session not found' }, { status: 404 });
    }

    // PLATFORM-010 BUG-2: single decision point for the terminal + tail
    // responses — completion ALWAYS wins over a stale dispatch_error.
    const tailDecision = resolvePollResponse({
      planningComplete: Boolean(task.planning_complete),
      dispatchError: task.planning_dispatch_error ?? null,
      hasUnprocessedCompletion: false,
      hasNewMessages: false,
    });
    if (tailDecision.isComplete) {
      return NextResponse.json({ hasUpdates: false, isComplete: true });
    }

    // PLATFORM-010 BUG-2: Do NOT short-circuit on planning_dispatch_error before
    // checking for completion. A stale dispatch_error from a previous failed
    // auto-answer must not prevent a newly-arrived completion from being
    // processed. We'll check for completion FIRST, then report any remaining
    // dispatch_error only if no completion was found.
    // (Old behavior: early return on dispatch_error blocked completion processing.)

    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    // Count only assistant messages for comparison, since OpenClaw only returns assistant messages
    const initialAssistantCount = messages.filter((m: any) => m.role === 'assistant').length;

    console.log('[Planning Poll] Task', taskId, 'has', messages.length, 'total messages,', initialAssistantCount, 'assistant messages');

    // Check OpenClaw for new messages (lightweight check, not a loop)
    const openclawMessages = await getMessagesFromOpenClaw(task.planning_session_key);

    console.log('[Planning Poll] Comparison: stored_assistant=', initialAssistantCount, 'openclaw_assistant=', openclawMessages.length);

    if (openclawMessages.length > initialAssistantCount) {
      let currentQuestion = null;
      const newMessages = openclawMessages.slice(initialAssistantCount);
      console.log('[Planning Poll] Processing', newMessages.length, 'new messages');

      // Find new assistant messages
      for (const msg of newMessages) {
        console.log('[Planning Poll] Processing new message, role:', msg.role, 'content length:', msg.content?.length || 0);

        if (msg.role === 'assistant') {
          const lastMessage = { role: 'assistant', content: msg.content, timestamp: Date.now() };
          messages.push(lastMessage);

          // Check if this message contains completion status or a question
          const parsed = extractJSON(msg.content) as {
            status?: string;
            question?: string;
            options?: Array<{ id: string; label: string }>;
            recommended?: string;
            recommended_reason?: string;
            spec?: object;
            agents?: Array<{
              name: string;
              role: string;
              avatar_emoji?: string;
              soul_md?: string;
              instructions?: string;
            }>;
            execution_plan?: object;
          } | null;

          console.log('[Planning Poll] Parsed message content:', {
            hasStatus: !!parsed?.status,
            hasQuestion: !!parsed?.question,
            hasOptions: !!parsed?.options,
            status: parsed?.status,
            question: parsed?.question?.substring(0, 50),
            rawPreview: msg.content?.substring(0, 200)
          });

          if (parsed && parsed.status === 'complete') {
            // Handle completion
            console.log('[Planning Poll] Planning complete, handling...');
            const { firstAgentId, parsed: fullParsed, dispatchError } = await handlePlanningCompletion(taskId, parsed, messages);

            return NextResponse.json({
              hasUpdates: true,
              complete: true,
              spec: fullParsed.spec,
              agents: fullParsed.agents,
              executionPlan: fullParsed.execution_plan,
              messages,
              autoDispatched: !!firstAgentId,
              dispatchError,
            });
          }

          // Extract current question if present (be tolerant if options are missing)
          if (parsed && parsed.question) {
            const normalizedOptions = Array.isArray(parsed.options) && parsed.options.length > 0
              ? parsed.options
              : [
                  { id: 'continue', label: 'Continue' },
                  { id: 'other', label: 'Other' },
                ];
            console.log('[Planning Poll] Found question with', normalizedOptions.length, 'options');
            currentQuestion = {
              question: parsed.question,
              options: normalizedOptions,
              recommended: parsed.recommended as string | undefined,
              recommended_reason: parsed.recommended_reason as string | undefined,
            };
          }
        }
      }

      console.log('[Planning Poll] Returning updates: currentQuestion =', currentQuestion ? 'YES' : 'NO');

      // Update database
      run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(messages), taskId]);

      return NextResponse.json({
        hasUpdates: true,
        complete: false,
        messages,
        currentQuestion,
      });
    }

    // FALLBACK: Check if the last stored message is actually a completion that was
    // saved but never processed (race condition where message was stored but
    // extractJSON failed or the completion handler never fired).
    const lastAssistantMsg = [...messages].reverse().find((m: any) => m.role === 'assistant');
    if (lastAssistantMsg) {
      const parsed = extractJSON(lastAssistantMsg.content) as { status?: string; spec?: object; agents?: any[]; execution_plan?: object } | null;
      if (parsed && parsed.status === 'complete') {
        console.log('[Planning Poll] FALLBACK: Found unprocessed completion in stored messages — handling now');
        const { firstAgentId, parsed: fullParsed, dispatchError } = await handlePlanningCompletion(taskId, parsed, messages);
        return NextResponse.json({
          hasUpdates: true,
          complete: true,
          spec: fullParsed.spec,
          agents: fullParsed.agents,
          executionPlan: fullParsed.execution_plan,
          messages,
          autoDispatched: !!firstAgentId,
          dispatchError,
        });
      }
    }

    // PLATFORM-001: report truncated/invalid completion instead of stalling silently
    const truncCheckMsg = [...messages].reverse().find((m: any) => m.role === 'assistant');
    if (truncCheckMsg) {
      const lastParsed = extractJSON(truncCheckMsg.content) as { status?: string; question?: string } | null;
      if (!lastParsed && isTruncatedContent(truncCheckMsg.content)) {
        console.warn('[Planning Poll] TRUNCATED completion detected — flagging for user (state preserved)');
        run(
          `UPDATE tasks SET planning_dispatch_error = ?, status_reason = 'PLANNING_TRUNCATED: completion JSON invalid', updated_at = datetime('now') WHERE id = ?`,
          ['Completion message was truncated/invalid JSON — review the planning conversation; ask the agent to resend a compact completion, or cancel (DELETE /planning) and restart', taskId]
        );
        return NextResponse.json({
          hasUpdates: true,
          truncated: true,
          planningError: 'Completion message truncated — review conversation',
          stalePlanning: false,
          awaitingUser: false,
        });
      }
    }

    // Check for stale planning — configurable via PLANNING_STALE_MS (default 10 minutes)
    const lastMsgTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : null;
    const isStalePlanning = lastMsgTimestamp && (Date.now() - lastMsgTimestamp) > PLANNING_STALE_MS;
    // The ball is with the USER when the last assistant message is a question — that is not "stuck"
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === 'assistant');
    const lastAssistantParsed = lastAssistant ? (extractJSON(lastAssistant.content) as { question?: string } | null) : null;
    const awaitingUser = !!(lastAssistantParsed && lastAssistantParsed.question);

    // PLATFORM-010 BUG-2: Report dispatch_error only AFTER all completion checks.
    // This ensures a stale dispatch_error from a previous failed auto-answer
    // doesn't block a newly-arrived completion from being processed. The same
    // decision logic is unit-tested in src/lib/planning-poll-decision.test.ts.
    const tail = resolvePollResponse({
      planningComplete: false,
      dispatchError: task.planning_dispatch_error ?? null,
      hasUnprocessedCompletion: false,
      hasNewMessages: false,
    });
    console.log('[Planning Poll] No new messages found', isStalePlanning ? '(STALE — over ' + (PLANNING_STALE_MS / 60000) + 'min)' : '', awaitingUser ? '(awaiting user)' : '');
    return NextResponse.json({ 
      hasUpdates: tail.hasUpdates,
      dispatchError: tail.reportDispatchError ? task.planning_dispatch_error || undefined : undefined,
      stalePlanning: (isStalePlanning && !awaitingUser) || undefined,
      staleSinceMs: isStalePlanning ? (Date.now() - lastMsgTimestamp) : undefined,
      awaitingUser: awaitingUser || undefined,
      timeouts: { softWarningMs: PLANNING_SOFT_WARNING_MS, hardTimeoutMs: PLANNING_HARD_TIMEOUT_MS },
    });
  } catch (error) {
    console.error('Failed to poll for updates:', error);
    return NextResponse.json({ error: 'Failed to poll for updates' }, { status: 500 });
  }
}
