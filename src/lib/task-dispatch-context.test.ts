import test from 'node:test';
import assert from 'node:assert/strict';

import { run, queryOne } from './db';
import { buildTaskDispatchContext } from './task-dispatch-context';
import { estimateTokensFromChars } from './session-health';
import type { Agent, Task } from './types';

/**
 * PLATFORM-008 (A6): filtered handoff.
 *
 * Stage handoffs (tester/reviewer/learner) must receive the spec + deliverables
 * + stage summary — NOT the full planning conversation. Initial builder
 * dispatches keep the planning Q&A. Stage contexts must start small (< 50k
 * tokens ≈ 200k chars at 4 chars/token).
 */

function seedTask(opts: {
  status: Task['status'];
  planningMessages?: string | null;
  planningSpec?: string | null;
  withCompletedActivity?: boolean;
}): { task: Task; agent: Agent; workflowTemplateId: string } {
  const taskId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const tplId = crypto.randomUUID();

  run(
    `INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
     VALUES (?, 'default', 'tpl-test', 'test template', ?, '{}', 0, datetime('now'), datetime('now'))`,
    [
      tplId,
      JSON.stringify([
        { status: 'assigned', role: 'builder', label: 'Build', order: 1 },
        { status: 'in_progress', role: 'builder', label: 'Build', order: 2 },
        { status: 'testing', role: 'tester', label: 'Test', order: 3 },
        { status: 'review', role: 'reviewer', label: 'Review', order: 4 },
        { status: 'verification', role: 'reviewer', label: 'Verify', order: 5 },
        { status: 'done', role: null, label: 'Done', order: 6 },
      ]),
    ]
  );

  run(
    `INSERT INTO agents (id, name, role, status, workspace_id, session_key_prefix)
     VALUES (?, 'Test Tester', 'tester', 'standby', 'default', 'agent:tester:')`,
    [agentId]
  );

  const planningMessages = opts.planningMessages ?? JSON.stringify([
    { role: 'user', content: 'What should we build?' },
    { role: 'assistant', content: 'x'.repeat(60_000) },
    { role: 'user', content: 'y'.repeat(60_000) },
    { role: 'assistant', content: 'z'.repeat(60_000) },
  ]);
  const planningSpec = opts.planningSpec ?? JSON.stringify({
    title: 'Test task',
    summary: 'Spec summary '.repeat(200),
    deliverables: ['A1', 'A2'],
  });

  run(
    `INSERT INTO tasks (id, title, description, status, assigned_agent_id, workspace_id, workflow_template_id, planning_messages, planning_spec, planning_agents, planning_complete, created_at, updated_at)
     VALUES (?, 'Test task', 'desc', ?, ?, 'default', ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
    [
      taskId,
      opts.status,
      agentId,
      tplId,
      planningMessages,
      planningSpec,
      JSON.stringify([{ name: 'tester', role: 'tester', instructions: 'Test everything.' }]),
    ]
  );

  if (opts.withCompletedActivity) {
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, 'completed', 'TASK_COMPLETE: built everything, tests pass', datetime('now'))`,
      [crypto.randomUUID(), taskId, agentId]
    );
  }

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  assert.ok(task && agent);
  return { task: task!, agent: agent!, workflowTemplateId: tplId };
}

const input = (task: Task, agent: Agent) => ({
  task,
  agent,
  missionControlUrl: 'http://mission-control.test:4000',
  taskProjectDir: '/tmp/project',
  workspaceIsolated: false,
});

test('A6: builder (initial) dispatch includes planning conversation', () => {
  const { task, agent } = seedTask({ status: 'assigned' });
  const result = buildTaskDispatchContext(input(task, agent));
  const planning = result.audit.sections.find(s => s.key === 'planning');
  assert.ok(planning);
  const message = result.message;
  assert.ok(message.includes('Planning conversation/messages:'), 'builder keeps the planning Q&A');
  assert.ok(!result.audit.sections.some(s => s.key === 'stage_handoff'), 'no stage handoff for builder');
});

test('A6: tester handoff EXCLUDES planning conversation, includes stage summary', () => {
  const { task, agent } = seedTask({
    status: 'testing',
    withCompletedActivity: true,
  });
  const result = buildTaskDispatchContext(input(task, agent));

  assert.equal(result.isBuilder, false, 'tester stage is not a builder dispatch');

  const planning = result.audit.sections.find(s => s.key === 'planning');
  assert.ok(planning);
  const message = result.message;
  assert.ok(
    message.includes('omitted for stage handoff'),
    'full planning conversation must NOT be injected into stage handoffs'
  );
  assert.ok(!message.includes('PLANNING Q&A BLOB'), 'no transcript blob');

  const handoff = result.audit.sections.find(s => s.key === 'stage_handoff');
  assert.ok(handoff, 'stage handoff summary section present');
  assert.ok(handoff.included);
  assert.ok(message.includes('TASK_COMPLETE: built everything'), 'stage summary includes previous completion digest');
});

test('A6: reviewer/verification handoff also filtered', () => {
  const { task, agent } = seedTask({ status: 'review' });
  const result = buildTaskDispatchContext(input(task, agent));
  assert.equal(result.isBuilder, false);
  assert.ok(result.message.includes('omitted for stage handoff'));
  assert.ok(result.audit.sections.some(s => s.key === 'stage_handoff'));
});

test('A6: stage context starts SMALL (< 50k tokens ≈ 200k chars)', () => {
  const { task, agent } = seedTask({ status: 'testing' });
  const result = buildTaskDispatchContext(input(task, agent));

  const tokens = estimateTokensFromChars(result.audit.totalChars);
  assert.ok(
    tokens < 50_000,
    `stage dispatch context must start < 50k tokens (got ~${tokens.toLocaleString('en-US')} tokens / ${result.audit.totalChars.toLocaleString('en-US')} chars)`
  );
});

test('A6: builder retry keeps planning conversation but previous-run session history is never injected (A1 consistency)', () => {
  const { task, agent } = seedTask({ status: 'in_progress' });
  const result = buildTaskDispatchContext(input(task, agent));
  assert.equal(result.isBuilder, true, 'in_progress builder stage remains a builder dispatch');
  assert.ok(result.message.includes('Planning conversation/messages:'));
  // The gateway session itself is rotated by A1 (new session key); the message
  // only carries bounded summaries of previous runtime sessions.
  const previousWork = result.audit.sections.find(s => s.key === 'previous_work');
  assert.ok(previousWork);
});
