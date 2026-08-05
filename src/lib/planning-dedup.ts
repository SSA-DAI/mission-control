/**
 * PLATFORM-010 BUG-1 — Auto-answer duplicate prevention.
 *
 * MRN-104/P008: /planning/auto-answer looped up to 10 internal iterations,
 * re-appending the SAME answer to planning_messages every iteration because no
 * NEW question had arrived (the agent had not responded yet). The planning
 * conversation ballooned to 81 messages, most of them duplicates, and the main
 * agent never saw the answered signal → completion was delayed indefinitely.
 *
 * Fix: only append an answer when a NEW question is pending. The pending
 * question is identified by the index of the last assistant message in the
 * (ever-growing) planning_messages array:
 *   - While the same question is still pending, the last assistant message
 *     index does not change → already answered → skip (do NOT append again).
 *   - When the agent responds with a new question, the index moves forward →
 *     not answered → append exactly once.
 *
 * Pure + unit-testable so the guard can be regression-tested without the route.
 */

export interface PlanningMessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
}

/**
 * Index of the last assistant message in `messages`, or -1 when there is none.
 */
export function lastAssistantMessageIndex(messages: PlanningMessageLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return i;
  }
  return -1;
}

export interface PendingQuestionDecision {
  /** Index of the current pending question (last assistant message); -1 when none. */
  questionIdx: number;
  /**
   * True when this exact question was already answered in a previous iteration
   * — the caller MUST NOT append the answer again (0 duplicate appends).
   */
  alreadyAnswered: boolean;
}

/**
 * Decide whether the pending question has already been answered.
 *
 * @param messages current planning_messages array
 * @param lastAnsweredQuestionIdx index of the question answered in the previous
 *   iteration (-1 when nothing has been answered yet)
 */
export function evaluatePendingQuestion(
  messages: PlanningMessageLike[],
  lastAnsweredQuestionIdx: number
): PendingQuestionDecision {
  const questionIdx = lastAssistantMessageIndex(messages);
  if (questionIdx === -1) return { questionIdx: -1, alreadyAnswered: false };
  return {
    questionIdx,
    alreadyAnswered: questionIdx === lastAnsweredQuestionIdx,
  };
}

/**
 * Simulate one auto-answer iteration's dedup decision against a message log.
 * Convenience wrapper used by the route: given the current messages and the
 * previously answered question index, returns whether the pending question is
 * the same one (skip) or a new one (answer).
 */
export function shouldSkipAnswerForPendingQuestion(
  messages: PlanningMessageLike[],
  lastAnsweredQuestionIdx: number
): boolean {
  return evaluatePendingQuestion(messages, lastAnsweredQuestionIdx).alreadyAnswered;
}
