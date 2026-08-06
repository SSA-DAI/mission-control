import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from './db';
import {
  ACCEPTED_EVIDENCE_ACTIVITY_TYPES,
  STAGE_EVIDENCE_REQUIREMENTS,
  evidenceRequirementsForStage,
  generateEvidenceErrorMessage,
  evaluateEvidenceGate,
  getEvidenceCounts,
  hasValidationFailureFlag,
  taskCanBeDone,
  type EvidenceCounts,
} from './task-governance';

// ── PLATFORM-019: evidence gate message detail ──
// Every gate transition (testing/review/verification/done) must produce an
// error message that enumerates exactly which evidence requirements are
// missing, plus a structured `details` breakdown. Field `error` stays a string.

const ALL_STAGES = ['testing', 'review', 'verification', 'done'];
const EMPTY: EvidenceCounts = { deliverables: 0, activities: 0, knowledge: 0 };

function seedTask(id: string, workspace = 'default', status = 'in_progress') {
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [id, status, workspace]
  );
}

function addDeliverable(taskId: string, deliverableType = 'file'): void {
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, 'index.html', datetime('now'))`,
    [taskId, deliverableType]
  );
}

function addActivity(taskId: string, activityType = 'completed'): void {
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, 'did thing', datetime('now'))`,
    [taskId, activityType]
  );
}

function addKnowledge(taskId: string): void {
  run(
    `INSERT INTO knowledge_entries (id, workspace_id, task_id, category, title, content, confidence, created_at)
     VALUES (lower(hex(randomblob(16))), 'default', ?, 'pattern', 'Lesson', 'always test', 0.9, datetime('now'))`,
    [taskId]
  );
}

// ── Pure message generator ──

test('generateEvidenceErrorMessage: no evidence enumerates every required category per stage', () => {
  for (const stage of ALL_STAGES) {
    const req = evidenceRequirementsForStage(stage);
    const { message, details } = generateEvidenceErrorMessage(stage, EMPTY);

    // Human-readable string enumerates each REQUIRED category with current/required counts
    assert.ok(message.includes(`0/${req.deliverables} deliverables`), `${stage} message must list deliverables: ${message}`);
    assert.ok(message.includes(`0/${req.activities} activities (${ACCEPTED_EVIDENCE_ACTIVITY_TYPES.join('/')})`), `${stage} message must list activities with accepted types: ${message}`);
    if (req.knowledge > 0) {
      assert.ok(message.includes(`0/${req.knowledge} knowledge entries`), `${stage} message must list knowledge: ${message}`);
    } else {
      assert.ok(!message.includes('knowledge entries'), `${stage} must NOT mention knowledge (not required): ${message}`);
    }
    assert.ok(!message.includes('0/0'), `${stage} must never render a 0/0 category: ${message}`);

    // Structured details per category
    assert.deepEqual(details.deliverables, { current: 0, required: req.deliverables, missing: req.deliverables });
    assert.deepEqual(details.activities, {
      current: 0,
      required: req.activities,
      missing: req.activities,
      acceptedTypes: [...ACCEPTED_EVIDENCE_ACTIVITY_TYPES],
    });
    assert.deepEqual(details.knowledge, { current: 0, required: req.knowledge, missing: req.knowledge });
  }
});

test('generateEvidenceErrorMessage: partial evidence only reports the still-missing categories', () => {
  // done: deliverable + activity present, knowledge missing → only knowledge is listed as missing
  const { message, details } = generateEvidenceErrorMessage('done', { deliverables: 1, activities: 1, knowledge: 0 });
  assert.ok(message.includes('0/1 knowledge entries'), message);
  assert.ok(!message.includes('deliverables'), `satisfied categories must not be listed as missing: ${message}`);
  assert.ok(!message.includes('activities'), `satisfied categories must not be listed as missing: ${message}`);
  assert.equal(details.deliverables.missing, 0);
  assert.equal(details.activities.missing, 0);
  assert.equal(details.knowledge.missing, 1);

  // testing: deliverable present, activity missing → only activity listed as missing
  const testing = generateEvidenceErrorMessage('testing', { deliverables: 1, activities: 0, knowledge: 0 });
  assert.ok(testing.message.includes('0/1 activities'), testing.message);
  assert.ok(!testing.message.includes('deliverables'), testing.message);
  assert.ok(!testing.message.includes('knowledge'), testing.message);
  assert.equal(testing.details.deliverables.missing, 0);
  assert.equal(testing.details.activities.missing, 1);
});

test('generateEvidenceErrorMessage: satisfied gate reports all requirements met', () => {
  const { message, details } = generateEvidenceErrorMessage('done', { deliverables: 2, activities: 3, knowledge: 1 });
  assert.ok(message.includes('all evidence requirements met'), message);
  assert.equal(details.deliverables.missing, 0);
  assert.equal(details.activities.missing, 0);
  assert.equal(details.knowledge.missing, 0);
});

test('STAGE_EVIDENCE_REQUIREMENTS: thresholds match the pre-existing gate logic', () => {
  // Stage entry gates (hasStageEvidence): deliverable >= 1 + activity >= 1
  // Done gate (taskCanBeDone): + learner knowledge >= 1 (PLATFORM-004b)
  for (const stage of ['testing', 'review', 'verification']) {
    assert.deepEqual(STAGE_EVIDENCE_REQUIREMENTS[stage], { deliverables: 1, activities: 1, knowledge: 0 });
  }
  assert.deepEqual(STAGE_EVIDENCE_REQUIREMENTS.done, { deliverables: 1, activities: 1, knowledge: 1 });
});

