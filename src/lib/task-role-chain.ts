/**
 * PLATFORM-004b: task handshake role chain.
 *
 * Builds the per-task role chain — main → builder → tester → reviewer →
 * verifier → (learner hook) — with a per-role status badge
 * (pending | active | done | failed) derived from the task's workflow
 * template, current status, role assignments, latest stage failure and the
 * learner knowledge gate.
 *
 * Used by GET /api/tasks and GET /api/tasks/[id] so the UI task cards can
 * render the handshake chain without per-card fetches.
 */

import { queryAll } from '@/lib/db';
import type { Task } from '@/lib/types';

export interface RoleChainNode {
  role: string;
  label: string;
  emoji: string;
  agentName?: string | null;
  status: 'pending' | 'active' | 'done' | 'failed';
}

export type RoleChainStatus = RoleChainNode['status'];

const ROLE_META: Record<string, { label: string; emoji: string }> = {
  main: { label: 'Main', emoji: '🧭' },
  builder: { label: 'Builder', emoji: '🛠️' },
  tester: { label: 'Tester', emoji: '🧪' },
  reviewer: { label: 'Reviewer', emoji: '🔍' },
  verifier: { label: 'Verifier', emoji: '✅' },
  learner: { label: 'Learner', emoji: '📚' },
};

export const CHAIN_ROLE_ORDER = ['main', 'builder', 'tester', 'reviewer', 'verifier', 'learner'];

interface TemplateRow {
  id: string;
  workspace_id: string;
  stages: string;
  fail_targets: string;
  is_default: number;
}

interface StageRow {
  id: string;
  label: string;
  role: string | null;
  status: string;
}

/** Resolve the workflow template stages for a task (task-specific → workspace default → global default). */
function resolveStages(
  task: Pick<Task, 'id' | 'workspace_id' | 'workflow_template_id'>,
  templatesByWorkspace: Map<string, TemplateRow[]>,
  templatesById: Map<string, TemplateRow>,
): StageRow[] {
  let tpl: TemplateRow | undefined;
  if (task.workflow_template_id) {
    tpl = templatesById.get(task.workflow_template_id);
  }
  if (!tpl) {
    const wsTemplates = templatesByWorkspace.get(task.workspace_id) || [];
    tpl = wsTemplates.find(t => Number(t.is_default) === 1);
  }
  if (!tpl) {
    // Global default fallback (first default across workspaces)
    for (const list of Array.from(templatesByWorkspace.values())) {
      const globalDefault = list.find(t => Number(t.is_default) === 1);
      if (globalDefault) {
        tpl = globalDefault;
        break;
      }
    }
  }
  if (!tpl) return [];
  try {
    return JSON.parse(tpl.stages || '[]') as StageRow[];
  } catch {
    return [];
  }
}

interface ChainInput {
  tasks: Task[];
}

/**
 * Attach `role_chain` and `knowledge_count` to each task in-place (mutates the
 * task objects so callers can spread them straight into API responses).
 */
