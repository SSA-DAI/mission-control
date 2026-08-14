#!/usr/bin/env node
/* p013-driver.js — planning driver: poll -> answer recommended until complete.
 * Usage: node p013-driver.js <task-id> [max-iter] [interval-ms]
 * API via .openclaw/tmp/mc.sh (dynamic container lookup).
 *
 * KESULTANAN-FIX-004: the driver no longer relies on the in-memory
 * lastAnsweredIndex alone. A planning-session restart (watchdog P014) resets
 * planning_messages to index 0 and clears answered_question_indices, so a
 * question at a LOW index (e.g. 1) was skipped by the old
 * `index > lastAnsweredIndex` guard (1 > 9 = false) → planning stalled until a
 * manual driver restart. Two layers fix this:
 *   1. Restart detection: the pure decision shouldSkipOrReset() fingerprints
 *      the observed planning history ({length, hash, answeredCount}) and
 *      resets lastAnsweredIndex = -1 when the history was replaced, dropped,
 *      or its answered map was cleared by the server.
 *   2. Source of truth: answered_question_indices (PLATFORM-016) decides which
 *      questions are already answered instead of the index cursor alone, and
 *      answers carry questionIndex so the server-side idempotency guard
 *      applies to the exact targeted question.
 */
const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

/* ------------------------------------------------------------------ *
 * Pure decision helpers (no IO, no mutable state, no Date) — exported for
 * the deterministic unit tests in docs/planning-driver.test.js. The CLI
 * loop below only calls them with data fetched from a single task snapshot.
 * ------------------------------------------------------------------ */

/**
 * sha256 (16 hex chars) of a question's raw content. Mirrors the server-side
 * hashQuestion() in src/lib/planning-answer-idempotency.ts so the driver and
 * the server agree on "same question at same index".
 * @param {string} content raw assistant message content
 * @returns {string} 16-hex hash
 */
function hashQuestion(content) {
  return crypto.createHash('sha256').update(String(content ?? '')).digest('hex').slice(0, 16);
}

/**
 * Stable fingerprint of the questions extracted from planning_messages.
 * Normalized to [index, content] pairs so it is insensitive to JSON key order
 * inside the parsed question object. Changes when a question is added,
 * removed, or its content changes (including a planning-session restart).
 * @param {Array<{index:number, content?:string}>} questions
 * @returns {string} full sha256 hex
 */
function fingerprintQuestions(questions) {
  const list = Array.isArray(questions) ? questions : [];
  const norm = list.map((item) => [item.index, String(item.content ?? '')]);
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

/**
 * Parse tasks.answered_question_indices (JSON string, object, null/undefined)
 * into the PLATFORM-016 answered map { "<index>": { questionHash, answer,
 * messageId, delivered } }. Corrupt JSON or unexpected shapes → empty map.
 * @param {*} raw
 * @returns {Record<string, {questionHash?: string, answer?: string}>}
 */
function parseAnsweredMap(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // corrupt JSON must not break the driver — treat as empty map
    }
  }
  return {};
}

/**
 * Is the question at `index` already answered? Mirrors the server guard in
 * checkAnswerIdempotency(): answered with the SAME question hash → skip;
 * different hash (the question was re-asked after a restart) → answerable.
 * @param {number} index question position in planning_messages
 * @param {string} content raw question content
 * @param {Record<string, {questionHash?: string}>} answeredMap
 * @returns {boolean}
 */
function shouldSkipQuestion(index, content, answeredMap) {
  const rec = answeredMap[String(index)];
  if (!rec) return false;
  return rec.questionHash === hashQuestion(content);
}

/**
 * Snapshot of the observed planning state, persisted across loop iterations
 * to detect restarts. Pure: derived only from the two arguments.
 * @param {Array<{index:number, content?:string}>} questions
 * @param {*} answeredIndices raw tasks.answered_question_indices
 * @returns {{length: number, hash: string, answeredCount: number}}
 */
function makeFingerprint(questions, answeredIndices) {
  const qs = Array.isArray(questions) ? questions : [];
  return {
    length: qs.length,
    hash: fingerprintQuestions(qs),
    answeredCount: Object.keys(parseAnsweredMap(answeredIndices)).length,
  };
}