// ── DB-backed gate evaluation ──

test('evaluateEvidenceGate: PATCH tanpa evidence blocks every gate transition with full enumeration', () => {
  for (const stage of ALL_STAGES) {
    const taskId = crypto.randomUUID();
    seedTask(taskId);

    const gate = evaluateEvidenceGate(taskId, stage);

    assert.equal(gate.met, false, `${stage} gate must fail without evidence`);
    assert.ok(gate.message.includes('missing'), `${stage} message must say what is missing: ${gate.message}`);
    assert.ok(gate.message.includes('0/1 deliverables'), `${stage}: ${gate.message}`);
    assert.ok(gate.message.includes('0/1 activities (completed/file_created/updated)'), `${stage}: ${gate.message}`);
    if (stage === 'done') {
      assert.ok(gate.message.includes('0/1 knowledge entries'), `${stage}: ${gate.message}`);
      assert.ok(gate.message.startsWith('Cannot mark done:'), `${stage} prefix: ${gate.message}`);
    } else {
      assert.ok(gate.message.startsWith('Evidence gate failed:'), `${stage} prefix: ${gate.message}`);
    }

    // `details` object, all categories populated (matches the contract in the task spec)
    assert.equal(typeof gate.details, 'object');
    assert.deepEqual(gate.details.deliverables, { current: 0, required: 1, missing: 1 });
    assert.equal(gate.details.activities.current, 0);
    assert.equal(gate.details.activities.required, 1);
    assert.equal(gate.details.activities.missing, 1);
    assert.deepEqual([...gate.details.activities.acceptedTypes], [...ACCEPTED_EVIDENCE_ACTIVITY_TYPES]);
    assert.equal(gate.details.knowledge.current, 0);
    assert.equal(gate.details.knowledge.required, stage === 'done' ? 1 : 0);
    assert.equal(gate.details.knowledge.missing, stage === 'done' ? 1 : 0);
  }
});

test('evaluateEvidenceGate: deliverable-only → activities (+ knowledge for done) still reported missing', () => {
  for (const stage of ALL_STAGES) {
    const taskId = crypto.randomUUID();
    seedTask(taskId);
    addDeliverable(taskId);

    const gate = evaluateEvidenceGate(taskId, stage);
    assert.equal(gate.met, false);
    assert.equal(gate.details.deliverables.missing, 0, `${stage} deliverable present`);
    assert.equal(gate.details.activities.missing, 1, `${stage} activity missing`);
    assert.equal(gate.details.knowledge.missing, stage === 'done' ? 1 : 0);
  }
});

test('evaluateEvidenceGate: done with evidence but no learner knowledge → knowledge is the only missing category', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  addDeliverable(taskId);
  addActivity(taskId);

  assert.equal(taskCanBeDone(taskId), false, 'done gate must still block without knowledge');

  const gate = evaluateEvidenceGate(taskId, 'done');
  assert.equal(gate.met, false);
  assert.equal(gate.details.deliverables.missing, 0);
  assert.equal(gate.details.activities.missing, 0);
  assert.equal(gate.details.knowledge.missing, 1);
  assert.ok(gate.message.includes('0/1 knowledge entries'), gate.message);
  assert.ok(!gate.message.includes('deliverables'), `satisfied categories must not be listed as missing: ${gate.message}`);
  assert.ok(!gate.message.includes('activities'), `satisfied categories must not be listed as missing: ${gate.message}`);
});

test('evaluateEvidenceGate: full evidence + knowledge passes every stage', () => {
  for (const stage of ALL_STAGES) {
    const taskId = crypto.randomUUID();
    seedTask(taskId);
    addDeliverable(taskId);
    addActivity(taskId);
    if (stage === 'done') addKnowledge(taskId);

    const gate = evaluateEvidenceGate(taskId, stage);
    assert.equal(gate.met, true, `${stage} should pass with required evidence`);
    assert.equal(gate.details.deliverables.missing, 0);
    assert.equal(gate.details.activities.missing, 0);
    assert.equal(gate.details.knowledge.missing, 0);
  }
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  addDeliverable(taskId);
  addActivity(taskId);
  addKnowledge(taskId);
  assert.equal(taskCanBeDone(taskId), true);
});

test('getEvidenceCounts: only accepted activity types count as evidence', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  addActivity(taskId, 'status_changed'); // not an accepted evidence type
  addActivity(taskId, 'note_added'); // not an accepted evidence type

  const counts = getEvidenceCounts(taskId);
  assert.equal(counts.activities, 0, 'non-evidence activity types must not count');
  assert.equal(counts.deliverables, 0);
  assert.equal(counts.knowledge, 0);
});

test('hasValidationFailureFlag: status_reason containing "fail" blocks done independent of evidence', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  addDeliverable(taskId);
  addActivity(taskId);
  addKnowledge(taskId);

  assert.equal(hasValidationFailureFlag(taskId), false);
  assert.equal(taskCanBeDone(taskId), true);

  run(`UPDATE tasks SET status_reason = 'Validation failed: CSS broken' WHERE id = ?`, [taskId]);
  assert.equal(hasValidationFailureFlag(taskId), true);
  assert.equal(taskCanBeDone(taskId), false, 'validation failure must block done even with full evidence');

  // The evidence itself is complete — the flag is what blocks; message must say so
  const gate = evaluateEvidenceGate(taskId, 'done');
  assert.equal(gate.met, true, 'evidence requirements are satisfied');
  assert.ok(gate.message.includes('all evidence requirements met'), gate.message);
});
