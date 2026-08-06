# CHANGELOG

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
