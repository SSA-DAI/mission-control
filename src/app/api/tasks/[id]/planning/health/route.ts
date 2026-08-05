import { NextRequest, NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { buildTaskSessionHealth } from '@/lib/task-session-health';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/[id]/planning/health
 *
 * PLATFORM-010 (D3): session health for the SessionHealthCard — sessionId,
 * run number, health state (healthy 🟢 / degraded 🟡 / unhealthy 🔴), umur,
 * totalTokens, session file size, rotation history + recent alerts.
 *
 * Gateway access is best-effort enrichment only: when the gateway is down the
 * response still returns DB-truthful data with `gatewayReachable: false`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const client = getOpenClawClient();

    const snapshot = await buildTaskSessionHealth(taskId, {
      listGatewaySessions: async () => {
        if (!client.isConnected()) {
          await client.connect();
        }
        return (await client.listSessions()) as any[];
      },
      getHistory: async (sessionKey: string) => {
        if (!client.isConnected()) {
          await client.connect();
        }
        return client.getSessionHistory(sessionKey);
      },
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    console.error('Failed to build task session health:', error);
    return NextResponse.json(
      { error: 'Failed to build task session health' },
      { status: 500 }
    );
  }
}
