# PLATFORM-018 — Isolasi Commit Agent dari Repo Shared Supervisor (Worktree per Task)

> Berlaku sejak pipeline runner mengelola **git worktree terisolasi per task**.
> Landing agent commit = **cherry-pick ke branch utama** + push — bukan format-patch manual, bukan commit langsung di repo shared.

---

## 1. Kenapa Ini Dibutuhkan

Ditemukan saat landing PLATFORM-009 (2026-08-05): seorang agent (reviewer yang salah map)
commit **langsung di repo shared** `/data/awanfleet/shared/mission-control` pada branch
`awanfleet-runtime-3a2ca342` (commit `0a00f4c`). Akibatnya:

1. **Repo lokal divergen dari origin** — origin HEAD `9b25466` (hasil `git am` PLATFORM-012),
   lokal punya `f644a40` (isi identik, hash beda). Landing manual jadi ribet:
   `format-patch` → checkout origin → `git am` → push.
2. **Risiko konflik dengan kerja supervisor** — dua entitas (agent pipeline + supervisor)
   mengedit working tree repo yang sama tanpa koordinasi.
3. **Landing manual rentan salah** — detached HEAD, branch force, history hilang.

**Solusi: worktree per task.** Setiap task yang punya `repo_url` mendapat working directory
git sendiri (`git worktree`), diinisialisasi dari `origin/HEAD`, di branch
`platform-<id>/<short>`. Agent bekerja dan commit **hanya di worktree-nya** — secara fisik
tidak mungkin menyentuh working tree supervisor.

---

## 2. Arsitektur

