# Agent Efficiency Rules (PLATFORM-009)

**Status:** active · **Applies to:** every agent dispatched by mission-control (builder, tester, reviewer, learner)
**Origin:** incident MRN-104 (2026-08-05) — 7.1M cumulative tokens burned in 12 minutes
**Short summary (injected into every dispatch spec):** `src/lib/task-dispatch-context.ts` → section `Agent Efficiency Rules (PLATFORM-009)`

---

## Why these rules exist

MRN-104 profile:

1. **Quadratic context cost.** The agent read files one-per-exec (`cat file` per call, 10–17KB each). Every exec round-trip re-sends the full conversation history, so N micro-steps cost O(N²) tokens. 75 exec calls in 12 minutes → ~7.1M cumulative tokens.
2. **Fighting root-owned files.** The agent ran `rm -rf` / `mv` against `frontend/.nm-root-mrn104` — a root-owned npm artifact — without checking ownership first. Every failed attempt emitted permission errors; two 63KB "Permission denied" blobs flooded the context window.
3. **Unbounded tool output.** Large files (lockfiles, `node_modules` trees, build output) were dumped in full, wasting context on content nobody reads.

The rules below prevent all three failure modes. They are cheap to follow and cost almost nothing when the file you need is small.

---

## B1 — Batch file reads into one exec call

**Rule:** read multiple files in a single exec. Check size before reading. Never read a file per exec call.

```bash
# GOOD — one round trip for three files
cat src/a.ts src/b.ts src/c.ts

# GOOD — preview mode, bounded output
head -200 src/a.ts src/b.ts

# GOOD — size check first, then decide
ls -l package-lock.json && wc -c package-lock.json
```

```bash
# ANTI-PATTERN — one exec per file (quadratic token cost)
cat src/a.ts
cat src/b.ts
cat src/c.ts
```

**Large-file handling:** for files > ~100KB (lockfiles, `node_modules`, build artifacts), never `cat` in full. Use:

```bash
head -200 file          # top of file
tail -200 file          # bottom of file (errors/logs often at the end)
grep -n "pattern" file  # targeted search
wc -l file              # just the line count
```

---

## B2 — No destructive commands without an ownership check

**Rule:** before ANY `rm -rf`, `mv`, `chmod -R`, or `chown -R`, run `ls -ld` on the target first. If the target is owned by root (uid 0) or any uid that is not the agent's own, **STOP and report** — do not fight it.

```bash
# GOOD — inspect before any destructive op
ls -ld frontend/.nm-root-mrn104
# → drwxr-xr-x 2 root root 4096 ...   ← owned by root, NOT yours

# GOOD — you own it, safe to remove
ls -ld .tmp/build-artifacts
# → drwxr-xr-x 2 node node 4096 ...   ← owned by you (uid 1000)
rm -rf .tmp/build-artifacts
```

```bash
# ANTI-PATTERN — destructive op with zero ownership awareness
rm -rf frontend/.nm-root-mrn104     # permission denied × dozens of files → 63KB error blob
mv node_modules /tmp/node_modules   # same failure mode for root-owned trees
```

**When you find a root-owned path:**

1. Stop immediately — do not retry with `sudo`, `chown`, or workarounds.
2. Collect evidence: `ls -ld <path>` output + the exact command you intended to run.
3. Report via Mission Control (task note / activity / to the orchestrator).
4. Root-owned junk in user workspaces (`.nm-root-*`, root `node_modules`) is a **platform hygiene problem** — the preventive cron and repo janitor handle it. It is never the task agent's job to force-remove it.

---

## B3 — Bound tool output for large files

**Rule:** keep command output small. Anything over ~200 lines gets piped through `head`/`tail`. Never dump big files in full.

```bash
# GOOD
grep -c '"dependencies"' package-lock.json          # just a count
find node_modules -maxdepth 2 -type d | head -50    # bounded tree walk
du -sh node_modules                                  # one line
ls -l | head -30                                     # bounded listing
```

```bash
# ANTI-PATTERN — unbounded output floods the context window
cat package-lock.json          # 300KB of JSON nobody reads
find node_modules -type f      # tens of thousands of lines
ls -la node_modules            # hundreds of entries, mostly irrelevant
```

---

## Escape hatch

**Rule:** rules yield to safety and correctness — but the escape hatch is *reporting*, not silent deviation.

- If a task genuinely requires reading a large file in full (e.g., auditing a lockfile for a dependency fix), say so in one line in your plan/activity log first, read it once, and don't re-read it.
- If a destructive op is required on a root-owned path (e.g., a task that is itself the janitor), the janitor **is** the platform role — but even then: `ls -ld` first, and confirm the path matches the exact `.nm-root-*` / node_modules pattern before removal.
- If you believe a rule conflicts with the task instructions, report the conflict to the orchestrator rather than picking one silently.

**Violations of these rules are cheap to detect and expensive to pay for** (MRN-104: 7.1M tokens ≈ 12 minutes of work). When in doubt: batch, check ownership, bound output.
