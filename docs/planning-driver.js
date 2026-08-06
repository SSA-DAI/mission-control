#!/usr/bin/env node
/* p013-driver.js — planning driver: poll -> answer recommended until complete.
 * Usage: node p013-driver.js <task-id> [max-iter] [interval-ms]
 * API via .openclaw/tmp/mc.sh (dynamic container lookup).
 */
const { execSync } = require('child_process');
const path = require('path');

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

function extractQuestions(t) {
  let msgs = t.planning_messages || [];
  if (typeof msgs === 'string') { try { msgs = JSON.parse(msgs); } catch { msgs = []; } }
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant') continue;
    const q = tryParseQuestion(String(m.content || ''));
    if (q) out.push({ index: i, q });
  }
  return out;
}

let lastAnsweredIndex = -1;
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
  const questions = extractQuestions(t);
  let answeredAny = false;
  // PLATFORM-013 lesson: never answer two questions back-to-back — the second
  // chat.send lands while the agent's turn for the first answer is still
  // running → EmbeddedAttemptSessionTakeoverError kills the turn. Answer ONE
  // question per iteration and wait for the agent to go idle.
  const q = questions.find(item => item.index > lastAnsweredIndex);
  if (q) {
    const rec = q.q.recommended || 'other';
    console.log(`[driver] Q@${q.index}: ${String(q.q.question).slice(0, 160)}`);
    console.log(`[driver]   -> answering recommended: ${rec}`);
    try {
      const bodyFile = path.join(require('os').tmpdir(), `p013-answer-${Date.now()}.json`);
      require('fs').writeFileSync(bodyFile, JSON.stringify({ answer: rec }));
      const res = mc('POST', `/api/tasks/${TASK}/planning/answer`, bodyFile);
      require('fs').unlinkSync(bodyFile);
      const parsed = JSON.parse(res);
      console.log(`[driver]   answer POST ok: success=${parsed.success} msgs=${(parsed.messages || []).length}`);
      lastAnsweredIndex = q.index;
      answeredAny = true;
      // Cooldown after an answer: let the agent finish its turn before the
      // next poll may send another answer.
      wait(Math.min(INTERVAL, 8000));
    } catch (e) {
      console.log(`[driver]   answer POST FAILED: ${String(e.message).slice(0, 250)}`);
    }
  }
  if (!answeredAny) {
    process.stdout.write(`[driver] iter ${iter}: status=${t.status || '?'} complete=${t.planning_complete} — waiting ${INTERVAL / 1000}s\n`);
  }
  wait(INTERVAL);
}
console.log('[driver] MAX_ITER reached without completion');
process.exit(2);

function wait(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { execSync('sleep 2'); }
}