/**
 * Pure decision: should the in-memory cursor be reset (restart detected) and
 * which question (if any) should be answered this iteration?
 *
 * Restart detection (all comparisons against the previous fingerprint captured
 * from the previous task snapshot — never mixed across requests):
 *   1. length rule — planning_messages shrank below the answered cursor
 *      (watchdog reset the session → new messages start from index 0);
 *   2. hash rule — the previously seen questions are no longer a PREFIX of the
 *      current ones (content was replaced by a new session; an append in the
 *      same session keeps the prefix intact, so it does NOT reset);
 *   3. answered-map rule — the server cleared answered_question_indices
 *      (documented PLATFORM-016 signature of a planning-session restart).
 *
 * @param {Array<{index:number, q:object, content?:string}>} questions questions extracted from planning_messages
 * @param {Array<{role?:string, content?:string}>} messages raw planning_messages array
 * @param {*} answeredIndices raw tasks.answered_question_indices
 * @param {number} lastAnsweredIndex in-memory cursor from the previous iteration
 * @param {({length:number, hash:string, answeredCount:number}|null)} historyFingerprint previous snapshot, or null on first run
 * @returns {{reset: boolean, next: ({index:number, q:object, content?:string}|null)}}
 */
function shouldSkipOrReset(questions, messages, answeredIndices, lastAnsweredIndex, historyFingerprint) {
  const qs = Array.isArray(questions) ? questions : [];
  const msgs = Array.isArray(messages) ? messages : [];
  const answeredMap = parseAnsweredMap(answeredIndices);

  let reset = false;
  if (historyFingerprint && typeof historyFingerprint === 'object') {
    const prevLen = Number(historyFingerprint.length) || 0;
    if (msgs.length < lastAnsweredIndex) {
      // planning_messages dropped below the answered cursor → new session
      reset = true;
    } else if (historyFingerprint.hash && fingerprintQuestions(qs.slice(0, prevLen)) !== historyFingerprint.hash) {
      // previously seen questions no longer a prefix → content replaced
      reset = true;
    } else if ((Number(historyFingerprint.answeredCount) || 0) > 0 && Object.keys(answeredMap).length === 0) {
      // answered map cleared by the server (restart signature)
      reset = true;
    }
  }

  // After a reset the index cursor must not block low-index questions from the
  // new session; answered_question_indices remains the source of truth either
  // way, so answered questions are never re-answered (PLATFORM-016 idempotent).
  const cursor = reset ? -1 : lastAnsweredIndex;
  const next = qs.find((item) => item.index > cursor && !shouldSkipQuestion(item.index, item.content, answeredMap)) || null;
  return { reset, next };
}

module.exports = { hashQuestion, fingerprintQuestions, parseAnsweredMap, makeFingerprint, shouldSkipOrReset };

/* ------------------------------------------------------------------ *
 * CLI loop — only runs when executed directly (require.main guard, so the
 * unit tests can import the pure helpers without starting the loop).
 * ------------------------------------------------------------------ */
