/**
 * PLATFORM-005: Canonical agent lifecycle management.
 *
 * Canonical agents (builder/tester/reviewer/learner) are created ONCE per
 * workspace and reused across planning cycles. This replaces the old behaviour
 * where force-complete created a new agent per spec entry, ballooning the
 * agent catalogue (mrnav-* 26 agents for 1 task).
 */

import { queryOne, run } from '@/lib/db';
import { CANONICAL_ROLE_PREFIXES } from '@/lib/agent-prefix';

export const CANONICAL_ROLES = ['builder', 'tester', 'reviewer', 'learner'] as const;
export type CanonicalRole = typeof CANONICAL_ROLES[number];

const ROLE_KEYWORDS: Record<CanonicalRole, string[]> = {
  builder: ['build', 'architect', 'code', 'implement', 'develop', 'program', 'engineer', 'fix'],
  tester: ['test', 'qa', 'verify', 'validate', 'quality', 'ensure'],
  reviewer: ['review', 'audit', 'inspect', 'examine', 'check'],
  learner: ['learn', 'research', 'analyze', 'document', 'study', 'explore', 'assess'],
};

const DISPLAY_NAMES: Record<CanonicalRole, string> = {
  builder: 'Builder',
  tester: 'Tester',
  reviewer: 'Reviewer',
  learner: 'Learner',
};

const EMOJIS: Record<CanonicalRole, string> = {
  builder: '🏗️',
  tester: '🧪',
  reviewer: '🔍',
  learner: '📚',
};

/** Map a planning-spec agent name/role to a canonical role via keyword matching. */
export function mapRoleToCanonical(nameOrRole: string): CanonicalRole | null {
  const key = nameOrRole.toLowerCase();
  for (const role of CANONICAL_ROLES) {
    for (const kw of ROLE_KEYWORDS[role]) {
      if (key.includes(kw)) return role;
    }
  }
  return null;
}

/**
 * Ensure a canonical agent exists in the given workspace (create-once).
 * Returns the agent id. Creates only if no canonical agent with that role
 * already exists in the workspace.
 */
export function ensureCanonicalAgent(workspaceId: string, role: CanonicalRole): string {
  const prefix = CANONICAL_ROLE_PREFIXES[role];
  const sessionKeyPrefix = prefix || null;

  // Query for existing canonical agent in this workspace
  const existing = queryOne<{ id: string }>(
    `SELECT id FROM agents
     WHERE workspace_id = ?
       AND role = ?
       AND (session_key_prefix = ? OR (session_key_prefix IS NULL AND ? IS NULL))
       AND status != 'offline'
     LIMIT 1`,
    [workspaceId, role, sessionKeyPrefix, sessionKeyPrefix]
  );
  if (existing) return existing.id;

  // Create the canonical agent for this workspace
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  run(
    `INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, session_key_prefix, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'standby', ?, 'local', ?, ?)`,
    [
      id,
      workspaceId,
      DISPLAY_NAMES[role],
      role,
      `Canonical ${role} agent for workspace`,
      EMOJIS[role],
      sessionKeyPrefix,
      now,
      now,
    ]
  );
  return id;
}
