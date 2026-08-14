import { test } from 'node:test';
import assert from 'node:assert';
import { extractJSON, isTruncatedContent, parsePlanningPayload } from './planning-utils';

// PLATFORM-001 regression: planning completion truncation handling
test('extractJSON parses plain JSON', () => {
  const r = extractJSON('{"status":"complete"}');
  assert.deepEqual(r, { status: 'complete' });
});

test('extractJSON parses fenced json block', () => {
  const r = extractJSON('```json\n{"status":"complete","spec":{"title":"x"}}\n```') as { status?: string } | null;
  assert.equal(r?.status, 'complete');
});

test('extractJSON returns null for truncated content', () => {
  const r = extractJSON('```json\n{"status":"complete","spec":{"title":"x"},\n...(truncated)...');
  assert.equal(r, null);
});

test('extractJSON returns null for garbage', () => {
  assert.equal(extractJSON('not json at all'), null);
});

test('isTruncatedContent detects (truncated) marker', () => {
  assert.equal(isTruncatedContent('{"a":1}\n...(truncated)...'), true);
});

test('isTruncatedContent detects unclosed fenced JSON', () => {
  assert.equal(isTruncatedContent('```json\n{"a":1'), true);
});

test('isTruncatedContent detects opened brace without closing brace', () => {
  assert.equal(isTruncatedContent('{"status":"complete","spec":'), true);
});

test('isTruncatedContent false for valid content', () => {
  assert.equal(isTruncatedContent('{"status":"complete","spec":{}}'), false);
  assert.equal(isTruncatedContent('```json\n{"a":1}\n```'), false);
});

test('isTruncatedContent false for empty/whitespace', () => {
  assert.equal(isTruncatedContent(''), false);
  assert.equal(isTruncatedContent('   '), false);
});

// ── KESULTANAN-FIX-001: parsePlanningPayload + hardened extractJSON ──────────
// Incident: MRN-106 (2026-08-06 16:55 UTC) — planning agent replied with JSON
// without a code fence / mixed prose / trailing garbage; auto-answer stalled
// with invalid_json (iterations 34 & 42) instead of retrying the parse.

const QUESTION_PAYLOAD = {
  question: 'Apakah pendekatan ini paling aman?',
  options: [
    { id: 'A', label: 'Ya' },
    { id: 'B', label: 'Tidak' },
  ],
  recommended: 'A',
  recommended_reason: 'Paling rendah risiko',
};

const COMPLETE_PAYLOAD = {
  status: 'complete',
  spec: { summary: 'Selesai' },
};

// Case 1: direct JSON without any code fence (the MRN-106 failure pattern)
test('parsePlanningPayload accepts bare JSON without code fence', () => {
  const r = parsePlanningPayload(JSON.stringify(QUESTION_PAYLOAD));
  assert.ok(r, 'bare JSON must parse');
  assert.equal(r.question, QUESTION_PAYLOAD.question);
  assert.deepEqual(r.options, QUESTION_PAYLOAD.options);
});

// Case 2: fenced ```json block
test('parsePlanningPayload accepts fenced json block', () => {
  const r = parsePlanningPayload('```json\n' + JSON.stringify(QUESTION_PAYLOAD) + '\n```');
  assert.ok(r, 'fenced JSON must parse');
  assert.equal(r.question, QUESTION_PAYLOAD.question);
});

// Case 3: mixed prose + trailing garbage after the JSON object
// (balanced-brace scan recovers the object; first-{/last-} alone would fail
// because the slice spans past the closing brace)
test('parsePlanningPayload recovers JSON from mixed prose + trailing garbage', () => {
  const text =
    'Baik, berikut jawaban saya:\n' +
    JSON.stringify(QUESTION_PAYLOAD) +
    '\nSemoga membantu! (catatan: jangan lupa {periksa} langkah 3)';
  const r = parsePlanningPayload(text);
  assert.ok(r, 'mixed prose + trailing garbage must parse');
  assert.equal(r.question, QUESTION_PAYLOAD.question);
  assert.equal(r.options.length, 2);
});