if (require.main === module) {
  const TASK = process.argv[2];
  const MAX_ITER = parseInt(process.argv[3] || '80', 10);
  const INTERVAL = parseInt(process.argv[4] || '15000', 10);
  const MC_SH = path.join(__dirname, 'mc.sh');

  function mc(method, p, bodyFile) {
    const args = [MC_SH, method, p];
    if (bodyFile) args.push(bodyFile);
    return execSync(args.join(' '), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  }

  function getTask() {
    const raw = mc('GET', `/api/tasks/${TASK}`);
    const d = JSON.parse(raw);
    return d.task || d.data || d;
  }

  function tryParseQuestion(content) {
    // 1) direct parse
    try { const q = JSON.parse(content.trim()); if (q && q.question) return q; } catch {}
    // 2) code fence (existing)
    const m = content.match(/```json\n([\s\S]*?)```/);
    if (m) { try { const q = JSON.parse(m[1]); if (q && q.question) return q; } catch {} }
    // 3) bare JSON object: first { to last }
    const a = content.indexOf('{'); const b = content.lastIndexOf('}');
    if (a !== -1 && b > a) { try { const q = JSON.parse(content.slice(a, b + 1)); if (q && q.question) return q; } catch {} }
    return null;
  }

  function getMessages(t) {
    let msgs = t.planning_messages || [];
    if (typeof msgs === 'string') { try { msgs = JSON.parse(msgs); } catch { msgs = []; } }
    return Array.isArray(msgs) ? msgs : [];
  }

  function extractQuestions(messages) {
    const out = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || m.role !== 'assistant') continue;
      const rawContent = String(m.content || '');
      const q = tryParseQuestion(rawContent);
      if (q) out.push({ index: i, q, content: rawContent });
    }
    return out;
  }

  let lastAnsweredIndex = -1;
  let historyFingerprint = null;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let t;
    try {
      // Sync planning_messages from the gateway (the poll route is what copies
      // assistant messages into the task row — without it the driver never sees
      // the agent's questions).
      try { mc('GET', `/api/tasks/${TASK}/planning/poll`); } catch (e) { console.log(`[driver] poll sync error: ${String(e.message).slice(0, 120)}`); }
      t = getTask();
    } catch (e) { console.log(`[driver] iter ${iter}: fetch error ${String(e.message).slice(0, 150)}`); wait(INTERVAL); continue; }
    if (t.planning_complete === 1 || t.planning_complete === true) {
      console.log(`[driver] PLANNING COMPLETE. status=${t.status} assigned=${t.assigned_agent_id || ''}`);
      if (t.planning_spec) console.log(`[driver] spec head: ${String(t.planning_spec).slice(0, 500)}`);
      process.exit(0);
    }
    // messages/questions/historyFingerprint all derive from the SAME task
    // snapshot (single getTask call) — no cross-request race.
    const messages = getMessages(t);
    const questions = extractQuestions(messages);
    const decision = shouldSkipOrReset(questions, messages, t.answered_question_indices, lastAnsweredIndex, historyFingerprint);
    if (decision.reset) {
      console.log(`[driver] planning history restart detected (was lastAnsweredIndex=${lastAnsweredIndex}) — resetting cursor to -1`);
      lastAnsweredIndex = -1;
    }
    let answeredAny = false;
    // PLATFORM-013 lesson: never answer two questions back-to-back — the second
    // chat.send lands while the agent's turn for the first answer is still
    // running → EmbeddedAttemptSessionTakeoverError kills the turn. Answer ONE
    // question per iteration and wait for the agent to go idle.
    if (decision.next) {
      const item = decision.next;
      const rec = item.q.recommended || 'other';
      console.log(`[driver] Q@${item.index}: ${String(item.q.question).slice(0, 160)}`);
      console.log(`[driver]   -> answering recommended: ${rec}`);
      try {
        const bodyFile = path.join(os.tmpdir(), `p013-answer-${Date.now()}.json`);
        // questionIndex pins the exact question so the server-side PLATFORM-016
        // guard (idempotent 200 / conflict 409) applies to what we intended —
        // even if the agent posted a newer question while we were answering.
        fs.writeFileSync(bodyFile, JSON.stringify({ answer: rec, questionIndex: item.index }));
        const res = mc('POST', `/api/tasks/${TASK}/planning/answer`, bodyFile);
        fs.unlinkSync(bodyFile);
        const parsed = JSON.parse(res);
        console.log(`[driver]   answer POST ok: success=${parsed.success} msgs=${(parsed.messages || []).length}`);
        lastAnsweredIndex = item.index;
        answeredAny = true;
        // Cooldown after an answer: let the agent finish its turn before the
        // next poll may send another answer.
        wait(Math.min(INTERVAL, 8000));
      } catch (e) {
        console.log(`[driver]   answer POST FAILED: ${String(e.message).slice(0, 250)}`);
      }
    }
    historyFingerprint = makeFingerprint(questions, t.answered_question_indices);
    if (!answeredAny) {
      process.stdout.write(`[driver] iter ${iter}: status=${t.status || '?'} complete=${t.planning_complete} — waiting ${INTERVAL / 1000}s\n`);
    }
    wait(INTERVAL);
  }
  console.log('[driver] MAX_ITER reached without completion');
  process.exit(2);
}

function wait(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { execSync('sleep 2'); }
}
