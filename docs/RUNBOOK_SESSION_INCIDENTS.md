# RUNBOOK: Session Incidents

> **Audience:** Mission Control operators & platform engineers  
> **Last updated:** 2026-08-05  
> **Scope:** PLATFORM-010 (post-MRN-104)  

---

## Troubleshooting Quick Reference

| Symptom | SOP | Severity | Auto-detected? |
|---|---|---|---|
| Session marker "Memory flush writes are restricted" | [SOP-3](#sop-3-memory-flush--sandbox-corruption) | 🔴 Critical | ✅ Yes (A4 gate) |
| Task status "in_progress" but agent idle >10 min | [SOP-1](#sop-1-stalled-session) | 🟡 Degraded | ✅ Yes (stale check) |
| Token rate spike >1M/10min in activity feed | [SOP-4](#sop-4-token-meledak--flailing-agent) | 🟠 Warning | ✅ Yes (D2 alert) |
| Need to manually rotate to fresh session | [SOP-2](#sop-2-retry-fresh-session) | 🟡 Degraded | Manual trigger |

---

## SOP-1: Stalled Session

### Symptom
- Task status shows `in_progress` but the last agent activity is >10 minutes ago.
- The session status is `done` or `ended` but the task was never updated.
- No errors visible in the UI — the task just "hangs."

### Immediate Action
1. **Check the flight recorder:**  
   Open the task in Mission Control → click "Flight Recorder." Look at the last few messages. Is the agent waiting for something?
2. **Check agent health:**  
   Go to the Agents sidebar → find the assigned agent. Is its health state `stalled`, `stuck`, or `zombie`?
3. **Check session status:**  
   Open the Sessions list for the task. Is the session `ended` or `done` but task still `in_progress`?

### Root Cause
- The agent completed its work but the completion webhook was never delivered (broken WebSocket).
- The agent hit a tool error that it couldn't recover from and "died silently."
- The session was killed by the gateway but no termination event was broadcast.

### Resolution
1. **If the session is done and work is complete:**  
   Manually advance the task status:
   ```bash
   PATCH /api/tasks/:id  {"status": "testing"}
   ```
2. **If the session is done but work incomplete:**  
   Retry with a fresh session (see [SOP-2](#sop-2-retry-fresh-session)).
3. **If the agent is stuck:**  
   Nudge the agent via the UI (`POST /api/agents/:id/health/nudge`) or restart the task dispatch.

### Verification
- Task status progresses normally after the next dispatch.
- Flight recorder shows the agent picked up where it left off (or started fresh).

---

## SOP-2: Retry Fresh Session

### Symptom
- Previous run consumed excessive tokens or ended in a failed state.
- You need a clean dispatch without any prior session history.
- Auto-rotation already happened (session_rotated event in activity feed).

### Immediate Action
1. **Check if auto-rotation handled it:**  
   Look for `session_rotated` events in the task activity feed. If present, the system already created a fresh session.
2. **If not auto-rotated (manual override):**  
   Use the retry-dispatch endpoint:
   ```bash
   POST /api/tasks/:id/planning/retry-dispatch
   ```
   This forces a new session key creation and dispatches fresh.

### Root Cause
- Previous session was unhealthy (bloated, corrupted, or failed).
- The pre-dispatch health gate (PLATFORM-010 A4) detected the issue and auto-rotated.
- Manual retry is needed only when auto-rotation fails or is disabled.

### Resolution
1. **Auto-rotation (preferred):**  
   The system handles this — no manual action needed. Check the activity feed for the rotation event.
2. **Manual retry:**  
   Use the retry-dispatch endpoint. This creates a new `openclaw_sessions` row with incremented `run_number` and a fresh gateway session key.
3. **Debug the old session:**  
   Review the flight recorder of the old session to understand why it became unhealthy (token cap exceeded? memory-flush markers?).

### Verification
- New `session_rotated` event appears in activity feed.
- Run number increments (e.g., run 1 → run 2).
- New session key does not match the old one.
- Task status advances to `in_progress` with the new session.

---

## SOP-3: Memory-Flush / Sandbox Corruption

### Symptom
- Agent tool responses contain markers:  
  - `"Path escapes sandbox root"`  
  - `"Memory flush writes are restricted"`  
  - `"restricted"` (tool restriction errors)  
- Session health card in UI shows 🔴 **Unhealthy**.
- Activity feed shows `session_corrupted` reason.

### Immediate Action
1. **Do NOT retry in the same session.** The session is irrecoverably damaged.
2. **Check if auto-rotation triggered:**  
   The pre-dispatch health gate (PLATFORM-010 A4) scans for these markers and automatically rotates to a fresh session before the next dispatch. Look for `session_rotated` events.
3. **If the agent is still running:**  
   Kill the agent run immediately. Use the flight recorder to confirm the agent saw the markers and stopped (fail-fast with `SESSION_UNHEALTHY` message).

### Root Cause
- The OpenClaw gateway's sandbox corrupted the session's memory state.
- This typically happens when the session transcript grows beyond the sandbox allocation or the gateway enters a memory-flush mode.
- The agent cannot read/write files or use tools normally — any retry will burn tokens without progress.

### Resolution
1. **Auto-rotation (handled):**  
   The system detects the markers in the session history during the pre-dispatch health check and auto-rotates. No manual action needed.
2. **Clear the old session:**  
   The session is already marked as `rotated` in the database. No further cleanup required.
3. **If auto-rotation fails:**  
   Use the retry-dispatch endpoint (`POST /api/tasks/:id/planning/retry-dispatch`). This forces a fresh session.
4. **Review token burn:**  
   Check the old session's total tokens — if a large amount was wasted, review the flight recorder to see if the agent kept retrying before fail-fast kicked in.

### Verification
- New dispatch starts with a fresh session key (no memory-flush markers in the new session).
- Task activity shows `session_rotated` with reason including `session_corrupted`.
- Agent completes the task successfully in the new session.

---

## SOP-4: Token Meledak / Flailing Agent

### Symptom
- ⚠️ **TOKEN_RATE_ALERT** appears in the task activity feed.
- Task status reason shows: `TOKEN_RATE_ALERT: X tok/min (Y in 10m)`.
- Session health card shows `totalTokens` climbing rapidly.
- The agent is retrying the same operation repeatedly without progress.

### Immediate Action
1. **Open the flight recorder:**  
   Check what the agent has been doing. Look for repeated tool calls with the same errors.
2. **Check session health card:**  
   Is the session `Unhealthy`? Does it show corruption markers or high token totals?
3. **Kill the run if flailing:**  
   If the agent is clearly stuck in a loop:  
   - Use the retry-dispatch endpoint to start fresh.  
   - Or kill the session via the gateway.
4. **Check the alert cooldown:**  
   The alert fires at most once every 2 minutes per session. Multiple alerts mean sustained high burn.

### Root Cause
- The agent is stuck in a retry loop — the same operation fails repeatedly (often due to sandbox/connectivity issues).
- The session may be unhealthy (memory-flush, sandbox corruption) — see [SOP-3](#sop-3-memory-flush--sandbox-corruption).
- The task instruction may be too vague, causing the agent to explore widely and burn tokens.
- The model context is too full, causing the agent to lose track and repeat.

### Resolution
1. **Immediate: Rotate to fresh session.**  
   The pre-dispatch health gate will catch unhealthy sessions on retry. If the agent is still running, kill the run first.
2. **Investigate the root cause:**  
   - What errors was the agent seeing? (Flight recorder)  
   - Was the task spec clear?  
   - Is the product repo accessible?  
   - Is MC_API_TOKEN valid?  
3. **Adjust thresholds if needed:**  
   Set `TOKEN_RATE_ALERT` env var to a different value if the default (1M/10min) is too low/high for your workload.
4. **Review the fail-fast behavior:**  
   If the agent kept retrying >2x on restricted markers, the fail-fast instruction (PLATFORM-010 B4) may not have been included in the spec — check the planning spec for "Session Robustness Rules."

### Verification
- Token rate returns to normal after rotation.
- Agent completes the task without repeated errors.
- Alert cooldown prevents spam; no further alerts for the same session.
- Check `TOKEN_RATE_ALERT` env is set appropriately for your model:

```bash
# Example: set to 2M per 10 minutes for larger models
export TOKEN_RATE_ALERT=2000000
```

---

## Environment Configuration

| Variable | Default | Description |
|---|---|---|
| `TOKEN_RATE_ALERT` | `1000000` (1M) | Token burn threshold per 10-min sliding window |
| `PLATFORM_SESSION_MAX_TOTAL_TOKENS` | `1000000` (1M) | Cumulative cap that triggers session rotation |
| `PLATFORM_SESSION_CTX_HIGH_WATER_PCT` | `90` | Context window % for live context rotation |

---

## UI Reference

- **SessionHealthCard** (Task modal → Sessions tab): shows sessionId, run number, health state (healthy 🟢 / degraded 🟡 / unhealthy 🔴) with color-coded badge + tooltip, umur sesi, totalTokens, ukuran file sesi, dan riwayat rotasi. Auto-refresh setiap 30 detik. Data source: `GET /api/tasks/:id/planning/health` (best-effort gateway enrichment; saat gateway offline, data berasal dari DB dan kartu menampilkan ⚠️ gateway offline).
- **Flight Recorder:** Full session transcript + tool calls for debugging.
- **Activity Feed:** Shows `session_rotated`, `token_rate_alert`, `session_token_warning` events.

## Auto-Recovery (PLATFORM-010 A4/B4)

- **Pre-dispatch health gate:** sebelum dispatch, sesi existing di-scan untuk marker memory-flush/sandbox (`Path escapes sandbox root`, `Memory flush writes are restricted`, dll), status non-`active`, dan totalTokens > cap. Jika tidak sehat → sesi BARU dibuat (run number naik), activity `session_rotated` dicatat, `planning_dispatch_error` berisi alasan.
- **Fail-fast spec instruction:** dispatch spec berisi aturan SESSION_UNHEALTHY — agent harus stop ≤2 percobaan saat tool read/write di-block, lalu melaporkan `SESSION_UNHEALTHY: <marker>`. JANGAN coba-coba via exec.
- **BUG-1 (auto-answer duplikat):** jawaban hanya di-apend saat ada pertanyaan BARU (tracking idx pertanyaan) — maks 1 apend per pertanyaan.
- **BUG-2 (poll short-circuit):** `/planning/poll` memproses completion DULU sebelum melaporkan `planning_dispatch_error` lama — completion yang sudah tiba tetap diproses walau ada error basi.  
