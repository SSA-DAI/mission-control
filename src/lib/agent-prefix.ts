import { queryOne } from '@/lib/db';

/**
 * PLATFORM-002: Central resolver for OpenClaw gateway session prefixes.
 *
 * NEVER falls back to the legacy 'agent:main:' prefix — that agent does not
 * exist in the OpenClaw gateway integration (canonical agents are
 * manager/builder/tester/reviewer/learner), so any dispatch that used it
 * failed with 503 "Agent \"main\" no longer exists in configuration".
 * Callers must handle a null result explicitly (error or skip).
 */

export const CANONICAL_ROLE_PREFIXES: Record<string, string> = {
  main: 'agent:main:',
  builder: 'agent:builder:',
  tester: 'agent:tester:',
  reviewer: 'agent:reviewer:',
  learner: 'agent:learner:',
};

/** Prefix of the workspace's master agent (is_master=1), if any. */
export function getMasterAgentPrefix(workspaceId: string | null | undefined): string | null {
  if (!workspaceId) return null;
  const master = queryOne<{ session_key_prefix: string | null }>(
    `SELECT session_key_prefix FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
    [workspaceId]
  );
  return master?.session_key_prefix || null;
}

/**
 * Resolve a gateway session prefix for an agent name or role string.
 *
 * 1) Exact match against a gateway-synced agent (source='gateway', lower(name)).
 * 2) Canonical role map (manager/builder/tester/reviewer/learner), but only
 *    when a gateway-synced agent actually exists for that prefix — so we never
 *    return a prefix that would 503 at dispatch time.
 */
export function getGatewayAgentPrefix(nameOrRole: string | null | undefined): string | null {
  if (!nameOrRole) return null;
  const key = nameOrRole.trim().toLowerCase();
  if (!key) return null;

  const byName = queryOne<{ session_key_prefix: string | null }>(
    `SELECT session_key_prefix FROM agents WHERE source = 'gateway' AND lower(name) = ? AND session_key_prefix IS NOT NULL LIMIT 1`,
    [key]
  );
  if (byName?.session_key_prefix) return byName.session_key_prefix;

  for (const [role, prefix] of Object.entries(CANONICAL_ROLE_PREFIXES)) {
    if (key === role || key.includes(role)) {
      const gw = queryOne<{ id: string }>(
        `SELECT id FROM agents WHERE source = 'gateway' AND session_key_prefix = ? LIMIT 1`,
        [prefix]
      );
      if (gw) return prefix;
    }
  }

  return null;
}

/** Full resolution: master prefix first, then canonical gateway fallback. */
export function resolveAgentSessionPrefix(
  workspaceId: string | null | undefined,
  nameOrRole?: string | null
): string | null {
  return getMasterAgentPrefix(workspaceId) || getGatewayAgentPrefix(nameOrRole);
}
