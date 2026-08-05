/**
 * PLATFORM-010 BUG-1 — Auto-answer duplicate regression tests.
 *
 * Scenario (MRN-104/P008): /planning/auto-answer looped 10 internal iterations;
 * every iteration appended the SAME answer to planning_messages because the
 * planning agent had not responded yet → 81-message conversation, mostly
 * duplicates, completion delayed.
 *
 * These tests prove the guard allows exactly ONE append per pending question
 * (0 duplicates across 10 iterations) and still answers a NEW question.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePendingQuestion,
  lastAssistantMessageIndex,
  shouldSkipAnswerForPendingQuestion,
  type PlanningMessageLike,
} from './planning-dedup';

/** A minimal assistant question message shaped like the route's messages. */
function question(content: string): PlanningMessageLike {
  return { role: 'assistant', content, timestamp: Date.now() };
}

function userAnswer(content: string): PlanningMessageLike {
  return { role: 'user', content, timestamp: Date.now() };
}

/**
 * Simulate the auto-answer main loop's dedup bookkeeping (BUG-1 guard):
 * returns how many answers would be appended over `iterations` polls when the
 * message log is frozen (agent never responds). Must be exactly 1.
 */
function simulateAutoAnswerLoop(messages: PlanningMessageLike[], iterations = 10): number {
  let lastAnsweredQuestionIdx = -1;
  let appends = 0;
  for (let i = 0; i < iterations; i++) {
    const { questionIdx, alreadyAnswered } = evaluatePendingQuestion(messages, lastAnsweredQuestionIdx);
    if (alreadyAnswered) continue; // ← the BUG-1 guard: skip, do NOT append
    lastAnsweredQuestionIdx = questionIdx;
    appends++;
  }
  return appends;
}

test('evaluatePendingQuestion: no assistant messages → questionIdx -1, not answered', () => {
  const d = evaluatePendingQuestion([userAnswer('A')], -1);
  assert.equal(d.questionIdx, -1);
  assert.equal(d.alreadyAnswered, false);
});

test('evaluatePendingQuestion: first encounter of a question → not answered', () => {
  const messages = [question('Q1')];
  const d = evaluatePendingQuestion(messages, -1);
  assert.equal(d.questionIdx, 0);
  assert.equal(d.alreadyAnswered, false);
  assert.equal(shouldSkipAnswerForPendingQuestion(messages, -1), false);
});

test('evaluatePendingQuestion: same pending question → alreadyAnswered (skip)', () => {
  const messages = [question('Q1')];
  // First iteration answered idx 0…
  assert.equal(evaluatePendingQuestion(messages, -1).alreadyAnswered, false);
  // …next iteration sees the SAME question still pending → skip.
  const d = evaluatePendingQuestion(messages, 0);
  assert.equal(d.questionIdx, 0);
  assert.equal(d.alreadyAnswered, true);
  assert.equal(shouldSkipAnswerForPendingQuestion(messages, 0), true);
});

test('BUG-1 regression: 10 iterations with no new question → exactly 1 append, 0 duplicates', () => {
  // Frozen message log: the planning agent never responded (MRN-104 pattern).
  const frozen = [question('{"question":"Q","options":[...]}')];
  const appends = simulateAutoAnswerLoop(frozen, 10);
  assert.equal(appends, 1, 'exactly one answer appended, no duplicates');
});

test('BUG-1 regression: 10 iterations with growing log → one append per new question', () => {
  // The agent DID respond with a new question after each answer: the log grows.
  const log: PlanningMessageLike[] = [question('Q1')];
  let lastAnsweredQuestionIdx = -1;
  let appends = 0;

  for (let i = 0; i < 10; i++) {
    const { questionIdx, alreadyAnswered } = evaluatePendingQuestion(log, lastAnsweredQuestionIdx);
    if (alreadyAnswered) continue;
    lastAnsweredQuestionIdx = questionIdx;
    appends++;
    // Agent responds: user answer + new assistant question appended.
    log.push(userAnswer(`answer-${i}`));
    log.push(question(`Q${i + 2}`));
  }

  assert.equal(appends, 10, 'every NEW question is answered exactly once');
});

test('new question after agent response → not alreadyAnswered (append allowed)', () => {
  const messages = [question('Q1'), userAnswer('A'), question('Q2')];
  const d = evaluatePendingQuestion(messages, 0); // Q1 was answered at idx 0
  assert.equal(d.questionIdx, 2);
  assert.equal(d.alreadyAnswered, false, 'Q2 is a new question → answer it');
});

test('identical content at a NEW index → not alreadyAnswered (idx-based, not content-based)', () => {
  // The old implementation matched on content with findIndex, which would find
  // the FIRST occurrence (idx 0) and wrongly skip the repeat question.
  const messages = [
    question('SAME QUESTION'),
    userAnswer('A'),
    question('SAME QUESTION'), // repeat question at idx 2
  ];
  const d = evaluatePendingQuestion(messages, 0);
  assert.equal(d.questionIdx, 2, 'pending question is the LAST assistant message');
  assert.equal(d.alreadyAnswered, false, 'new position = new question → answer it');
});

test('lastAssistantMessageIndex: ignores user messages and trailing non-assistant entries', () => {
  const messages = [question('Q1'), userAnswer('A'), question('Q2'), userAnswer('B')];
  assert.equal(lastAssistantMessageIndex(messages), 2);
  assert.equal(lastAssistantMessageIndex([]), -1);
});
