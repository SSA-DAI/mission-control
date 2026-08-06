/**
 * PLATFORM-016 — Answer idempotency: reject duplicate answers to an already
 * answered planning question.
 *
 * Background (PLATFORM-009 incident): the planning driver restarts with no
 * persisted state, so the SAME question was answered 2–3× (A, C, B) → the
 * planning agent's context was corrupted and planning stalled for 13 minutes.
 * The P010 BUG-1 fix only guarded the auto-answer path with in-memory state
 * (lost on restart) and did NOT cover POST /planning/answer at all.
 *
 * This module is the unified, DB-persistent guard used by BOTH the manual
 * answer endpoint and the auto-answer flow:
 *   - answered_question_indices (tasks table, JSON TEXT) maps a question index
 *     (position of the assistant question message in planning_messages) to an
 *     answer record: { "<idx>": { questionHash, answer, messageId, delivered } }.
 *   - questionHash (sha256 of the question content) makes the index key robust:
 *     if the agent re-asks a DIFFERENT question at the same index (e.g. after a
 *     planning-session restart), the old record is treated as stale and the new
 *     question is answerable (first_answer) instead of a false conflict.
 *   - Answer comparison is normalized (trim + lowercase): identical retries are
 *     idempotent (200), different values are rejected (409 conflict).
 *   - Guard check + append happen in ONE better-sqlite3 transaction, so
 *     concurrent requests for the same question cannot both append.
 *
 * P010 BUG-1's in-memory guard (planning-dedup.ts) is fully replaced by this
 * module — see src/app/api/tasks/[id]/planning/auto-answer/route.ts.
 */

import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db';

export interface PlanningMessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
}

/** Per-question answer record stored in tasks.answered_question_indices. */
export interface AnsweredRecord {
  /** Hash of the question content this answer belongs to (stale-question guard). */
  questionHash: string;
  /** Normalized answer value (trim + lowercase) used for idempotency compare. */
  answer: string;
  /** id of the user message appended to planning_messages. */
  messageId: string;
  /** Whether the answer was successfully delivered to the OpenClaw session. */
  delivered: boolean;
}

/** JSON object: question index (as string) → answer record. */
export type AnsweredMap = Record<string, AnsweredRecord>;

/**
 * Index of the last assistant message in `messages`, or -1 when there is none.
 * (Moved here from planning-dedup.ts, which was removed in PLATFORM-016.)
 */
export function lastAssistantMessageIndex(messages: PlanningMessageLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return i;
  }
  return -1;
}

/**
 * Normalize an answer value for idempotency comparison: trim surrounding
 * whitespace + lowercase + collapse internal whitespace runs. Case and
 * whitespace-only differences are treated as the same answer (idempotent
 * retry), per the PLATFORM-016 planning spec.
 */
export function normalizeAnswer(value: string): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Stable short hash of a question's content. Used to detect whether the
 * question currently pending at an index is the same one that was answered
 * before (same index + same hash = same question).
 */
export function hashQuestion(content: string): string {
  return createHash('sha256').update(content ?? '').digest('hex').slice(0, 16);
}

/** Parse tasks.answered_question_indices; NULL/invalid JSON → empty map. */
export function parseAnsweredMap(json: string | null | undefined): AnsweredMap {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AnsweredMap;
    }
  } catch {
    // fall through — corrupt JSON must not break the guard
  }
  return {};
}

export type AnswerIdempotencyDecision =
  | { allowed: true; reason: 'first_answer' }
  | {
      allowed: true;
      reason: 'idempotent';
      existing: AnsweredRecord;
      normalizedExisting: string;
      normalizedSubmitted: string;
    }
  | {
      allowed: false;
      reason: 'conflict';
      existing: AnsweredRecord;
      normalizedExisting: string;
      normalizedSubmitted: string;
    };

/**
 * Pure guard decision: is this answer allowed for the given question?
 * Pure (no DB access) so it is unit-testable in isolation.
 *
 * @param map           parsed answered_question_indices
 * @param questionIndex position of the question in planning_messages
 * @param questionHash  hash of the question content (see hashQuestion)
 * @param answerValue   raw submitted answer value
 */
export function checkAnswerIdempotency(
  map: AnsweredMap,
  questionIndex: number,
  questionHash: string,
  answerValue: string
): AnswerIdempotencyDecision {
  const existing = map[String(questionIndex)];

  // Never answered before → allow.
  if (!existing) return { allowed: true, reason: 'first_answer' };

  // The question at this index has changed (e.g. planning session was
  // restarted and the agent re-asked a different question) → the old record is
  // stale; the new question is answerable.
  if (existing.questionHash !== questionHash) {
    return { allowed: true, reason: 'first_answer' };
  }

  const normalizedExisting = existing.answer;
  const normalizedSubmitted = normalizeAnswer(answerValue);

  if (normalizedSubmitted === normalizedExisting) {
    return { allowed: true, reason: 'idempotent', existing, normalizedExisting, normalizedSubmitted };
  }
  return { allowed: false, reason: 'conflict', existing, normalizedExisting, normalizedSubmitted };
}

