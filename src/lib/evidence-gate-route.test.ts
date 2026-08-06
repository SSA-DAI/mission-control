import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './db';
import * as taskRoute from '@/app/api/tasks/[id]/route';
import { getOpenClawClient } from '@/lib/openclaw/client';

// ── PLATFORM-019: PATCH /api/tasks/:id gate responses ──
// Route-level integration tests for the evidence gate error contract:
//   { error: string (enriched, enumerates missing requirements), details: {...} }
// Only the 400 gate-fail paths are exercised — the success path triggers real
// dispatch/learner side effects and is covered by the lib-level tests instead.

const PATCH = (
  (taskRoute as unknown as { default?: { PATCH: unknown } }).default?.PATCH ??
  (taskRoute as unknown as { PATCH: unknown }).PATCH
) as (request: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

// Release the OpenClaw WS client + cache-cleanup timer so the test process can
// exit after the route import keeps them alive (route imports sync the agent
// catalog via the gateway client on each PATCH).
test.after(() => {
  try {
    getOpenClawClient().disconnect();
  } catch {
    /* ignore */
  }
  const g = globalThis as Record<string, unknown>;
  const timer = g['__openclaw_cache_cleanup_timer__'] as NodeJS.Timeout | undefined;
  if (timer) clearInterval(timer);
});

function seedTask(id: string, status = 'in_progress') {
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', 'default', 'default', datetime('now'), datetime('now'))`,
    [id, status]
  );
}

function addDeliverable(taskId: string): void {
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'index.html', datetime('now'))`,
    [taskId]
  );
}

function addActivity(taskId: string): void {
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );
}

function addKnowledge(taskId: string): void {
  run(
    `INSERT INTO knowledge_entries (id, workspace_id, task_id, category, title, content, confidence, created_at)
     VALUES (lower(hex(randomblob(16))), 'default', ?, 'pattern', 'Lesson', 'always test', 0.9, datetime('now'))`,
    [taskId]
  );
}

async function patchTask(id: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request(`http://localhost/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req, { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

for (const stage of ['testing', 'review', 'verification']) {
  test(`PATCH → ${stage} without evidence: 400, error enumerates missing requirements + details populated`, async () => {
    const taskId = crypto.randomUUID();
    seedTask(taskId);

    const { status, body } = await patchTask(taskId, { status: stage });

    assert.equal(status, 400, `${stage} gate must block without evidence`);
    // `error` stays a string — enriched, not a generic message
    assert.equal(typeof body.error, 'string');
    const error = body.error as string;
    assert.ok(error.includes('missing'), `must say something is missing: ${error}`);
    assert.ok(error.includes('0/1 deliverables'), error);
    assert.ok(error.includes('0/1 activities (completed/file_created/updated)'), error);
    assert.ok(!error.includes('knowledge entries'), `${stage} must not require knowledge: ${error}`);
    assert.ok(error.startsWith('Evidence gate failed:'), error);

    // `details` is a NEW additive field with a structured breakdown
    const details = body.details as {
      deliverables: { current: number; required: number; missing: number };
      activities: { current: number; required: number; missing: number; acceptedTypes: string[] };
      knowledge: { current: number; required: number; missing: number };
    };
    assert.ok(details, 'details field must be present');
    assert.deepEqual(details.deliverables, { current: 0, required: 1, missing: 1 });
    assert.deepEqual(details.activities, {
      current: 0,
      required: 1,
      missing: 1,
      acceptedTypes: ['completed', 'file_created', 'updated'],
    });
    assert.deepEqual(details.knowledge, { current: 0, required: 0, missing: 0 });
  });
}

test('PATCH → done without evidence: 400 enumerating ALL three requirements (incl. learner knowledge)', async () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  const { status, body } = await patchTask(taskId, { status: 'done' });

  assert.equal(status, 400);
  const error = body.error as string;
  assert.equal(typeof error, 'string');
  assert.ok(error.startsWith('Cannot mark done:'), error);
  assert.ok(error.includes('0/1 deliverables'), error);
  assert.ok(error.includes('0/1 activities (completed/file_created/updated)'), error);
  assert.ok(error.includes('0/1 knowledge entries'), error);

  const details = body.details as {
    deliverables: { current: number; required: number; missing: number };
    activities: { current: number; required: number; missing: number; acceptedTypes: string[] };
    knowledge: { current: number; required: number; missing: number };
  };
  assert.deepEqual(details.deliverables, { current: 0, required: 1, missing: 1 });
  assert.equal(details.activities.missing, 1);
  assert.deepEqual([...details.activities.acceptedTypes], ['completed', 'file_created', 'updated']);
  assert.deepEqual(details.knowledge, { current: 0, required: 1, missing: 1 });
});

test('PATCH → done with evidence but no knowledge: 400 names knowledge as the only missing requirement', async () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  addDeliverable(taskId);
  addActivity(taskId);

  const { status, body } = await patchTask(taskId, { status: 'done' });

  assert.equal(status, 400);
  const error = body.error as string;
  assert.ok(error.includes('0/1 knowledge entries'), error);
  assert.ok(!error.includes('deliverables'), `satisfied categories must not be listed as missing: ${error}`);
  assert.ok(!error.includes('activities'), `satisfied categories must not be listed as missing: ${error}`);

  const details = body.details as {
    deliverables: { missing: number };
    activities: { missing: number };
    knowledge: { missing: number };
  };
  assert.equal(details.deliverables.missing, 0);
  assert.equal(details.activities.missing, 0);
  assert.equal(details.knowledge.missing, 1);
});