```
┌───────────────────────────  HOST (container mission-control)  ───────────────────────────┐
│                                                                                          │
│  /data/awanfleet/shared/mission-control   ← repo SHARED (supervisor bekerja di sini)     │
│     branch utama: origin/HEAD (mis. awanfleet-runtime-3a2ca342 / main)                   │
│         ▲                                      ▲                                          │
│         │ fetch / checkout / cherry-pick       │ git worktree add (hanya refs)            │
│         │ (landing, oleh pipeline runner)      │                                          │
│  ┌──────┴──────────────────────────────────────┴──────────────┐                           │
│  │  /data/awanfleet/tasks/<task_id>/worktree   ← worktree AGENT (terisolasi penuh)        │
│  │     branch: platform-<task_id_short>/<base_short>           │                           │
│  │     agent commit di SINI saja                               │                           │
│  └─────────────────────────────────────────────────────────────┘                           │
│         │ cherry-pick (1x per commit) + push origin <main>                                │
│         ▼                                                                                 │
│  origin (GitHub)  ← history SELALU sinkron dengan local main                              │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Aturan kunci:**

- Agent **tidak pernah** commit di `/data/awanfleet/shared/mission-control`. Worktree-nya
  adalah satu-satunya tempat kerja.
- Landing = `fetch origin` → `checkout <main>` → `cherry-pick` commit dari branch worktree →
  `push origin <main>`.
- Konflik landing → task `merge_status='blocked'`, worktree **dipertahankan** untuk resolve
  manual supervisor. Tidak ada auto-resolve, tidak ada cleanup prematur.
- Landing sukses → worktree + branch lokal **dihapus otomatis** (cleanup policy).

---

## 3. Konvensi Naming & Lokasi

| Hal | Nilai |
|---|---|
| Repo shared | `WORKTREE_REPO_PATH` (default `/data/awanfleet/shared/mission-control`) |
| Root worktree task | `WORKTREE_TASK_ROOT` (default `/data/awanfleet/tasks`) |
| Worktree per task | `<WORKTREE_TASK_ROOT>/<task_id>/worktree` |
| Metadata | `<WORKTREE_TASK_ROOT>/<task_id>/.mc-worktree.json` (DI LUAR worktree agar `git status` tetap bersih) |
| Branch agent | `platform-<8 char task id>/<7 char base commit>` contoh: `platform-642a01e2/a1b2c3d` |
| Branch utama | `WORKTREE_MAIN_BRANCH` (default: hasil resolve `origin/HEAD`) |
| Titik awal kerja | selalu `origin/HEAD` (state remote terbaru, bukan HEAD lokal yang bisa divergen) |

Env config (`.env.example`):

```
ENABLE_TASK_WORKTREES=true
WORKTREE_REPO_PATH=/data/awanfleet/shared/mission-control
WORKTREE_TASK_ROOT=/data/awanfleet/tasks
WORKTREE_MAIN_BRANCH=            # opsional; default origin/HEAD
```

`ENABLE_TASK_WORKTREES=false` mengembalikan alur lama (push branch + PR via
`workspace-isolation`).

---

## 4. Alur Step-by-Step

### 4.1 Pipeline runner membuat worktree (saat task di-dispatch)

Dipanggil otomatis di `POST /api/tasks/[id]/dispatch` (hanya untuk task dengan `repo_url`).

```bash
cd /data/awanfleet/shared/mission-control
git fetch origin --prune                          # 1. sinkronkan refs remote
main=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')  # 2. resolve branch utama
base=$(git rev-parse origin/$main)                # 3. base commit = origin/HEAD
branch="platform-${task_id:0:8}/$(echo $base | cut -c1-7)"
mkdir -p /data/awanfleet/tasks/<task_id>
git worktree add /data/awanfleet/tasks/<task_id>/worktree -b "$branch" origin/$main
```

Contoh output:

```
$ git worktree add /data/awanfleet/tasks/642a01e2/worktree -b platform-642a01e2/a1b2c3d origin/main
Preparing worktree (new branch 'platform-642a01e2/a1b2c3d')
HEAD is now at a1b2c3d feat(platform-017): two-phase planning-agent cleanup
```

Pre-flight sebelum create: repo shared ada & bersih (`git status --porcelain` kosong),
origin reachable (`git ls-remote --exit-code origin HEAD`). Kalau gagal → dispatch tetap
jalan dengan fallback path lama (log warning), tidak memblokir agent.

### 4.2 Agent bekerja di worktree

Dispatch context memberi tahu agent: `taskProjectDir = <worktree path>`, `branch = platform-...`.
Agent menulis file & commit **di dalam worktree** seperti repo biasa:

```bash
cd /data/awanfleet/tasks/<task_id>/worktree
# ... edit file ...
git add -A
git commit -m "feat(platform-018): implement X"
```

Commit agent **tidak muncul** di branch utama shared. Verifikasi cepat:

```bash
cd /data/awanfleet/shared/mission-control
git log --oneline main | grep "pesan commit agent"   # → kosong (bagus!)
```

### 4.3 Landing (saat task selesai / `done`)

Dipanggil otomatis di hook done (`src/app/api/tasks/[id]/route.ts`) atau manual via
`POST /api/tasks/[id]/workspace` body `{"action":"land"}`.

```bash
cd /data/awanfleet/shared/mission-control
git fetch origin --prune
commits=$(git rev-list --reverse origin/main..platform-642a01e2/a1b2c3d)
git checkout main
for c in $commits; do git cherry-pick "$c"; done
git push origin main
```

Contoh output:

```
$ git rev-list --reverse origin/main..platform-642a01e2/a1b2c3d
f5c8aa042e6942300c4bf3a431721511e62c2809
$ git checkout main
Already on 'main'
$ git cherry-pick f5c8aa042e6942300c4bf3a431721511e62c2809
[main f5c8aa0] feat(platform-018): implement X
 Date: Thu Aug 6 15:10:00 2026 +0700
 3 files changed, 120 insertions(+)
$ git push origin main
To https://github.com/SSA-DAI/mission-control.git
   a1b2c3d..f5c8aa0  main -> main
