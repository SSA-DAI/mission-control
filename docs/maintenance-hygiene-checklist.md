# Maintenance Hygiene Checklist (PLATFORM-009)

**Scope:** `/workspace/awanfleet/` and any workspace repo tree
**Purpose:** detect and remove root-owned junk (`.nm-root-*`, root-owned `node_modules`) before it triggers permission-denied error blobs in agent contexts (MRN-104).

Run this checklist whenever:
- a task reports `Permission denied` errors from `rm`/`mv`/`chmod`, or
- a `.nm-root-*` artifact is seen in a repo tree, or
- as a routine sweep (the preventive cron does this every 6h — see D4).

---

## 1. Audit — find root-owned files and dirs

```bash
# 1a. Root-owned junk artifacts anywhere under the workspace
find /workspace/awanfleet -name '.nm-root-*' -not -path '*/node_modules/*' 2>/dev/null

# 1b. Root-owned files/dirs in a specific repo (excluding node_modules content noise)
find /workspace/awanfleet/kesultanan-megat-raja -user root -not -path '*/node_modules/*' 2>/dev/null

# 1c. Root-owned node_modules trees (the big one — a root node_modules breaks npm ci for uid 1000)
find /workspace/awanfleet -maxdepth 4 -type d -name node_modules -user root 2>/dev/null

# 1d. Any root-owned entry at all (full sweep, includes node_modules)
find /workspace/awanfleet -user root 2>/dev/null | head -50
```

Expected healthy state: **empty output** from 1a–1c. If 1d returns entries, they must be explained (e.g., a deliberately root-owned mount point) — never silently ignored.

## 2. Verify ownership before ANY cleanup

```bash
# Always: inspect before touching. Confirm the path AND its ownership.
ls -ld <path>          # e.g. drwxr-xr-x 2 root root 4096 ...
ls -ld <path>/* | head # peek at children before recursive ops
stat -c '%U %u %n' <path>
```

Only proceed with removal if the path matches a known junk pattern:

| Pattern | Verdict |
|---|---|
| `.nm-root-*` (dir or file) | junk artifact → safe to remove after `ls -ld` |
| `node_modules` owned by root | junk (wrong-uid install) → flag, do NOT bulk-remove if the repo is actively used; coordinate reinstall |
| `.next/`, `dist/`, `coverage/` owned by root | build output junk → safe to remove |
| anything else root-owned | **do not remove** → escalate to supervisor with `ls -ld` output |

## 3. Clean up

```bash
# Safe junk (uid 1000 agent): remove after the ls -ld check above
rm -rf <path>    # ONLY for confirmed .nm-root-* / build-output junk owned by root or self

# Root-owned node_modules that must be rebuilt:
# Do NOT rm -rf it as uid 1000 (permission errors flood the context).
# Report: repo path + ls -ld output → platform janitor fixes ownership or reinstalls as uid 1000.
```

**Never** use `sudo rm`, `chown -R` as a workaround inside a task agent session — that is platform work. If you are the janitor role, `chown -R 1000:1000 <repo>` is the *fix* for wrong-uid `node_modules`, applied deliberately after `ls -ld`.

## 4. Fix ownership consistency (uid 1000)

```bash
# Target state: everything under /workspace/awanfleet owned by uid 1000 (node), gid 1000.
chown -R 1000:1000 /workspace/awanfleet/<repo>    # deliberate janitor action only
ls -ld /workspace/awanfleet/<repo>/node_modules   # verify: node node
```

Prevent recurrence — see `docs/PLATFORM-009-root-cause-nm-root.md`:
- `npm install` must run as uid 1000, never root, never `--prefix` pointing into the repo tree as root.
- Containerized builds (nixpacks) that run `npm install` as root must be fixed at the build config level, not patched per-repo.

## 5. Verify

```bash
# Re-run the audit — all three must be empty
find /workspace/awanfleet -name '.nm-root-*' -not -path '*/node_modules/*' 2>/dev/null
find /workspace/awanfleet/<repo> -user root -not -path '*/node_modules/*' 2>/dev/null
find /workspace/awanfleet -maxdepth 4 -type d -name node_modules -user root 2>/dev/null

# Sanity: the repo still works
git -C /workspace/awanfleet/<repo> status --short | head
npm ls --prefix /workspace/awanfleet/<repo>/frontend --depth 0 >/dev/null 2>&1 && echo 'npm ok'
```

Checklist passes when: audit output empty, repo git-clean, npm tree intact.

## 6. Report

- Log the sweep: task activity or cron run summary (paths found, paths removed, escalations).
- Escalations (root-owned anything not matching junk patterns): include `ls -ld` output + context.