export function attachRoleChains({ tasks }: ChainInput): void {
  if (!tasks || tasks.length === 0) return;

  const ids = tasks.map(t => t.id);
  const placeholders = ids.map(() => '?').join(',');
  const idParams: string[] = ids;

  // Knowledge counts per task (learner gate state)
  const knowledgeCounts = new Map<string, number>();
  for (const row of queryAll<{ task_id: string; count: number }>(
    `SELECT task_id, COUNT(*) as count FROM knowledge_entries WHERE task_id IN (${placeholders}) GROUP BY task_id`,
    idParams
  )) {
    knowledgeCounts.set(row.task_id, Number(row.count || 0));
  }

  // Role assignments (agent names per role per task)
  const rolesByTask = new Map<string, Map<string, string | null>>();
  for (const row of queryAll<{ task_id: string; role: string; agent_name: string | null }>(
    `SELECT tr.task_id, tr.role, a.name as agent_name
     FROM task_roles tr
     LEFT JOIN agents a ON tr.agent_id = a.id
     WHERE tr.task_id IN (${placeholders})`,
    idParams
  )) {
    const roleKey = (row.role || '').trim().toLowerCase();
    if (!roleKey) continue;
    let map = rolesByTask.get(row.task_id);
    if (!map) {
      map = new Map();
      rolesByTask.set(row.task_id, map);
    }
    if (!map.has(roleKey)) map.set(roleKey, row.agent_name);
  }

  // Latest stage failure per task ("Stage failed: <status> → <target> ...")
  const latestFailure = new Map<string, string>();
  for (const row of queryAll<{ task_id: string; message: string }>(
    `SELECT task_id, message FROM task_activities
     WHERE activity_type = 'status_changed' AND message LIKE 'Stage failed:%' AND task_id IN (${placeholders})
     ORDER BY created_at DESC`,
    idParams
  )) {
    if (!latestFailure.has(row.task_id)) {
      latestFailure.set(row.task_id, row.message);
    }
  }

  // Templates: fetch all involved workspaces + task-specific template ids once
  const workspaceIds = Array.from(new Set(tasks.map(t => t.workspace_id)));
  const templateIds = Array.from(new Set(tasks.map(t => t.workflow_template_id).filter(Boolean))) as string[];
  const wsPlaceholders = workspaceIds.map(() => '?').join(',');
  const tplPlaceholders = templateIds.map(() => '?').join(',');

  const templatesByWorkspace = new Map<string, TemplateRow[]>();
  const templatesById = new Map<string, TemplateRow>();

  if (workspaceIds.length > 0) {
    for (const row of queryAll<TemplateRow>(
      `SELECT * FROM workflow_templates WHERE workspace_id IN (${wsPlaceholders})`,
      workspaceIds
    )) {
      templatesById.set(row.id, row);
      const list = templatesByWorkspace.get(row.workspace_id) || [];
      list.push(row);
      templatesByWorkspace.set(row.workspace_id, list);
    }
  }
  if (templateIds.length > 0) {
    for (const row of queryAll<TemplateRow>(
      `SELECT * FROM workflow_templates WHERE id IN (${tplPlaceholders})`,
      templateIds
    )) {
      templatesById.set(row.id, row);
      const list = templatesByWorkspace.get(row.workspace_id) || [];
      list.push(row);
      templatesByWorkspace.set(row.workspace_id, list);
    }
  }

  for (const task of tasks) {
    const knowledgeCount = knowledgeCounts.get(task.id) || 0;
    const stages = resolveStages(task, templatesByWorkspace, templatesById);
    const roleMap = rolesByTask.get(task.id) || new Map<string, string | null>();
    const inFailure = (task.status_reason || '').toLowerCase().includes('fail');

    const chain: RoleChainNode[] = [];

    // main — orchestrator/master; active while planning, done once handed off
    chain.push({
      role: 'main',
      label: ROLE_META.main.label,
      emoji: ROLE_META.main.emoji,
      agentName: roleMap.get('main') ?? null,
      status: task.status === 'planning' || task.status === 'inbox' ? 'active' : 'done',
    });

    // Stage roles in template order
    const currentIdx = stages.findIndex(s => s.status === task.status);

    // Failed stage → role mapping (only relevant while the task is in failure fallout)
    let failedRole: string | null = null;
    if (inFailure) {
      const failMsg = latestFailure.get(task.id);
      if (failMsg) {
        const match = /^Stage failed:\s*([^\s→]+)/.exec(failMsg);
        if (match) {
          const failedStage = stages.find(s => s.status === match[1]);
          if (failedStage?.role) failedRole = failedStage.role;
        }
      }
    }

    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      if (!s.role) continue;
      const roleKey = s.role.trim().toLowerCase();
      const meta = ROLE_META[roleKey] || { label: s.role, emoji: '🔧' };

      let status: RoleChainStatus;
      if (task.status === 'done') {
        status = 'done';
      } else if (inFailure && failedRole === roleKey && i > currentIdx) {
        // The role that failed (e.g. verifier) stays marked failed while the
        // task sits in the failure fallout (back at the fail-target stage).
        status = 'failed';
      } else if (i < currentIdx) {
        status = 'done';
      } else if (i === currentIdx) {
        status = 'active';
      } else {
        status = 'pending';
      }

      chain.push({
        role: roleKey,
        label: meta.label,
        emoji: meta.emoji,
        agentName: roleMap.get(roleKey) ?? null,
        status,
      });
    }

    // learner — fire-and-forget hook appended last. Status reflects the gate:
    // done once >=1 knowledge entry exists; pending (blocking) when the task is
    // done but the learner hasn't written anything; active while task is live.
    let learnerStatus: RoleChainStatus = 'active';
    if (knowledgeCount > 0) learnerStatus = 'done';
    else if (task.status === 'done') learnerStatus = 'pending';
    chain.push({
      role: 'learner',
      label: ROLE_META.learner.label,
      emoji: ROLE_META.learner.emoji,
      agentName: roleMap.get('learner') ?? null,
      status: learnerStatus,
    });

    (task as Task & { role_chain?: RoleChainNode[]; knowledge_count?: number }).role_chain = chain;
    (task as Task & { role_chain?: RoleChainNode[]; knowledge_count?: number }).knowledge_count = knowledgeCount;
  }
}
