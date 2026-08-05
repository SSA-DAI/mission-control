/**
 * PLATFORM-005: Canonical agent lifecycle management.
 *
 * Canonical agents (builder/tester/reviewer/verifier/learner) are created ONCE per
 * workspace and reused across planning cycles. This replaces the old behaviour
 * where force-complete created a new agent per spec entry, ballooning the
 * agent catalogue (mrnav-* 26 agents for 1 task).
 */

import { queryOne, run } from '@/lib/db';
import { CANONICAL_ROLE_PREFIXES, getSessionKeyPrefix, resolveAgentSessionPrefix } from '@/lib/agent-prefix';

export const CANONICAL_ROLES = ['builder', 'tester', 'reviewer', 'verifier', 'learner'] as const;
export type CanonicalRole = typeof CANONICAL_ROLES[number];

/**
 * Word-boundary keyword patterns per canonical role.
 *
 * PLATFORM-012 fix: the previous implementation used naive substring matching
 * (key.includes(kw)) with builder keywords checked first, so realistic
 * LLM-generated role strings mis-mapped: 'review code' / 'code reviewer' →
 * builder (via 'code'), 'test the build' → builder (via 'build'). That is exactly
 * the role-confusion class this module exists to prevent permanently.
 *
 * Rules:
 *  - Keywords match on WORD BOUNDARIES, with stems so 'verify' also matches
 *    'verification'/'verifier', 'test' matches 'testing'/'tester', etc.
 *  - Specialized action roles (tester/reviewer/verifier/learner) take precedence
 *    over builder: builder keywords ('build','code','fix','implement',...) are the
 *    most generic and only win when NO specialized role matched.
 *  - Among matching roles the longest matched term wins (more specific keyword).
 */
const ROLE_PATTERNS: Record<CanonicalRole, RegExp> = {
  builder: /\b(?:architect|build|code|develop|engineer|fix|implement|program)\w*/,
  tester: /\b(?:qa\b|test|validat|qualit|ensur)\w*/,
  reviewer: /\b(?:audit|check|examin|inspect|review)\w*/,
  verifier: /\b(?:accept|approv|final\s+gate|verdict|verif)\w*/,
  learner: /\b(?:analy|assess|document|explor|learn|research|stud)\w*/,
};

// Specialized action roles are checked BEFORE builder — see rules above.
const SPECIALIZED_MATCH_ORDER: CanonicalRole[] = ['tester', 'reviewer', 'verifier', 'learner'];

const DISPLAY_NAMES: Record<CanonicalRole, string> = {
  builder: 'Builder',
  tester: 'Tester',
  reviewer: 'Reviewer',
  verifier: 'Verifier',
  learner: 'Learner',
};

const EMOJIS: Record<CanonicalRole, string> = {
  builder: '🏗️',
  tester: '🧪',
  reviewer: '🔍',
  verifier: '✅',
  learner: '📚',
};

export interface ResolvePlanningAgentResult {
  agentId: string;
  isCanonical: boolean;
  prefix: string | null;
}

/**
 * PLATFORM-012: Resolve a planning agent spec to either a canonical agent (reuse
 * existing) or a custom agent slot (caller creates). Shared by planning-completion
 * (normal poll/answer path) and auto-answer (approveAndDispatch).
 *
 * Canonical roles (builder/tester/reviewer/verifier/learner) always reuse existing
 * canonical agents via ensureCanonicalAgent(). Non-canonical roles create new
 * agents only when allowDynamic=true. Deduplicates canonical roles via seenRoles
 * to prevent multiple lookups for the same role within a single planning cycle.
 *
 * Returns null when the agent cannot be resolved (non-canonical + dynamic disabled,
 * already-deduplicated canonical role, or missing workspace for non-canonical).
 */
