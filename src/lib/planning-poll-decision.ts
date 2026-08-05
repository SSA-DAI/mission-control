/**
 * PLATFORM-010 BUG-2 — Poll short-circuit guard.
 *
 * MRN-104/P008: GET /planning/poll returned EARLY whenever
 * planning_dispatch_error was set (e.g. from a stalled auto-answer), so a
 * completion spec that had already arrived in the planning session was NEVER
 * processed — planning_complete stayed 0 despite a complete spec (P008 had to
 * be cleaned up manually via DB).
 *
 * Fix: completion processing ALWAYS happens BEFORE a stale dispatch_error is
 * reported; a stale error is only surfaced when no completion was found.
 *
 * This pure decision function encodes the ordering guarantee. The poll route
 * uses it for the early-complete check and the tail (no-new-messages)
 * response, so the regression tests below exercise the exact same logic that
 * runs in production.
 */

export interface PollDecisionInput {
  /** planning_complete already set on the task row. */
  planningComplete: boolean;
  /** Stale planning_dispatch_error from a previous failed auto-answer. */
  dispatchError: string | null;
  /** A completion message was found (new from gateway or stored-but-unprocessed). */
  hasUnprocessedCompletion: boolean;
  /** New assistant messages arrived from the gateway. */
  hasNewMessages: boolean;
}

export interface PollDecision {
  /** True → caller returns the terminal "already complete" response. */
  isComplete: boolean;
  /** True → caller must process the completion NOW (dispatch). */
  processCompletion: boolean;
  /** True → include dispatchError in the poll response. */
  reportDispatchError: boolean;
  /** hasUpdates for the poll response. */
  hasUpdates: boolean;
}

/**
 * Resolve the poll response decision.
 *
 * Ordering guarantee (BUG-2): completion checks come FIRST. A stale
 * dispatch_error never short-circuits completion processing — it is only
 * reported when no completion exists.
 */
export function resolvePollResponse(input: PollDecisionInput): PollDecision {
  // 1. Already complete → terminal response; nothing to report.
  if (input.planningComplete) {
    return { isComplete: true, processCompletion: false, reportDispatchError: false, hasUpdates: false };
  }

  // 2. Completion found → process it. A stale dispatch_error must NOT block
  //    this (BUG-2 regression: completion wins over stale error).
  if (input.hasUnprocessedCompletion) {
    return { isComplete: false, processCompletion: true, reportDispatchError: false, hasUpdates: true };
  }

  // 3. No completion → only NOW may a stale dispatch_error surface.
  return {
    isComplete: false,
    processCompletion: false,
    reportDispatchError: Boolean(input.dispatchError),
    hasUpdates: input.hasNewMessages || Boolean(input.dispatchError),
  };
}