```

Setelah push sukses, runner **memverifikasi sinkronisasi**:
`git rev-parse HEAD` harus sama dengan `git rev-parse origin/main` (dengan kata lain
`git log --oneline origin/main..HEAD` kosong). Lalu cleanup otomatis.

### 4.4 Cleanup (otomatis setelah landing sukses)

```bash
cd /data/awanfleet/shared/mission-control
git worktree remove /data/awanfleet/tasks/<task_id>/worktree --force
git branch -D platform-642a01e2/a1b2c3d
```

Contoh output:

```
$ git worktree remove /data/awanfleet/tasks/642a01e2/worktree --force
$ git branch -D platform-642a01e2/a1b2c3d
Deleted branch platform-642a01e2/a1b2c3d (was f5c8aa0).
```

Row task di-reset (`workspace_path = NULL`) sehingga re-dispatch membuat worktree baru
dari origin/HEAD terbaru.

---

## 5. Status & Record yang Ditulis Runner

| Kondisi | `tasks.merge_status` | `tasks.status_reason` | Worktree |
|---|---|---|---|
| Worktree dibuat | `pending` | — | ada |
| Landing sukses + push | `merged` | — | dihapus |
| Tidak ada commit untuk di-land | `merged` (log "no changes") | — | dipertahankan |
| Cherry-pick konflik | `blocked` | `WORKTREE_LAND_CONFLICT: ... worktree kept at <path>` | **dipertahankan** |
| Cherry-pick ok, push gagal | `failed` | `WORKTREE_LAND_PUSH_FAILED: ... worktree kept` | **dipertahankan** |
| Pre-flight gagal (dirty tree / origin down) | tidak berubah (`failed` via log) | — | dipertahankan |

Semua landing dicatat di tabel `workspace_merges` (strategy `worktree`, `merged_by='auto'`,
`merge_log` berisi commit yang di-cherry-pick).

---

## 6. Troubleshooting

### 6.1 Konflik cherry-pick (`merge_status='blocked'`)

Runner **meng-abort cherry-pick** (branch utama kembali bersih), menandai task blocked,
dan **mempertahankan worktree + branch** agar supervisor bisa inspeksi.

Resolve manual oleh supervisor:

```bash
cd /data/awanfleet/shared/mission-control
# 1. Lihat konflik yang tersisa di branch worktree (git diff terhadap base)
git diff origin/main..platform-642a01e2/a1b2c3d --stat

# 2. Pilih strategi:
#    a) Terapkan perubahan worktree ke main secara manual, commit, push:
git checkout main
git diff platform-642a01e2/a1b2c3d -- <file> > /tmp/fix.patch
git apply /tmp/fix.patch     # atau edit manual
git add -A && git commit -m "fix(platform-018): resolve landing conflict"
git push origin main

#    b) Atau perbaiki branch worktree-nya agar cherry-pick bersih:
git checkout platform-642a01e2/a1b2c3d
# edit resolve konflik, commit
git push origin platform-642a01e2/a1b2c3d

# 3. Setelah resolved: ulangi landing (kalau strategi b) atau cleanup manual (kalau a)
curl -X POST http://localhost:4000/api/tasks/<id>/workspace \
  -H 'Content-Type: application/json' -d '{"action":"land"}'     # re-land (strategi b)
curl -X POST http://localhost:4000/api/tasks/<id>/workspace \
  -H 'Content-Type: application/json' -d '{"action":"cleanup"}'  # cleanup (strategi a)
