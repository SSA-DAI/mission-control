/**
 * Map the 6-state health_state from evaluateAgentHealth() into the 3-state
 * agents.status column that has a CHECK constraint (standby/working/offline).
 *
 * Mapping (per PLATFORM-003 planning, option B):
 *   idle    → standby   (no active task)
 *   working → working   (active session + recent signal)
 *   stalled → working   (session exists, needs attention — still connected)
 *   stuck   → working   (session exists, genuinely stuck — still connected)
 *   zombie  → offline   (task assigned but no runtime session = unreachable)
 *   offline → offline   (explicitly disabled)
 *
 * Lives in a lib module (not the route) so both the API route and unit tests
 * can import it — Next.js Route files may only export valid Route fields.
 */
export function mapHealthToDbStatus(healthState: string): 'standby' | 'working' | 'offline' {
  switch (healthState) {
    case 'idle':
      return 'standby';
    case 'working':
    case 'stalled':
    case 'stuck':
      return 'working';
    case 'zombie':
    case 'offline':
    default:
      return 'offline';
  }
}
