/**
 * PLATFORM-015: task status → stage role mapping used by dispatch.
 *
 * Extracted from the dispatch route so the mapping is unit-testable and shared.
 *
 * The verification stage is owned by the VERIFIER role — historically this was
 * verification→reviewer (a PLATFORM-012-class role confusion: a verify-stage
 * task without an assigned agent could route to the reviewer canonical agent).
 */
export const STATUS_ROLE_MAP: Record<string, string> = {
  assigned: 'builder',
  in_progress: 'builder',
  testing: 'tester',
  review: 'reviewer',
  verification: 'verifier',
};

/**
 * Resolve the stage role for a task status. Unknown/queue statuses fall back to
 * 'builder' (legacy single-agent behaviour preserved).
 */
export function stageRoleForStatus(status: string): string {
  return STATUS_ROLE_MAP[status] || 'builder';
}
