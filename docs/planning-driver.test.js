#!/usr/bin/env node
/* docs/planning-driver.test.js — deterministic unit tests for the pure
 * decision helpers exported by planning-driver.js (KESULTANAN-FIX-004).
 *
 * Run: node docs/planning-driver.test.js
 * (assert-based, no framework; exits 0 on pass, 1 on failure)
 *
 * Covers the MRN-203 failure mode: after a watchdog (P014) restarts planning,
 * planning_messages starts fresh at index 0 while the driver's in-memory
 * lastAnsweredIndex is stale (e.g. 9) → a new question at index 1 was skipped
 * by the old `index > lastAnsweredIndex` guard. Also covers the PLATFORM-016
 * answered_question_indices source-of-truth semantics.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  hashQuestion,
  fingerprintQuestions,
  parseAnsweredMap,
  makeFingerprint,
  shouldSkipOrReset,
} = require('./planning-driver.js');

/* --- helpers ---------------------------------------------------------- */

const Q = (index, question, content) => ({ index, q: { question, recommended: 'A' }, content: content ?? question });
// planning_messages fixture: index 0 = user planning request, then assistant questions
const MSGS = (assistantContents) => [
  { role: 'user', content: 'PLANNING REQUEST', id: 'u0', timestamp: 1 },
  ...assistantContents.map((content, i) => ({ role: 'assistant', content, timestamp: 10 + i })),
];
const answeredRec = (content, answer = 'a') => ({ questionHash: hashQuestion(content), answer, messageId: 'm', delivered: true });

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`FAIL  ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
function done() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

/* --- 1. module load + CLI guard ---------------------------------------- */

test('module loads without executing the CLI loop and exports the pure helpers', () => {
  assert.strictEqual(typeof shouldSkipOrReset, 'function');
  assert.strictEqual(typeof makeFingerprint, 'function');
  assert.strictEqual(typeof fingerprintQuestions, 'function');
  assert.strictEqual(typeof parseAnsweredMap, 'function');
  assert.strictEqual(typeof hashQuestion, 'function');
});

/* --- 2. MRN-203 core: stale lastAnsweredIndex after restart ------------ */

test('stale index: lastAnsweredIndex=9, new session has 1 question at index 1 → reset + answer it', () => {
  const questions = [Q(1, 'New question after restart?')];
  const messages = MSGS(['New question after restart?']); // length 2 < 9
  const decision = shouldSkipOrReset(questions, messages, null, 9, makeFingerprint([Q(0, 'old q0'), Q(1, 'old q1')], {}));
  assert.strictEqual(decision.reset, true, 'restart must be detected');
  assert.ok(decision.next, 'a question must be picked');
  assert.strictEqual(decision.next.index, 1, 'the NEW low-index question must be answered');
});

test('restart with length drop below lastAnsweredIndex → reset and answer first question', () => {
  const questions = [Q(1, 'q1'), Q(2, 'q2')];
  const messages = MSGS(['q1', 'q2']); // length 3 < 5
  const decision = shouldSkipOrReset(questions, messages, {}, 5, makeFingerprint([Q(1, 'old')], {}));
  assert.strictEqual(decision.reset, true);
  assert.strictEqual(decision.next.index, 1);
});

/* --- 3. hash change (same length, content replaced) --------------------- */

test('hash change: same length but question content replaced → reset', () => {
  const prevQuestions = [Q(1, 'Old question')];
  const prevFp = makeFingerprint(prevQuestions, {});
  const questions = [Q(1, 'Completely different question')];
  const messages = MSGS(['Completely different question']); // length 2, not < 0
  const decision = shouldSkipOrReset(questions, messages, {}, 0, prevFp);
  assert.strictEqual(decision.reset, true, 'replaced content must be detected as restart');
  assert.strictEqual(decision.next.index, 1);
});

/* --- 4. answered_question_indices as source of truth -------------------- */

test('answered question (same hash) is NOT re-answered', () => {
  const questions = [Q(1, 'Already answered question')];
  const messages = MSGS(['Already answered question']);
  const answeredMap = { 1: answeredRec('Already answered question') };
  const decision = shouldSkipOrReset(questions, messages, answeredMap, -1, makeFingerprint(questions, answeredMap));
  assert.strictEqual(decision.reset, false);
  assert.strictEqual(decision.next, null, 'answered question must be skipped');
});

test('re-asked question at an answered index (different hash) IS answerable again', () => {
  const questions = [Q(1, 'New wording after restart')];
  const messages = MSGS(['New wording after restart']);
  const answeredMap = { 1: answeredRec('Old wording') }; // stale record per PLATFORM-016
  const decision = shouldSkipOrReset(questions, messages, answeredMap, -1, makeFingerprint(questions, answeredMap));
  assert.strictEqual(decision.reset, false);
  assert.ok(decision.next, 'stale-record question must be answerable');
  assert.strictEqual(decision.next.index, 1);
});

test('answered map cleared by server (restart signature) → reset even if content identical', () => {
  const content = 'Identical question text';
  const prevQuestions = [Q(1, content)];
  const prevAnsweredMap = { 1: answeredRec(content) };
  const prevFp = makeFingerprint(prevQuestions, prevAnsweredMap); // answeredCount = 1
  const questions = [Q(1, content)]; // byte-identical content
  const messages = MSGS([content]);
  const decision = shouldSkipOrReset(questions, messages, {}, 1, prevFp); // current map empty
  assert.strictEqual(decision.reset, true, 'map-cleared must reset even when length/hash look unchanged');
  assert.ok(decision.next, 'the re-asked question must be answered');
  assert.strictEqual(decision.next.index, 1);
});

/* --- 5. healthy session: no spurious reset ------------------------------ */

test('no change between iterations → no reset, nothing to answer', () => {
  const questions = [Q(1, 'q1')];
  const messages = MSGS(['q1']);
  const answeredMap = { 1: answeredRec('q1') };
  const fp = makeFingerprint(questions, answeredMap);
  const decision = shouldSkipOrReset(questions, messages, answeredMap, 1, fp);
  assert.strictEqual(decision.reset, false);
  assert.strictEqual(decision.next, null);
});

test('append in the SAME session (new question at higher index) → no restart reset, new question answered', () => {
  const prevQuestions = [Q(1, 'q1')];
  const prevAnsweredMap = { 1: answeredRec('q1') };
  const prevFp = makeFingerprint(prevQuestions, prevAnsweredMap);
  const questions = [Q(1, 'q1'), Q(2, 'q2')]; // q2 appended
  const messages = MSGS(['q1', 'q2']);
  const decision = shouldSkipOrReset(questions, messages, prevAnsweredMap, 1, prevFp);
  assert.strictEqual(decision.reset, false, 'an append must NOT be treated as a restart');
  assert.ok(decision.next);
  assert.strictEqual(decision.next.index, 2, 'only the new question should be picked');
});

test('first run (no fingerprint) → no reset; first unanswered question is picked', () => {
  const questions = [Q(1, 'q1'), Q(2, 'q2')];
  const messages = MSGS(['q1', 'q2']);
  const decision = shouldSkipOrReset(questions, messages, {}, -1, null);
  assert.strictEqual(decision.reset, false);
  assert.strictEqual(decision.next.index, 1);
});

/* --- 6. one answer per iteration + ordering ----------------------------- */

test('multiple unanswered questions → only the FIRST is returned (one answer per iteration)', () => {
  const questions = [Q(1, 'q1'), Q(2, 'q2'), Q(3, 'q3')];
  const messages = MSGS(['q1', 'q2', 'q3']);
  const decision = shouldSkipOrReset(questions, messages, {}, -1, null);
  assert.ok(decision.next, 'one question must be returned');
  assert.strictEqual(decision.next.index, 1);
  assert.deepStrictEqual(
    Object.keys(decision),
    ['reset', 'next'],
    'decision shape must be { reset, next } — never a list of questions'
  );
});

/* --- 7. helper robustness ----------------------------------------------- */

test('parseAnsweredMap handles string, object, null, corrupt JSON, and arrays', () => {
  assert.deepStrictEqual(parseAnsweredMap('{"1":{"questionHash":"abc","answer":"a"}}'), { 1: { questionHash: 'abc', answer: 'a' } });
  assert.deepStrictEqual(parseAnsweredMap({ 1: { questionHash: 'abc' } }), { 1: { questionHash: 'abc' } });
  assert.deepStrictEqual(parseAnsweredMap(null), {});
  assert.deepStrictEqual(parseAnsweredMap(undefined), {});
  assert.deepStrictEqual(parseAnsweredMap('{corrupt'), {});
  assert.deepStrictEqual(parseAnsweredMap([]), {});
  assert.deepStrictEqual(parseAnsweredMap('[1,2,3]'), {});
});

test('hashQuestion matches the server algorithm (sha256 slice(0,16)) and fingerprintQuestions is stable', () => {
  const expected = crypto.createHash('sha256').update('question content').digest('hex').slice(0, 16);
  assert.strictEqual(hashQuestion('question content'), expected);
  const a = [Q(1, 'q1'), Q(2, 'q2')];
  assert.strictEqual(fingerprintQuestions(a), fingerprintQuestions(a));
  // normalized: key order inside the parsed question object must not matter
  const b = [{ index: 1, q: { recommended: 'A', question: 'q1' }, content: 'q1' }, { index: 2, q: { question: 'q2', recommended: 'A' }, content: 'q2' }];
  assert.strictEqual(fingerprintQuestions(a), fingerprintQuestions(b));
  assert.notStrictEqual(fingerprintQuestions(a), fingerprintQuestions([Q(1, 'q1')]));
});

test('pure function determinism: same inputs → deep-equal results across calls', () => {
  const questions = [Q(1, 'q1'), Q(2, 'q2')];
  const messages = MSGS(['q1', 'q2']);
  const fp = makeFingerprint([Q(1, 'q1')], { 1: answeredRec('q1') });
  const first = shouldSkipOrReset(questions, messages, { 1: answeredRec('q1') }, 1, fp);
  const second = shouldSkipOrReset(questions, messages, { 1: answeredRec('q1') }, 1, fp);
  assert.deepStrictEqual(first, second);
});

/* --- 8. end-to-end scenario replay of the MRN-203 incident --------------- */

test('MRN-203 replay: pre-restart answered up to index 9 → restart → new Q@1 is answered automatically', () => {
  // Old session: 9 questions answered (indices 1..9), cursor at 9.
  const oldQuestions = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => Q(i, `old q${i}`));
  const oldAnsweredMap = {};
  for (const it of oldQuestions) oldAnsweredMap[it.index] = answeredRec(it.content);
  const prevFp = makeFingerprint(oldQuestions, oldAnsweredMap); // length 9, answeredCount 9

  // Watchdog restart: new planning session, fresh messages from index 0,
  // answered_question_indices cleared, one new assistant question at index 1.
  const newQuestions = [Q(1, 'Fresh question after restart')];
  const newMessages = MSGS(['Fresh question after restart']);
  const decision = shouldSkipOrReset(newQuestions, newMessages, {}, 9, prevFp);
  assert.strictEqual(decision.reset, true, 'restart must be detected despite stale cursor 9');
  assert.ok(decision.next);
  assert.strictEqual(decision.next.index, 1, 'the new low-index question must not be skipped');
});

done();
