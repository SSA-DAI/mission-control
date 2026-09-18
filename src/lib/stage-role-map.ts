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

/**
 * GLOBAL ODE STALL REMEDIATION (2026-09-18): reverse of STATUS_ROLE_MAP.
 *
 * Used to put a task parked at menunggu_keputusan_manusia back into the stage
 * status owned by its assigned agent's role. Without this a manual
 * dispatch/retry on a parked task dispatched a fresh agent session while the
 * task STAYED parked: the stage watchdog only sweeps stage statuses, so the
 * session ran, ended without a callback, and the task sat parked again — work
 * silently wasted (observed on ODE-P04-T10, 2026-09-18 00:14 UTC).
 */
export const ROLE_STATUS_MAP: Record<string, string> = {
  builder: 'in_progress',
  tester: 'testing',
  reviewer: 'review',
  verifier: 'verification',
};

/** Stage status owned by a canonical role, or null when unmapped. */
export function stageStatusForRole(role: string | null | undefined): string | null {
  if (!role) return null;
  return ROLE_STATUS_MAP[String(role).trim().toLowerCase()] ?? null;
}
