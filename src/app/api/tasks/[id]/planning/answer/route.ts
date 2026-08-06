import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { scheduleRequestGuard } from '@/lib/planning-watchdog';
import {
  appendAnswerWithGuard,
  markAnswerDelivered,
} from '@/lib/planning-answer-idempotency';

export const dynamic = 'force-dynamic';

const ANSWER_PROMPT = `User's answer: {answer}

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

IMPORTANT: The completion JSON must be COMPACT (under 6KB) and valid — include spec (title, summary, deliverables, success_criteria, constraints) and agents; limit execution_plan.steps to at most 5 short steps. NEVER emit truncated or invalid JSON; if the output is large, omit details rather than truncate. For questions, "recommended" and "recommended_reason" are REQUIRED.`;

// POST /api/tasks/[id]/planning/answer - Submit an answer and get next question
//
// PLATFORM-016 idempotency contract:
//   Body:  { answer: string, otherText?: string, questionIndex?: number }
//   - questionIndex is optional. When omitted it is derived from the currently
//     pending question (last assistant message). Clients that persist the
//     questionIndex returned by a successful answer can pass it back on retry
//     for restart-safe idempotency (see docs/PLATFORM-016-answer-idempotency.md).
//   Responses:
//   - 200 first answer:  { success, idempotent: false, questionIndex, messages }
//   - 200 idempotent:    { success, idempotent: true, existingAnswerId, questionIndex, messages }
//   - 409 conflict:      { error: 'QUESTION_ALREADY_ANSWERED', existingAnswer, submittedAnswer, questionIndex }
//   - 400/404: validation / task / planning state errors
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json();
    const { answer, otherText, questionIndex } = body;

    if (!answer || typeof answer !== 'string' || answer.trim() === '') {
      return NextResponse.json({ error: 'Answer is required' }, { status: 400 });
    }
    if (questionIndex !== undefined && (!Number.isInteger(questionIndex) || questionIndex < 0)) {
      return NextResponse.json({ error: 'questionIndex must be a non-negative integer' }, { status: 400 });
    }

    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      planning_session_key?: string;
      planning_messages?: string;
      answered_question_indices?: string;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!task.planning_session_key) {
      return NextResponse.json({ error: 'Planning not started' }, { status: 400 });
    }

    // Build the answer message (same as pre-P016)
    const answerText = answer?.toLowerCase() === 'other' && otherText
      ? `Other: ${otherText}`
      : answer;

    // PLATFORM-016: guard check + append in one transaction.
    const outcome = appendAnswerWithGuard({
      taskId,
      questionIndex,
      answerValue: answerText,
      answerText,
    });

    switch (outcome.status) {
      case 'task_not_found':
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      case 'no_question':
        return NextResponse.json({ error: 'No pending question to answer' }, { status: 400 });
      case 'invalid_index':
        return NextResponse.json(
          { error: 'questionIndex does not reference a pending question' },
          { status: 400 }
        );
      case 'conflict': {
        // PLATFORM-016: the question was already answered with a different value.
        // Do NOT append, do NOT forward to the agent. 409 lets the client detect
        // driver-restart double-answer and reconcile with the existing answer.
        console.warn(`[Planning Answer] Rejected duplicate answer for task ${taskId}: conflict at question ${outcome.questionIndex}`);
        return NextResponse.json(
          {
            error: 'QUESTION_ALREADY_ANSWERED',
            message: 'This question was already answered with a different value. Answering again would corrupt the planning context.',
            existingAnswer: outcome.normalizedExisting,
            submittedAnswer: outcome.normalizedSubmitted,
            questionIndex: outcome.questionIndex,
          },
          { status: 409 }
        );
      }
      case 'idempotent': {
        const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
        // Same normalized answer as before → no append. Re-deliver only when the
        // previous delivery to the agent failed (delivered=false).
        if (!outcome.existing.delivered) {
          const sendError = await sendAnswerToAgent(taskId, task.planning_session_key!, answerText);
          if (sendError) {
            return NextResponse.json(
              { error: `Failed to send answer to orchestrator: ${sendError}` },
              { status: 500 }
            );
          }
          markAnswerDelivered(taskId, outcome.questionIndex, outcome.existing.messageId);
          scheduleRequestGuard(taskId);
        }
        console.log(`[Planning Answer] Idempotent retry for task ${taskId} question ${outcome.questionIndex} — not re-appended`);
        return NextResponse.json({
          success: true,
          idempotent: true,
          existingAnswerId: outcome.existing.messageId,
          questionIndex: outcome.questionIndex,
          messages,
          note: 'Answer already recorded for this question (idempotent retry). Poll GET endpoint for updates.',
        });
      }
      case 'ok': {
        // First answer — persisted by appendAnswerWithGuard. Deliver to OpenClaw.
        const sendError = await sendAnswerToAgent(taskId, task.planning_session_key!, answerText);
        if (sendError) {
          // Answer IS persisted (delivered=false) so the conversation state is
          // never lost; a same-value retry will be idempotent and re-deliver.
          return NextResponse.json(
            {
              error: `Failed to send answer to orchestrator: ${sendError}`,
              message: 'Answer was recorded but not delivered to the planning agent. Retry with the SAME answer to re-deliver idempotently.',
              questionIndex: outcome.questionIndex,
              idempotentRetryable: true,
            },
            { status: 500 }
          );
        }
        markAnswerDelivered(taskId, outcome.questionIndex, outcome.message.id);

        // PLATFORM-014: request-level watchdog guard — if the agent goes silent
        // for PLANNING_REQUEST_TIMEOUT after this answer, the stall handler
        // fires without waiting for the next sweep tick.
        scheduleRequestGuard(taskId);

        const updated = getDb()
          .prepare('SELECT planning_messages FROM tasks WHERE id = ?')
          .get(taskId) as { planning_messages?: string } | undefined;
        const messages = updated?.planning_messages ? JSON.parse(updated.planning_messages) : [];

        return NextResponse.json({
          success: true,
          idempotent: false,
          questionIndex: outcome.questionIndex,
          messages,
          note: 'Answer submitted. Poll GET endpoint for updates.',
        });
      }
    }
  } catch (error) {
    console.error('Failed to submit answer:', error);
    return NextResponse.json({ error: 'Failed to submit answer: ' + (error as Error).message }, { status: 500 });
  }
}

/**
 * Send the answer prompt to the planning agent session. Returns an error
 * message on failure, null on success.
 */
async function sendAnswerToAgent(
  taskId: string,
  sessionKey: string,
  answerText: string
): Promise<string | null> {
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    console.log('[Planning Answer] Connecting to OpenClaw...');
    await client.connect();
  }

  console.log('[Planning Answer] Sending answer to OpenClaw, session:', sessionKey);
  console.log('[Planning Answer] Answer text:', answerText);

  try {
    await client.call('chat.send', {
      sessionKey,
      message: ANSWER_PROMPT.replace('{answer}', answerText),
      idempotencyKey: `planning-answer-${taskId}-${Date.now()}`,
    });
    console.log('[Planning Answer] Send successful');
    return null;
  } catch (sendError) {
    console.error('[Planning Answer] Failed to send to OpenClaw:', sendError);
    return (sendError as Error).message;
  }
}