export type AppendAnswerOutcome =
  | {
      status: 'ok';
      questionIndex: number;
      /** The user message appended to planning_messages (has an `id`). */
      message: { role: 'user'; content: string; id: string; timestamp: number };
    }
  | {
      status: 'idempotent';
      questionIndex: number;
      existing: AnsweredRecord;
      normalizedExisting: string;
      normalizedSubmitted: string;
    }
  | {
      status: 'conflict';
      questionIndex: number;
      existing: AnsweredRecord;
      normalizedExisting: string;
      normalizedSubmitted: string;
    }
  | { status: 'no_question' }
  | { status: 'invalid_index' }
  | { status: 'task_not_found' };

export interface AppendAnswerInput {
  taskId: string;
  /**
   * Question index (position of the assistant question message in
   * planning_messages). When omitted it is derived from the LAST assistant
   * message (the currently pending question) — matching the pre-P016 behavior.
   * Clients that persist the index returned by a previous successful answer can
   * pass it back for restart-safe retries.
   */
  questionIndex?: number;
  /** Raw answer value used for the idempotency compare. */
  answerValue: string;
  /** Human-readable content stored in planning_messages (may differ for "Other"). */
  answerText: string;
}

/**
 * Guard check + append in ONE transaction (PLATFORM-016 constraint:
 * atomicity). Reads the task row, derives/resolves the question index, runs the
 * idempotency guard, and — only when allowed as a first answer — appends the
 * user message to planning_messages and records the answered index.
 *
 * Delivery to OpenClaw is NOT part of this transaction; callers send afterwards
 * and call markAnswerDelivered() on success. On send failure the answer stays
 * persisted with delivered=false, so a same-value retry is idempotent and the
 * caller can re-deliver.
 */
export function appendAnswerWithGuard(input: AppendAnswerInput): AppendAnswerOutcome {
  const db = getDb();
  const tx = db.transaction((): AppendAnswerOutcome => {
    const task = db
      .prepare('SELECT planning_messages, answered_question_indices FROM tasks WHERE id = ?')
      .get(input.taskId) as { planning_messages?: string | null; answered_question_indices?: string | null } | undefined;

    if (!task) return { status: 'task_not_found' };

    const messages: PlanningMessageLike[] = task.planning_messages ? JSON.parse(task.planning_messages) : [];

    let questionIndex = input.questionIndex;
    if (questionIndex === undefined) {
      questionIndex = lastAssistantMessageIndex(messages);
      if (questionIndex === -1) return { status: 'no_question' };
    } else if (!Number.isInteger(questionIndex) || questionIndex < 0) {
      return { status: 'invalid_index' };
    }

    const questionMsg = messages[questionIndex];
    if (!questionMsg || questionMsg.role !== 'assistant') {
      return { status: 'invalid_index' };
    }

    const questionContent =
      typeof questionMsg.content === 'string' ? questionMsg.content : JSON.stringify(questionMsg.content ?? '');
    const questionHash = hashQuestion(questionContent);

    const map = parseAnsweredMap(task.answered_question_indices);
    const decision = checkAnswerIdempotency(map, questionIndex, questionHash, input.answerValue);

    if (!decision.allowed) {
      return {
        status: 'conflict',
        questionIndex,
        existing: decision.existing,
        normalizedExisting: decision.normalizedExisting,
        normalizedSubmitted: decision.normalizedSubmitted,
      };
    }
    if (decision.reason === 'idempotent') {
      return {
        status: 'idempotent',
        questionIndex,
        existing: decision.existing,
        normalizedExisting: decision.normalizedExisting,
        normalizedSubmitted: decision.normalizedSubmitted,
      };
    }

    // first_answer → append atomically.
    const message = { role: 'user' as const, content: input.answerText, id: uuidv4(), timestamp: Date.now() };
    messages.push(message);
    const nextMap: AnsweredMap = {
      ...map,
      [String(questionIndex)]: {
        questionHash,
        answer: normalizeAnswer(input.answerValue),
        messageId: message.id,
        delivered: false,
      },
    };
    db.prepare(
      `UPDATE tasks
       SET planning_messages = ?, answered_question_indices = ?, planning_updated_at = datetime('now')
       WHERE id = ?`
    ).run(JSON.stringify(messages), JSON.stringify(nextMap), input.taskId);

    return { status: 'ok', questionIndex, message };
  });

  return tx();
}

/**
 * Mark an answer record as delivered to the OpenClaw session. Only flips the
 * flag when the messageId matches, so a stale caller cannot mutate the record.
 */
export function markAnswerDelivered(taskId: string, questionIndex: number, messageId: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    const task = db
      .prepare('SELECT answered_question_indices FROM tasks WHERE id = ?')
      .get(taskId) as { answered_question_indices?: string | null } | undefined;
    if (!task) return;
    const map = parseAnsweredMap(task.answered_question_indices);
    const rec = map[String(questionIndex)];
    if (!rec || rec.messageId !== messageId) return;
    map[String(questionIndex)] = { ...rec, delivered: true };
    db.prepare('UPDATE tasks SET answered_question_indices = ? WHERE id = ?').run(JSON.stringify(map), taskId);
  });
  tx();
}

/**
 * Clear all answered-question tracking for a task. Called when a planning
 * SESSION is restarted/reset (startPlanningSession, cancel, hard reset): the
 * new session replays questions from scratch, so old records must not suppress
 * answers to the same questions (their answers were delivered to the old
 * session, not the new one).
 */
export function clearAnsweredQuestionIndices(taskId: string): void {
  getDb().prepare('UPDATE tasks SET answered_question_indices = NULL WHERE id = ?').run(taskId);
}
