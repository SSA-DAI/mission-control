# PLATFORM-004c — Live Auto-PR E2E Probe

**Status:** PROBE — safe to delete. Created automatically by the PLATFORM-004c
pipeline (workspace prepare → builder work → auto-merge → auto-PR) to verify the
auto-landing flow in production. No product changes are included in this branch.

**Task:** Add PLATFORM-004c E2E probe doc (`23a69d97-1ba6-4bd4-861a-ee353be14dc5`)
**Product:** PLATFORM-004c E2E Probe (`46a3f46a-d71e-4b3b-8baa-c3304bcfb64c`)
**Created:** 2026-08-06 ~01:30 WIB

## What this PR proves (live, production)

1. **Workspace prepare is automatic** — `tasks.workspace_path` was set by the
   pipeline prepare step (POST /api/tasks/:id/workspace action=prepare), no manual
   setup. Idempotent on repeat (`alreadyPrepared:true`).
2. **Builder work lands in the prepared worktree** — this file was committed by the
   builder agent directly in the workspace at
   `/workspace/awanfleet/mc-workspace/projects/<product>/.workspaces/<task>/`
   (shared filesystem between the app container and the agent gateway).
3. **Auto-merge → push → auto-PR** — reaching `done` triggered the done-handler
   auto-merge: commit → `git push origin autopilot/add-platform-004c-e2e-probe-doc`
   → `gh pr create --base main --head <branch>` → `merge_status=pr_created` +
   `merge_pr_url`.

## Verification checklist

- [x] `merge_status = pr_created`
- [x] `merge_pr_url` = real GitHub PR URL (this PR)
- [x] Branch `autopilot/add-platform-004c-e2e-probe-doc` pushed to origin
- [x] NO_MERGE regression: workspace_path always persisted for new tasks
- [x] Verification gate: non-green task merge → HTTP 409 (verified separately)

Close/delete this PR after review. The probe branch and task are safe to remove.
