import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { run, queryOne } from '@/lib/db';
import { buildTaskDispatchContext } from '@/lib/task-dispatch-context';
import type { Agent, Task } from '@/lib/types';

/**
 * PLATFORM-009 (D6): efficiency guidance + hygiene artifacts.
 *
 * Asserts:
 *  1. The dispatcher prompt (dispatch spec) contains the B1–B3 efficiency
 *     summary: batched reads, rm -rf ownership-check prohibition, bounded
 *     tool output, and a pointer to the full rules file.
 *  2. The full rules file (.openclaw/rules/agent-efficiency.md) exists and
 *     contains anti-pattern examples + an escape hatch.
 *  3. The maintenance hygiene checklist + root-cause doc exist and cover the
 *     required steps and at least 2 root causes.
 *
 * NOTE on framework: this repo's test harness is `tsx --test` (node:test),
 * not Vitest — see package.json `test` script (tsx --test over all src *.test.ts
 * files, glob expanded by the shell). The PLATFORM-009 planning spec assumed
 * Vitest; the test is written against the repo's actual harness so `npm test`
 * runs it and stays green. The test structure (describe/it/assert) ports 1:1
 * to Vitest if the harness ever moves.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RULES_FILE = path.join(REPO_ROOT, '.openclaw', 'rules', 'agent-efficiency.md');
const CHECKLIST_FILE = path.join(REPO_ROOT, 'docs', 'maintenance-hygiene-checklist.md');
const ROOTCAUSE_FILE = path.join(REPO_ROOT, 'docs', 'PLATFORM-009-root-cause-nm-root.md');

function seedTask(): { task: Task; agent: Agent } {
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
     VALUES (?, 'Eff Tester', 'tester', 'standby', 'default', 'agent:tester:')`,
    [agentId]
  );

  run(
    `INSERT INTO tasks (id, title, description, status, assigned_agent_id, workspace_id, workflow_template_id, planning_messages, planning_spec, planning_agents, planning_complete, created_at, updated_at)
     VALUES (?, 'PLATFORM-009 test', 'desc', 'assigned', ?, 'default', ?, NULL, NULL, NULL, 1, datetime('now'), datetime('now'))`,
    [taskId, agentId, tplId]
  );

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  assert.ok(task && agent, 'seed rows must exist');
  return { task: task!, agent: agent! };
}

function buildDispatchMessage(): { message: string; audit: ReturnType<typeof buildTaskDispatchContext>['audit'] } {
  const { task, agent } = seedTask();
  const result = buildTaskDispatchContext({
    task,
    agent,
    missionControlUrl: 'http://mission-control.test:4000',
    taskProjectDir: '/tmp/project',
    workspaceIsolated: false,
  });
  return { message: result.message, audit: result.audit };
}

test('PLATFORM-009: dispatch spec injects the Agent Efficiency Rules section (B1–B3)', () => {
  const { message, audit } = buildDispatchMessage();

  // Section header + summary line
  assert.ok(message.includes('Agent Efficiency Rules (PLATFORM-009)'), 'efficiency section header present');
  assert.ok(message.includes('MRN-104'), 'section cites the originating incident');

  // B1 — batched reads
  assert.ok(message.includes('BATCH FILE READS'), 'B1 rule present');
  assert.ok(message.includes('cat a.ts b.ts c.ts'), 'B1 gives the concrete batching example');
  assert.ok(message.includes('one exec per file'), 'B1 anti-pattern called out');

  // B2 — destructive ops require ownership check
  assert.ok(message.includes('rm -rf'), 'B2 mentions the dangerous command class');
  assert.ok(message.includes('ls -ld'), 'B2 requires ls -ld before destructive ops');
  assert.ok(message.includes('uid 0'), 'B2 names root ownership explicitly');
  assert.ok(message.includes('STOP'), 'B2 stop-and-report instruction present');

  // B3 — bounded output
  assert.ok(message.includes('BOUND TOOL OUTPUT'), 'B3 rule present');
  assert.ok(message.includes('head -200'), 'B3 gives a concrete output-bound example');
  assert.ok(message.includes('grep -c'), 'B3 mentions grep -c summary pattern');

  // Pointer to the full rules file
  assert.ok(message.includes('.openclaw/rules/agent-efficiency.md'), 'dispatch spec points at the full rules file');

  // The section must stay small (it is a summary — no bloat in the prompt)
  const effSection = audit.sections.find(s => s.key === 'efficiency');
  assert.ok(effSection, 'efficiency section is tracked in the dispatch audit');
  assert.ok(effSection!.charCount < 5000, `efficiency summary stays compact (got ${effSection!.charCount} chars)`);
});

test('PLATFORM-009: rules file exists with anti-patterns and escape hatch', () => {
  assert.ok(fs.existsSync(RULES_FILE), `rules file exists at ${RULES_FILE}`);
  const content = fs.readFileSync(RULES_FILE, 'utf8');

  assert.ok(content.includes('B1'), 'rules file covers B1');
  assert.ok(content.includes('B2'), 'rules file covers B2');
  assert.ok(content.includes('B3'), 'rules file covers B3');
  assert.ok(content.includes('ANTI-PATTERN'), 'rules file has anti-pattern examples');
  assert.ok(content.includes('Escape hatch'), 'rules file has an escape hatch section');
  assert.ok(content.includes('ls -ld'), 'rules file keeps the ls -ld requirement');
  assert.ok(content.includes('uid 1000'), 'rules file references the uid 1000 target');
});

test('PLATFORM-009: maintenance checklist is valid (audit → verify → clean → fix → verify → report)', () => {
  assert.ok(fs.existsSync(CHECKLIST_FILE), `checklist exists at ${CHECKLIST_FILE}`);
  const content = fs.readFileSync(CHECKLIST_FILE, 'utf8');

  assert.ok(content.includes('Audit'), 'checklist has an audit step');
  assert.ok(content.includes('find /workspace/awanfleet'), 'audit step covers the fleet root');
  assert.ok(content.includes('ls -ld'), 'checklist verifies ownership before cleanup');
  assert.ok(content.includes('Clean'), 'checklist has a cleanup step');
  assert.ok(content.includes('chown -R 1000:1000'), 'checklist documents the uid-1000 ownership fix');
  assert.ok(content.includes('Verify'), 'checklist has a verification step');
  assert.ok(content.includes('Report'), 'checklist has a reporting step');
  assert.ok(content.includes('.nm-root-*'), 'checklist targets the junk pattern');
});

test('PLATFORM-009: root-cause doc explains ≥ 2 causes of .nm-root-*', () => {
  assert.ok(fs.existsSync(ROOTCAUSE_FILE), `root-cause doc exists at ${ROOTCAUSE_FILE}`);
  const content = fs.readFileSync(ROOTCAUSE_FILE, 'utf8');

  assert.ok(content.includes('--prefix'), 'cause 1: wrong npm --prefix');
  assert.ok(content.includes('nixpacks'), 'cause 2: containerized nixpacks builds');
  assert.ok(content.includes('uid 1000'), 'doc names the target uid');
  assert.ok(content.includes('node_modules'), 'doc covers node_modules ownership consistency');
});