export function resolvePlanningAgent(
  workspaceId: string | null,
  agentSpec: { name: string; role: string; instructions?: string; avatar_emoji?: string; soul_md?: string },
  allowDynamic: boolean,
  seenRoles: Set<CanonicalRole>
): ResolvePlanningAgentResult | null {
  const roleKey = agentSpec.role || agentSpec.name || '';
  const canonicalRole = mapRoleToCanonical(roleKey);

  if (canonicalRole) {
    // Dedup: only one canonical agent per role per planning cycle.
    // Prevents duplicate canonical lookups when a planning spec lists
    // multiple agents that match the same canonical role.
    if (seenRoles.has(canonicalRole)) return null;
    seenRoles.add(canonicalRole);

    const agentId = ensureCanonicalAgent(workspaceId || 'default', canonicalRole);
    const prefix = CANONICAL_ROLE_PREFIXES[canonicalRole] || null;
    return { agentId, isCanonical: true, prefix };
  }

  // Non-canonical role — only create when dynamic agents are allowed
  if (!allowDynamic) return null;
  if (!workspaceId) return null;

  const prefix = resolveAgentSessionPrefix(workspaceId, agentSpec.name)
    || getSessionKeyPrefix(agentSpec.role);

  return { agentId: crypto.randomUUID(), isCanonical: false, prefix };
}

/**
 * Map a planning-spec agent name/role to a canonical role.
 *
 * 1) Exact role-name match ('builder', 'tester', ...) always wins.
 * 2) Otherwise word-boundary keyword matching, specialized action roles first
 *    (tester/reviewer/verifier/learner) — an explicit action verb in the role
 *    string (e.g. 'test the build', 'review code') always beats generic builder
 *    words ('build', 'code').
 * 3) Builder is the fallback when no specialized role matched.
 */
export function mapRoleToCanonical(nameOrRole: string): CanonicalRole | null {
  const key = (nameOrRole || '').trim().toLowerCase();
  if (!key) return null;

  // Exact role-name match wins outright: 'builder', 'TeStEr', ...
  const exact = CANONICAL_ROLES.find((r) => r === key);
  if (exact) return exact;

  // Specialized action roles first, longest matched term wins.
  const specialized = longestKeywordMatch(key, SPECIALIZED_MATCH_ORDER);
  if (specialized) return specialized;

  // Builder is the fallback — its keywords must never override an explicit
  // test/review/verify/learn action verb.
  return longestKeywordMatch(key, ['builder']);
}

function longestKeywordMatch(key: string, roles: CanonicalRole[]): CanonicalRole | null {
  let best: CanonicalRole | null = null;
  let bestLen = 0;
  for (const role of roles) {
    const m = ROLE_PATTERNS[role].exec(key);
    if (m && m[0].length > bestLen) {
      best = role;
      bestLen = m[0].length;
    }
  }
  return best;
}

/**
 * Ensure a canonical agent exists in the given workspace (create-once).
 * Returns the agent id. Creates only if no canonical agent with that role
 * already exists in the workspace.
 */
export function ensureCanonicalAgent(workspaceId: string, role: CanonicalRole): string {
  const prefix = CANONICAL_ROLE_PREFIXES[role];
  const sessionKeyPrefix = prefix || null;

  // Query for existing canonical agent in this workspace.
  // PLATFORM-005 fix: bootstrap core agents (migration 013 / bootstrapCoreAgents)
  // are created WITHOUT session_key_prefix (NULL). A stored NULL prefix must match
  // any requested canonical prefix for the same (workspace, role) — otherwise the
  // create-once guarantee fails and a duplicate canonical agent is created.
  // Prefer an exact session_key_prefix match when both exist (e.g. default workspace
  // has gateway-synced agents with prefixes alongside NULL-prefix bootstrap agents)
  // so dispatch keeps resolving to the gateway-backed agent.
  const existing = queryOne<{ id: string }>(
    `SELECT id FROM agents
     WHERE workspace_id = ?
       AND role = ?
       AND (session_key_prefix = ? OR session_key_prefix IS NULL)
       AND status != 'offline'
     ORDER BY CASE WHEN session_key_prefix IS NULL THEN 1 ELSE 0 END
     LIMIT 1`,
    [workspaceId, role, sessionKeyPrefix]
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
