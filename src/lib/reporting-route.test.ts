import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from './db';
import * as reportingRoute from '@/app/api/tasks/[id]/reporting/route';

// ── BOX-PATH-NORMALIZATION-FIX §12/§14: reporting metadata bridge ──
// Route-level tests for POST/GET /api/tasks/:id/reporting.

const POST = (
  (reportingRoute as unknown as { default?: { POST: unknown } }).default?.POST ??
  (reportingRoute as unknown as { POST: unknown }).POST
) as (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const GET = (
  (reportingRoute as unknown as { default?: { GET: unknown } }).default?.GET ??
  (reportingRoute as unknown as { GET: unknown }).GET
) as (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function seedTask(id: string) {
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'T', 'in_progress', 'normal', 'default', 'default', datetime('now'), datetime('now'))`,
    [id]
  );
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(body: unknown): Request {
  return new Request('http://localhost/api/tasks/x/reporting', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('reporting bridge: valid canonical reference → 200 + metadata stored', async () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  const res = await POST(
    req({
      box_report_path: 'box:408894294463/Agentic-RAG/model-routing/WORK_RESULT.md',
      box_report_file_id: '2472202564441',
      box_report_folder_id: '418930626425',
      box_evidence_folder_id: '418913922829',
      reporting_status: 'PRESENT',
      git_commit_sha: 'abc123def456',
    }),
    ctx(taskId)
  );
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; reporting_status: string };
  assert.equal(json.ok, true);
  assert.equal(json.reporting_status, 'PRESENT');

  const row = queryOne<{ metadata: string }>('SELECT metadata FROM tasks WHERE id = ?', [taskId]);
  const meta = JSON.parse(row!.metadata);
  assert.equal(meta.box_report_path, 'box:408894294463/Agentic-RAG/model-routing/WORK_RESULT.md');
  assert.equal(meta.box_report_file_id, '2472202564441');
  assert.equal(meta.box_report_folder_id, '418930626425');
  assert.equal(meta.box_evidence_folder_id, '418913922829');
  assert.equal(meta.reporting_status, 'PRESENT');
  assert.equal(meta.git_commit_sha, 'abc123def456');
});

test('reporting bridge: PENDING_UPLOAD rejected with 400 (done-gate safety §14)', async () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  const res = await POST(
    req({ box_report_path: 'PENDING_UPLOAD', reporting_status: 'PENDING_UPLOAD' }),
    ctx(taskId)
  );
  assert.equal(res.status, 400);

  const row = queryOne<{ metadata: string | null }>('SELECT metadata FROM tasks WHERE id = ?', [taskId]);
  assert.equal(row!.metadata, null, 'rejected payload must not be stored');
});

test('reporting bridge: N/A placeholder rejected with 400', async () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  const res = await POST(req({ box_report_path: 'N/A' }), ctx(taskId));
  assert.equal(res.status, 400);
});

test('reporting bridge: duplicate-root path (box:<root>/dai-core/…) rejected with 400', async () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  const res = await POST(
    req({ box_report_path: 'box:408894294463/dai-core/Agentic-RAG/model-routing/WORK_RESULT.md' }),
    ctx(taskId)
  );
  assert.equal(res.status, 400);
});

test('reporting bridge: non-final reporting_status rejected with 400', async () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  const res = await POST(
    req({ box_report_path: 'box:408894294463/X/WORK_RESULT.md', reporting_status: 'REPORTING_INCOMPLETE' }),
    ctx(taskId)
  );
  assert.equal(res.status, 400);
});

test('reporting bridge: unknown task → 404', async () => {
  const res = await POST(
    req({ box_report_path: 'box:408894294463/X/WORK_RESULT.md' }),
    ctx(crypto.randomUUID())
  );
  assert.equal(res.status, 404);
});

test('reporting bridge GET: returns stored reference or nulls', async () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  let res = await GET(new Request('http://localhost/x'), ctx(taskId));
  assert.equal(res.status, 200);
  let json = (await res.json()) as Record<string, unknown>;
  assert.equal(json.box_report_path, null);

  await POST(
    req({
      box_report_path: 'box:file:2472202564441',
      reporting_status: 'REPORTING_COMPLETE',
      box_report_file_id: '2472202564441',
    }),
    ctx(taskId)
  );

  res = await GET(new Request('http://localhost/x'), ctx(taskId));
  json = (await res.json()) as Record<string, unknown>;
  assert.equal(json.box_report_path, 'box:file:2472202564441');
  assert.equal(json.reporting_status, 'REPORTING_COMPLETE');
  assert.equal(json.box_report_file_id, '2472202564441');
});
