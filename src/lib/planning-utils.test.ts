import { test } from 'node:test';
import assert from 'node:assert';
import { extractJSON, isTruncatedContent } from './planning-utils';

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