```

> Catatan: re-land setelah supervisor sudah meng-commit isi yang sama ke main akan
> menghasilkan cherry-pick "empty" — runner **men-skip** commit kosong tersebut (tidak
> error), sehingga re-land idempotent.

### 6.2 `Worktree pre-flight failed: Working tree has uncommitted changes` (repo shared)

Supervisor punya perubahan belum di-commit di `/data/awanfleet/shared/mission-control`.
Runner TIDAK akan checkout/cherry-pick di atas tree kotor (safety). Supervisor harus
commit/stash dulu, lalu ulangi landing.

```bash
cd /data/awanfleet/shared/mission-control
git status                       # lihat apa yang kotor
git stash push -m "wip sebelum landing"   # atau commit
# ulangi landing
```

### 6.3 `Origin unreachable`

Runner gagal `git ls-remote origin HEAD` / `git fetch origin`. Periksa koneksi & kredensial
git untuk user proses mission-control (`gh auth status` / `git credential fill`), lalu retry.
Tidak ada state yang rusak — pre-flight murni baca.

### 6.4 Push gagal setelah cherry-pick sukses

Commit sudah ada di main lokal, tapi tidak ter-push (`merge_status='failed'`,
`WORKTREE_LAND_PUSH_FAILED`). Perbaiki akses push, lalu jalankan ulang landing —
cherry-pick akan menghasilkan "empty" dan di-skip, push-nya yang jalan. Worktree
dipertahankan sampai sukses.

### 6.5 Sinkronisasi tidak tercapai (`SYNC CHECK FAILED` di merge_log)

`git rev-parse HEAD != git rev-parse origin/main` setelah push. Kemungkinan push berhasil
tapi ref lokal origin/main belum update (push normal-nya meng-update, jadi ini kasus aneh —
kemungkinan ada race dengan fetch). Jalankan `git fetch origin` lalu bandingkan lagi;
kalau divergen beneran, koordinasikan dengan supervisor (jangan force-push).

---

## 7. Perintah Git Lengkap yang Dipakai Runner

| Operasi | Perintah |
|---|---|
| Buat worktree | `git worktree add <path> -b <branch> origin/<main>` |
| Cek reachability origin | `git ls-remote --exit-code origin HEAD` |
| Fetch remote | `git fetch origin --prune` |
| Resolve branch utama | `git symbolic-ref --short refs/remotes/origin/HEAD` |
| Commit yang akan di-land | `git rev-list --reverse origin/<main>..<branch>` |
| Checkout main | `git checkout <main>` |
| Cherry-pick | `git cherry-pick <commit>` |
| Skip cherry-pick kosong | `git cherry-pick --skip` |
| Abort cherry-pick (konflik) | `git cherry-pick --abort` |
| File konflik | `git diff --name-only --diff-filter=U` |
| Push | `git push origin <main>` |
| Verifikasi sinkron | `git rev-parse HEAD` vs `git rev-parse origin/<main>` |
| Hapus worktree | `git worktree remove <path> --force` (fallback `rm -rf` + `git worktree prune`) |
| Hapus branch lokal | `git branch -D <branch>` |

---

## 8. Implementasi & Test

- **Modul inti**: `src/lib/worktree-manager.ts` — `createTaskWorktree`, `landTaskWorktree`,
  `cleanupTaskWorktree`, `preflightSharedRepo`, `preflightTaskWorktree`, `resolveMainBranch`,
  `loadTaskWorktree`, `isTaskWorktreeTask`. Semua operasi idempotent + ada pre-flight.
- **Integrasi pipeline**:
  - `src/app/api/tasks/[id]/dispatch/route.ts` — create worktree saat builder dispatch
    (task dengan `repo_url`).
  - `src/app/api/tasks/[id]/route.ts` — hook `done` memanggil `landTaskWorktree` (bukan
    push-branch+PR) untuk task ber-worktree.
  - `src/app/api/tasks/[id]/workspace/route.ts` — action `land` (manual re-land) dan
    `cleanup` yang paham layout worktree task.
- **Test**: `src/lib/worktree-manager.test.ts` (+6 integration test, real git repos hermetik
  di `.tmp/`): full flow agent→landing→supervisor→agent, konflik cherry-pick → blocked +
  worktree dipertahankan, dirty tree, origin unreachable, no-changes idempotent, re-land
  konsisten. Total suite 243/243 hijau + `next build` hijau.

Dokumen terkait: `HOW-THE-PIPELINE-WORKS.md`, `ORCHESTRATION_WORKFLOW.md`.
