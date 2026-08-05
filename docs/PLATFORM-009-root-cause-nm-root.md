# Root Cause: `.nm-root-*` Artifacts & Ownership Inconsistency (PLATFORM-009)

**Incident:** MRN-104 (2026-08-05) — agent fought `frontend/.nm-root-mrn104` (root-owned), producing two 63KB "Permission denied" blobs; combined with 75 micro-step exec calls → 7.1M cumulative tokens burned in 12 minutes.
**Date of analysis:** 2026-08-06
**Status:** fixed (repo clean), prevention active (cron PLATFORM-009-*), guidance in dispatch spec (B1–B3).

---

## What `.nm-root-*` is

`npm` writes hidden state/artifact directories prefixed `.nm-` during install/lifecycle operations (e.g., `.nm-root-*` staging dirs created by `npm install` when running with elevated privileges or with a misconfigured `--prefix`). The `-root-` suffix tracks the uid the install ran as. When `npm install` runs as **root** (uid 0) against a repo owned by **node** (uid 1000), the artifacts land in the tree owned by root — and every subsequent uid-1000 `rm`/`mv`/`npm` operation against them fails with `EACCES: permission denied`, one error line per entry.

The file `frontend/.nm-root-mrn104` was exactly this: a root-owned npm staging artifact from the MRN-104 dependency-repair cycle (see git commit `2ff4d95 fix(mrn-104): sync package-lock … npm ci EUSAGE fix`).

## Root causes (2+)

### 1. `npm install` with a wrong `--prefix` (or from the wrong cwd) as root
Running `npm install --prefix /workspace/awanfleet/<repo>/frontend` as root (e.g., from a root shell, a `sudo npm`, or a root-owned CI step) makes npm create staging/state artifacts inside the target tree owned by uid 0. The repo tree itself stays uid 1000 → mixed ownership → every later uid-1000 operation on the root-owned artifacts fails.

**Fix at the source:** always run `npm install` as the repo owner (uid 1000 / `node` user), from the package root or with `--prefix` pointing to a path the *same* uid owns. Never `sudo npm install` into a user-owned repo.

### 2. Containerized builds (nixpacks / Dockerfile `RUN npm install` as root)
Platforms like nixpacks and multi-stage Dockerfiles commonly run `npm install` as root during image build. If the build copies/links artifacts back into a user-owned workspace, or if `npm ci` is executed as root against a shared volume owned by uid 1000, the resulting `node_modules` and `.nm-*` artifacts are root-owned. This is the "consistent" way to reproduce the problem in a fleet.

**Fix at the source:** build as uid 1000 in the container (`USER node` / `RUN chown -R node:node . && USER 1000`), or set `npm_config_cache`/`npm_config_prefix` to a root-owned cache outside the repo tree so no root-owned state lands inside the workspace.

### 3. Amplifier: agents attempting cleanup without an ownership check
Once root-owned junk exists, task agents run `rm -rf <path>` (no `ls -ld` first), fail per-entry, and the error lines flood the context window. The cleanup attempt is what turns a small artifact into a 63KB token-burning blob. Prevention (B2): ownership check before any destructive command, and report root-owned paths instead of fighting them.

## Ownership consistency guidance (target state: uid 1000 everywhere)

Canonical environment facts:

| Item | Value |
|---|---|
| Runtime user | `node`, uid **1000**, gid **1000** |
| Workspace root | `/workspace/awanfleet/` (owned by node) |
| `node_modules` owner | must be `node node` (uid 1000) |
| Junk patterns | `.nm-root-*`, any root-owned dir under a repo tree |

Rules:

1. **Everything under `/workspace/awanfleet/` must be owned by uid 1000:gid 1000.** Anything else is an incident waiting to happen.
2. **npm never runs as root.** If a build needs root, it runs *before* artifacts enter the workspace, or the workspace is chowned back to 1000 immediately after.
3. **`node_modules` ownership is a health signal.** `find <repo> -maxdepth 4 -type d -name node_modules -user root` returning anything = red flag; fix with a deliberate `chown -R 1000:1000 <repo>` (janitor role) or reinstall as uid 1000.
4. **Preventive detection:** cron job `PLATFORM-009-root-owned-sweep` (every 6h) scans `/workspace/awanfleet/` for `.nm-root-*` and root-owned `node_modules`, and alerts when found.

## Prevention summary (what this task shipped)

- **B1–B3 guidance** injected into every dispatch spec (`Agent Efficiency Rules (PLATFORM-009)` section) — batch reads, ownership checks, bounded output.
- **Full rules file** `.openclaw/rules/agent-efficiency.md` with anti-patterns + escape hatch.
- **Preventive cron** (every 6h) detecting `.nm-root-*` / root-owned `node_modules` in `/workspace/awanfleet/`.
- **Checklist** `docs/maintenance-hygiene-checklist.md` — audit → verify → clean → fix ownership → verify → report.
- **Audit result 2026-08-06:** no root-owned files found in `/workspace/awanfleet/` (all repos clean, `node_modules` uid 1000).
