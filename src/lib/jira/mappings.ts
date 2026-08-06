import type { TaskStatus, TaskPriority } from '../types';

// ── MC Status → Jira Status Name ──────────────────────────────────────
const statusToJira: Record<TaskStatus, string> = {
  inbox: 'To Do',
  planning: 'To Do',
  assigned: 'To Do',
  pending_dispatch: 'To Do',
  in_progress: 'In Progress',
  convoy_active: 'In Progress',
  testing: 'In Review',
  review: 'In Review',
  verification: 'In Review',
  review_fix: 'In Progress',
  menunggu_keputusan_manusia: 'To Do',
  done: 'Done',
};

export function mcStatusToJira(status: TaskStatus): string {
  return statusToJira[status] || 'To Do';
}

// ── Jira Status → MC Status ──────────────────────────────────────────
// First try exact status name, then fall back to Jira status category.
const jiraStatusNameToMc: Record<string, TaskStatus> = {
  'to do': 'inbox',
  'in progress': 'in_progress',
  'in review': 'review',
  'done': 'done',
};

// Jira status categories: 'new' | 'indeterminate' | 'done'
const jiraCategoryToMc: Record<string, TaskStatus> = {
  new: 'inbox',
  indeterminate: 'in_progress',
  done: 'done',
};

export function jiraStatusToMc(
  statusName: string,
  statusCategoryKey?: string,
): TaskStatus {
  const byName = jiraStatusNameToMc[statusName.toLowerCase()];
  if (byName) return byName;

  if (statusCategoryKey) {
    const byCat = jiraCategoryToMc[statusCategoryKey.toLowerCase()];
    if (byCat) return byCat;
  }

  return 'inbox';
}

// ── Priority mappings ─────────────────────────────────────────────────
const priorityToJira: Record<TaskPriority, string> = {
  low: 'Low',
  normal: 'Medium',
  high: 'High',
  urgent: 'Highest',
};

export function mcPriorityToJira(priority: TaskPriority): string {
  return priorityToJira[priority] || 'Medium';
}

const jiraPriorityMap: Record<string, TaskPriority> = {
  lowest: 'low',
  low: 'low',
  medium: 'normal',
  high: 'high',
  highest: 'urgent',
};

export function jiraPriorityToMc(priorityName: string): TaskPriority {
  return jiraPriorityMap[priorityName.toLowerCase()] || 'normal';
}