// Completion status without a fence, with trailing text
test('parsePlanningPayload accepts completion status in prose', () => {
  const r = parsePlanningPayload('Ini hasilnya: ' + JSON.stringify(COMPLETE_PAYLOAD) + ' — selesai!');
  assert.ok(r, 'completion payload in prose must parse');
  assert.equal(r.status, 'complete');
});

// Null case: JSON truncated mid-string stays null → caller stalls (no silent
// data corruption / auto-repair)
test('parsePlanningPayload returns null for JSON truncated mid-string', () => {
  const truncated = '{"question":"Apakah ini oke?","options":[{"id":"A","label":"Terpotong';
  assert.equal(parsePlanningPayload(truncated), null);
  assert.equal(extractJSON(truncated), null);
});

// Null case: truncated inside a nested object
test('parsePlanningPayload returns null for JSON truncated mid-object', () => {
  const truncated = '{"status":"complete","spec":{"summary":"Terpot';
  assert.equal(parsePlanningPayload(truncated), null);
  assert.equal(extractJSON(truncated), null);
});

// Invalid shape: valid JSON but not a planning payload
test('parsePlanningPayload rejects valid JSON without question/status shape', () => {
  assert.equal(parsePlanningPayload('{"foo":"bar","nested":{"x":1}}'), null);
  assert.equal(parsePlanningPayload('{"options":[{"id":"A"}]}'), null); // options w/o question
  assert.equal(parsePlanningPayload('{"question":"q"}'), null); // question w/o options
  assert.equal(parsePlanningPayload('[1,2,3]'), null); // array is not a planning payload
});

// extractJSON stays backward-compatible: still returns the FIRST valid JSON
// object, even when a stray balanced-but-invalid region precedes the real one
test('extractJSON balanced-brace scan skips stray non-JSON braces', () => {
  const text = 'prefix {bukan json} lalu ' + JSON.stringify(QUESTION_PAYLOAD) + ' tail';
  const r = extractJSON(text) as { question?: string } | null;
  assert.ok(r);
  assert.equal(r.question, QUESTION_PAYLOAD.question);
});

// Braces inside strings must not confuse the balanced-brace scan
test('extractJSON balanced-brace scan respects braces inside strings', () => {
  const text = '{"status":"complete","note":"brace { di dalam string } ok"} trailing';
  const r = extractJSON(text) as { status?: string } | null;
  assert.ok(r);
  assert.equal(r.status, 'complete');
});

// MRN-106 regression sample (reconstructed from the documented failure mode:
// planning agent replied with bare JSON + prose/truncation at iterations 34/42)
test('parsePlanningPayload handles MRN-106-style response without stalling', () => {
  // Style A: bare JSON with leading prose (what the incident iterations saw)
  const styleA = 'Saya akan jawab. ' + JSON.stringify(QUESTION_PAYLOAD);
  const rA = parsePlanningPayload(styleA);
  assert.ok(rA, 'MRN-106 style A (prose + bare JSON) must parse');
  assert.equal(rA.question, QUESTION_PAYLOAD.question);

  // Style B: JSON followed by closing remarks (trailing garbage)
  const styleB = JSON.stringify(COMPLETE_PAYLOAD) + '\n\nTerima kasih atas pertanyaannya.';
  const rB = parsePlanningPayload(styleB);
  assert.ok(rB, 'MRN-106 style B (JSON + trailing prose) must parse');
  assert.equal(rB.status, 'complete');

  // Style C: genuinely truncated mid-string → still null → stall (correct)
  const styleC = '{"question":"Apakah ini oke?","options":[{"id":"A","label":"..."';
  assert.equal(parsePlanningPayload(styleC), null, 'MRN-106 style C (truncated) must stay null');
});

// ReDoS guard regression: 1MB cap is preserved; oversized input returns null
// quickly without hanging (the balanced-brace scan is single-pass).
test('extractJSON respects MAX_EXTRACT_JSON_LENGTH guard with brace-heavy input', () => {
  const big = '{"a":"' + 'x'.repeat(500_000) + '"}' + '{'.repeat(600_000);
  assert.ok(big.length > 1_000_000);
  const start = Date.now();
  assert.equal(extractJSON(big), null);
  assert.ok(Date.now() - start < 5_000, 'oversized input must bail out quickly');
});
