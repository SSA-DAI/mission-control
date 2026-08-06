# PLATFORM-016 — Answer Idempotency (Planning)

> Server-side guard yang mencegah jawaban ganda untuk pertanyaan planning yang
> sudah terjawab. Berlaku untuk jalur manual (`POST /planning/answer`) DAN
> auto-answer — satu source of truth DB-persistent.

## Masalah

Saat driver planning restart, state in-memory-nya hilang → pertanyaan yang sama
dijawab 2–3× (mis. A, C, B untuk Q yang sama) → konteks planning agent rusak →
planning macet 13 menit (PLATFORM-009). Fix P010 BUG-1 hanya menutup jalur
auto-answer dengan state in-memory (hilang saat restart) dan tidak menyentuh
`POST /planning/answer`.

## Solusi

- Kolom baru `tasks.answered_question_indices` (JSON TEXT, nullable) menyimpan:
  ```json
  {
    "<questionIndex>": {
      "questionHash": "<sha256-16-hex dari konten pertanyaan>",
      "answer": "<jawaban ternormalisasi>",
      "messageId": "<id pesan user di planning_messages>",
      "delivered": true
    }
  }
  ```
- **questionIndex** = posisi pesan assistant (pertanyaan) di `planning_messages`.
  Bila sesi planning restart dan agent menanyakan pertanyaan BERBEDA di index
  yang sama, `questionHash` berbeda → record lama dianggap stale → jawaban baru
  diterima (bukan false conflict).
- **Normalisasi** jawaban: `trim().toLowerCase()` + collapse whitespace —
  perbedaan kapitalisasi/whitespace dianggap jawaban sama.
- Guard check + append jawaban dalam **satu transaksi** DB → request konkuren
  untuk pertanyaan sama tidak bisa double-append.

## Kontrak API — `POST /api/tasks/:id/planning/answer`

### Request

```json
{
  "answer": "Build from source",
  "otherText": "…",           // opsional, hanya untuk pilihan "Other"
  "questionIndex": 1          // opsional — lihat "Retry safety" di bawah
}
```

`questionIndex` di-derive dari pending question (last assistant message) bila
tidak diberikan. Validasi: non-negatif integer; harus menunjuk pesan assistant.

### Responses

| Situasi | Status | Body |
|---|---|---|
| Jawaban pertama | `200` | `{ success: true, idempotent: false, questionIndex, messages }` |
| Retry jawaban SAMA (normalized) | `200` | `{ success: true, idempotent: true, existingAnswerId, questionIndex, messages }` — TIDAK re-append, TIDAK re-send (kecuali delivery sebelumnya gagal → dikirim ulang) |
| Jawaban BERBEDA untuk pertanyaan yang sudah terjawab | `409` | `{ error: "QUESTION_ALREADY_ANSWERED", existingAnswer, submittedAnswer, questionIndex }` — TIDAK append |
| Answer kosong / null | `400` | `{ error: "Answer is required" }` |
| `questionIndex` invalid / bukan pertanyaan | `400` | `{ error: "questionIndex must be a non-negative integer" }` / `"questionIndex does not reference a pending question"` |
| Tidak ada pending question | `400` | `{ error: "No pending question to answer" }` |
| Task tidak ada | `404` | `{ error: "Task not found" }` |
| Planning belum dimulai | `400` | `{ error: "Planning not started" }` |

### Retry safety untuk client/driver

1. Jawaban pertama → simpan `questionIndex` dari response.
2. Setelah restart (state in-memory hilang), kirim ulang dengan
   `questionIndex` + jawaban yang sama:
   - jawaban sama → `200 idempotent: true` (aman, tidak ada duplikat);
   - jawaban beda → `409` — jangan timpa; polling `GET /planning` untuk
     melanjutkan dari state server.

Server juga menormalisasi sendiri index (pending question) jika `questionIndex`
tidak dikirim — retry nilai sama tetap idempotent.

### Perilaku saat send ke agent gagal

Jawaban dipersist DULU (transaksi), lalu dikirim ke OpenClaw. Jika send gagal:
`500` dengan `idempotentRetryable: true` — jawaban tetap tersimpan
(`delivered: false`); retry dengan jawaban SAMA akan `200 idempotent` dan
mengirim ulang (self-healing, tidak ada duplikasi di konteks agent).

## Auto-answer

`POST /api/tasks/:id/planning/auto-answer` memakai guard yang sama
(`appendAnswerWithGuard`) — guard P010 in-memory (`planning-dedup.ts`) dihapus.
Dedup bertahan lintas restart driver; conflict tidak pernah di-append/dikirim.

## Siklus hidup state

| Event | `answered_question_indices` |
|---|---|
| Driver/client restart (sesi planning TETAP) | **Dipertahankan** — retry aman (idempotent/conflict) |
| Planning session restart (watchdog P014 / `startPlanningSession`) | **Dibersihkan** — sesi baru menanyakan ulang dari awal |
| `POST /planning/cancel` | **Dibersihkan** |
| `DELETE /planning` (hard reset) | **Dibersihkan** |

## Referensi

- Implementasi: `src/lib/planning-answer-idempotency.ts`
- Route manual: `src/app/api/tasks/[id]/planning/answer/route.ts`
- Route auto-answer: `src/app/api/tasks/[id]/planning/auto-answer/route.ts`
- Migration: `src/lib/db/migrations.ts` (043)
- Tests: `src/lib/planning-answer-idempotency.test.ts` (+20)
