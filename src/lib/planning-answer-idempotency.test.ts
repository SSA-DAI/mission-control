/**
 * PLATFORM-016 — Answer idempotency regression tests.
 *
 * Covers:
 *  1. First answer → ok, appended to planning_messages, index recorded
 *  2. Same answer (normalized: case/whitespace differences) → idempotent, NO duplicate
 *  3. Different answer → conflict, NO append
 *  4. Auto-answer flow (simulated) → same idempotency via unified guard
 *  5. Driver-restart simulation → multiple identical answers = only first stored
 *  6. Concurrent requests for same question → only one answer appended
 *  7. Non-existent taskId → task_not_found; invalid questionIndex → invalid_index;
 *     no pending question → no_question
 *  8. markAnswerDelivered / clearAnsweredQuestionIndices behavior
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { run, queryOne } from './db';
import {
  normalizeAnswer,
  hashQuestion,
  parseAnsweredMap,
  lastAssistantMessageIndex,
  checkAnswerIdempotency,
  appendAnswerWithGuard,
  markAnswerDelivered,
  clearAnsweredQuestionIndices,
  type AnsweredMap,
} from './planning-answer-idempotency';

// ── helpers ─────────────────────────────────────────────────────────────────

const QUESTION_JSON = JSON.stringify({ question: 'Q?', options: [{ id: 'A', label: 'Option A' }], recommended: 'A' });

function seedTask(opts: {
  planningMessages?: string | null;
  answeredQuestionIndices?: string | null;
  sessionKey?: string | null;
} = {}): string {
  const taskId = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, description, status, workspace_id, planning_session_key, planning_messages, answered_question_indices, created_at, updated_at)
     VALUES (?, 'P016 Test', 'test task', 'planning', 'default', ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      taskId,
      opts.sessionKey === undefined ? `agent:main:planning:${taskId}` : opts.sessionKey,
      opts.planningMessages === undefined
        ? JSON.stringify([
            { role: 'user', content: 'PLANNING REQUEST', timestamp: 1 },
            { role: 'assistant', content: QUESTION_JSON, timestamp: 2 },
          ])
        : opts.planningMessages,
      opts.answeredQuestionIndices === undefined ? null : opts.answeredQuestionIndices,
    ]
  );
  return taskId;
}

function getTask(taskId: string) {
  return queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [taskId])!;
}

function parsedMessages(taskId: string): Array<{ role: string; content: string; id?: string; timestamp?: number }> {
  const raw = getTask(taskId).planning_messages as string;
  return raw ? JSON.parse(raw) : [];
}

function userAnswerCount(taskId: string): number {
  return parsedMessages(taskId).filter((m) => m.role === 'user' && m.content !== 'PLANNING REQUEST').length;
}

// This test file shares the on-disk test DB with the other test files (npm test
// runs them sequentially against one .tmp DB). Seeded planning-status tasks
// would look "stalled" to the planning-watchdog sweep tests — remove them when
// this file's process exits.
after(() => {
  run('DELETE FROM tasks WHERE title = ?', ['P016 Test']);
});

// ── pure guard unit tests ───────────────────────────────────────────────────

test('normalizeAnswer: trims whitespace and lowercases', () => {
  assert.equal(normalizeAnswer('  Build From Source  '), 'build from source');
  assert.equal(normalizeAnswer('A'), 'a');
  assert.equal(normalizeAnswer(''), '');
  assert.equal(normalizeAnswer('  '), '');
});

test('hashQuestion: stable for same content, differs for different content', () => {
  const h1 = hashQuestion('What is your approach?');
  assert.equal(h1, hashQuestion('What is your approach?'));
  assert.notEqual(h1, hashQuestion('What is your other approach?'));
});

test('parseAnsweredMap: null / invalid JSON → empty map; valid JSON parsed', () => {
  assert.deepEqual(parseAnsweredMap(null), {});
  assert.deepEqual(parseAnsweredMap(undefined), {});
  assert.deepEqual(parseAnsweredMap('not json{{{'), {});
  const map = parseAnsweredMap('{"1":{"questionHash":"abc","answer":"a","messageId":"m1","delivered":true}}');
  assert.equal(map['1'].answer, 'a');
});

test('lastAssistantMessageIndex: last assistant message, -1 when none', () => {
  const messages = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: 'Q1' },
    { role: 'user', content: 'A' },
    { role: 'assistant', content: 'Q2' },
  ];
  assert.equal(lastAssistantMessageIndex(messages), 3);
  assert.equal(lastAssistantMessageIndex([{ role: 'user', content: 'x' }]), -1);
  assert.equal(lastAssistantMessageIndex([]), -1);
});

test('checkAnswerIdempotency: first answer → allowed', () => {
  const d = checkAnswerIdempotency({}, 1, hashQuestion('Q1'), 'Build from source');
  assert.equal(d.allowed, true);
  assert.equal(d.reason, 'first_answer');
});

test('checkAnswerIdempotency: same normalized answer → idempotent (case/whitespace tolerant)', () => {
  const map: AnsweredMap = { '1': { questionHash: hashQuestion('Q1'), answer: 'build from source', messageId: 'm1', delivered: true } };
  const d = checkAnswerIdempotency(map, 1, hashQuestion('Q1'), '  Build From Source  ');
  assert.equal(d.allowed, true);
  assert.equal(d.reason, 'idempotent');
  assert.equal(d.normalizedExisting, 'build from source');
  assert.equal(d.normalizedSubmitted, 'build from source');
});

test('checkAnswerIdempotency: different answer → conflict', () => {
  const map: AnsweredMap = { '1': { questionHash: hashQuestion('Q1'), answer: 'build from source', messageId: 'm1', delivered: true } };
  const d = checkAnswerIdempotency(map, 1, hashQuestion('Q1'), 'use docker');
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'conflict');
  assert.equal(d.normalizedExisting, 'build from source');
  assert.equal(d.normalizedSubmitted, 'use docker');
});

test('checkAnswerIdempotency: same index but DIFFERENT question content → first_answer (stale record)', () => {
  // Session restart re-asks a different question at the same index — old record
  // must not block the new question.
  const map: AnsweredMap = { '1': { questionHash: hashQuestion('Old Q'), answer: 'a', messageId: 'm1', delivered: true } };
  const d = checkAnswerIdempotency(map, 1, hashQuestion('New Q'), 'b');
  assert.equal(d.allowed, true);
  assert.equal(d.reason, 'first_answer');
});

// ── integration: appendAnswerWithGuard ──────────────────────────────────────

test('first answer → ok: appended to planning_messages + index recorded (delivered=false)', () => {
  const taskId = seedTask();
  const out = appendAnswerWithGuard({ taskId, answerValue: 'Build from source', answerText: 'Build from source' });
  assert.equal(out.status, 'ok');
  if (out.status !== 'ok') return;
  assert.equal(out.questionIndex, 1);
  assert.equal(userAnswerCount(taskId), 1);
  assert.ok(out.message.id, 'appended message has an id');

  const map = parseAnsweredMap(getTask(taskId).answered_question_indices as string);
  const rec = map['1'];
  assert.ok(rec, 'question index recorded');
  assert.equal(rec.answer, 'build from source');
  assert.equal(rec.delivered, false);
  assert.equal(rec.messageId, out.message.id);
});

test('same answer (different case/whitespace) → idempotent, NO duplicate in planning_messages', () => {
  const taskId = seedTask();
  appendAnswerWithGuard({ taskId, answerValue: 'Build from source', answerText: 'Build from source' });

  const out2 = appendAnswerWithGuard({ taskId, answerValue: '  BUILD   from SOURCE ', answerText: '  BUILD   from SOURCE ' });
  assert.equal(out2.status, 'idempotent');
  if (out2.status !== 'idempotent') return;
  assert.equal(out2.existing.messageId, (parseAnsweredMap(getTask(taskId).answered_question_indices as string)['1']).messageId);
  assert.equal(userAnswerCount(taskId), 1, 'exactly one answer in planning_messages');
});

test('different answer → conflict, body fields present, NO append', () => {
  const taskId = seedTask();
  appendAnswerWithGuard({ taskId, answerValue: 'A', answerText: 'A' });

  const out = appendAnswerWithGuard({ taskId, answerValue: 'C', answerText: 'C' });
  assert.equal(out.status, 'conflict');
  if (out.status !== 'conflict') return;
  assert.equal(out.normalizedExisting, 'a');
  assert.equal(out.normalizedSubmitted, 'c');
  assert.equal(userAnswerCount(taskId), 1, 'conflict must not append');
});

test('driver-restart simulation: fresh in-memory state, same DB → only first answer stored', () => {
  const taskId = seedTask();
  // "Run 1" of the driver: answers Q with A.
  appendAnswerWithGuard({ taskId, answerValue: 'A', answerText: 'A' });

  // "Run 2" of the driver (restarted, in-memory state lost): retries the SAME
  // question with the SAME value → idempotent, not appended again.
  const retry = appendAnswerWithGuard({ taskId, answerValue: 'A', answerText: 'A' });
  assert.equal(retry.status, 'idempotent');
  assert.equal(userAnswerCount(taskId), 1);

  // A restarted driver that "remembers" a DIFFERENT value (the P009 A/C/B case)
  // → conflict, rejected.
  const badRetry = appendAnswerWithGuard({ taskId, answerValue: 'B', answerText: 'B' });
  assert.equal(badRetry.status, 'conflict');
  assert.equal(userAnswerCount(taskId), 1, 'multi-answer prevented');
});

test('concurrent requests for the same question → only one answer appended', () => {
  const taskId = seedTask();
  // better-sqlite3 serializes transactions; two overlapping requests are
  // equivalent to two sequential guarded appends — exactly one may be 'ok'.
  const first = appendAnswerWithGuard({ taskId, answerValue: 'A', answerText: 'A' });
  const second = appendAnswerWithGuard({ taskId, answerValue: 'A', answerText: 'A' });
  const okCount = [first, second].filter((o) => o.status === 'ok').length;
  assert.equal(okCount, 1, 'exactly one request appended');
  assert.equal(userAnswerCount(taskId), 1);
});

test('auto-answer loop regression (P010 BUG-1 scenario): 10 iterations, frozen log → exactly 1 append', () => {
  // MRN-104 pattern: the agent never responds, so every loop iteration finds
  // the SAME pending question. The DB guard must append exactly once.
  const taskId = seedTask();
  let ok = 0;
  for (let i = 0; i < 10; i++) {
    const out = appendAnswerWithGuard({ taskId, answerValue: 'A', answerText: 'A' });
    if (out.status === 'ok') ok++;
  }
  assert.equal(ok, 1, 'exactly one append across 10 iterations');
  assert.equal(userAnswerCount(taskId), 1);
});

test('auto-answer: growing log → one append per NEW question', () => {
  const taskId = seedTask();
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    const out = appendAnswerWithGuard({ taskId, answerValue: `A${i}`, answerText: `A${i}` });
    if (out.status === 'ok') ok++;
    // Agent responds: a NEW assistant question is appended (the answer was
    // already appended by the guard).
    const msgs = parsedMessages(taskId);
    msgs.push({ role: 'assistant', content: JSON.stringify({ question: `Q${i + 1}?`, options: [{ id: 'A', label: 'x' }] }), timestamp: Date.now() });
    run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(msgs), taskId]);
  }
  assert.equal(ok, 5, 'every new question answered exactly once');
  // Each answered question has its own index key.
  const map = parseAnsweredMap(getTask(taskId).answered_question_indices as string);
  assert.deepEqual(Object.keys(map).sort(), ['1', '3', '5', '7', '9']);
});

test('explicit questionIndex retry (client-persisted) → idempotent/conflict resolved', () => {
  const taskId = seedTask();
  const first = appendAnswerWithGuard({ taskId, questionIndex: 1, answerValue: 'A', answerText: 'A' });
  assert.equal(first.status, 'ok');

  // Driver restarts and retries with the persisted index + same answer.
  const retry = appendAnswerWithGuard({ taskId, questionIndex: 1, answerValue: 'a', answerText: 'a' });
  assert.equal(retry.status, 'idempotent');

  // Driver restarts with the persisted index + DIFFERENT answer.
  const bad = appendAnswerWithGuard({ taskId, questionIndex: 1, answerValue: 'C', answerText: 'C' });
  assert.equal(bad.status, 'conflict');
  assert.equal(userAnswerCount(taskId), 1);
});

test('error cases: task not found / invalid questionIndex / no pending question', () => {
  const missing = appendAnswerWithGuard({ taskId: 'no-such-task', answerValue: 'A', answerText: 'A' });
  assert.equal(missing.status, 'task_not_found');

  const taskId = seedTask();
  assert.equal(appendAnswerWithGuard({ taskId, questionIndex: -1, answerValue: 'A', answerText: 'A' }).status, 'invalid_index');
  assert.equal(appendAnswerWithGuard({ taskId, questionIndex: 1.5, answerValue: 'A', answerText: 'A' }).status, 'invalid_index');
  assert.equal(appendAnswerWithGuard({ taskId, questionIndex: 99, answerValue: 'A', answerText: 'A' }).status, 'invalid_index');
  assert.equal(appendAnswerWithGuard({ taskId, questionIndex: 0, answerValue: 'A', answerText: 'A' }).status, 'invalid_index', 'index 0 is the user prompt, not a question');

  const noQuestion = seedTask({
    planningMessages: JSON.stringify([{ role: 'user', content: 'PLANNING REQUEST', timestamp: 1 }]),
  });
  assert.equal(appendAnswerWithGuard({ taskId: noQuestion, answerValue: 'A', answerText: 'A' }).status, 'no_question');
});

test('markAnswerDelivered: flips delivered only for the matching messageId', () => {
  const taskId = seedTask();
  const out = appendAnswerWithGuard({ taskId, answerValue: 'A', answerText: 'A' });
  assert.equal(out.status, 'ok');
  if (out.status !== 'ok') return;

  let rec = parseAnsweredMap(getTask(taskId).answered_question_indices as string)['1'];
  assert.equal(rec.delivered, false);

  markAnswerDelivered(taskId, 1, 'wrong-message-id');
  rec = parseAnsweredMap(getTask(taskId).answered_question_indices as string)['1'];
  assert.equal(rec.delivered, false, 'stale messageId must not flip the flag');

  markAnswerDelivered(taskId, 1, out.message.id);
  rec = parseAnsweredMap(getTask(taskId).answered_question_indices as string)['1'];
  assert.equal(rec.delivered, true);
});

test('clearAnsweredQuestionIndices: resets tracking (session restart semantics)', () => {
  const taskId = seedTask();
  appendAnswerWithGuard({ taskId, answerValue: 'A', answerText: 'A' });
  assert.ok(getTask(taskId).answered_question_indices);

  clearAnsweredQuestionIndices(taskId);
  assert.equal(getTask(taskId).answered_question_indices, null);

  // After a session restart the same question can be answered again.
  const again = appendAnswerWithGuard({ taskId, answerValue: 'A', answerText: 'A' });
  assert.equal(again.status, 'ok');
});

test('stale question at same index (session restart, different question) → answerable', () => {
  const taskId = seedTask();
  appendAnswerWithGuard({ taskId, answerValue: 'A', answerText: 'A' });

  // Session restarted; the agent re-asks a DIFFERENT question at index 1.
  const msgs = parsedMessages(taskId);
  msgs[1] = { role: 'assistant', content: JSON.stringify({ question: 'Completely different Q?', options: [{ id: 'B', label: 'y' }] }), timestamp: 3 };
  run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(msgs), taskId]);

  const out = appendAnswerWithGuard({ taskId, answerValue: 'B', answerText: 'B' });
  assert.equal(out.status, 'ok', 'different question at same index must not be blocked by the old record');
});
