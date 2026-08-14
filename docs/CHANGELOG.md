# CHANGELOG

## KESULTANAN-FIX-004 — Planning driver restart detection (2026-08-14)

- `docs/planning-driver.js`: the skip/reset decision is now a pure, exported
  function `shouldSkipOrReset(questions, messages, answeredIndices,
  lastAnsweredIndex, historyFingerprint)` (plus `makeFingerprint`,
  `fingerprintQuestions`, `parseAnsweredMap`, `hashQuestion`). The CLI loop is
  preserved behind a `require.main` guard and still answers ONE question per
  iteration (PLATFORM-013).
- Restart detection (fixes MRN-203: watchdog P014 restarted planning, the new
  session started at index 0, and a fresh question at index 1 was skipped
  because the in-memory `lastAnsweredIndex` was stale, e.g. 9): the driver
  fingerprints the observed history (`{length, hash, answeredCount}`) and
  resets `lastAnsweredIndex = -1` when (1) `planning_messages` shrank below the
  cursor, (2) the previously seen questions are no longer a prefix of the
  current ones (content replaced), or (3) the server cleared
  `answered_question_indices` (documented PLATFORM-016 restart signature).
- Source of truth: a question is skipped only when `answered_question_indices`
  records it with the same question hash — not just `index > lastAnsweredIndex`
  — so questions re-asked at low indices after a restart are answered
  automatically. Answers now carry `questionIndex` so the server-side
  idempotency guard (200 idempotent / 409 conflict) applies to the exact
  targeted question.
- `docs/planning-driver.test.js`: deterministic assert-based unit tests (no
  framework) covering stale index, restart with length drop, hash change,
  map-cleared restart, no re-answer of answered questions, append-not-restart,
  and the MRN-203 replay. 15/15 pass. No commit/push — left dirty for review.

## PLATFORM-022 Companion Patches (2026-08-06)

### B1: Session sync on task done
- `src/app/api/tasks/[id]/route.ts`: When a task transitions to 'done', all active
  `openclaw_sessions` for that task are now ended (status='ended', ended_at, updated_at).
  Prevents "zombie" sessions from remaining active after task completion.

### B2: Verifier multi-environment verification
- `src/lib/task-dispatch-context.ts`: Verifier completion contract now includes
  instructions to verify in at least 2 environments (with/without env vars).
- `docs/AGENT_PROTOCOL.md`: Added "Verifier Checklist" section documenting the
  multi-env verification requirement.

### B3: Deliverable warning log level
- `src/app/api/tasks/[id]/deliverables/route.ts`: Changed `console.warn` to
  `console.log` for non-existent file warning (keeps HTTP response body warning).

### B4: Planning driver documentation
- `docs/planning-driver.js`: Canonical copy of the planning driver with the
  `tryParseQuestion` fix — handles planning agent JSON responses without code fences
  (direct parse → ```json fence → first-{ to last-} fallback).
