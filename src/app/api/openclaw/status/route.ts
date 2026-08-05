import { NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { enrichGatewaySessions } from '@/lib/session-metrics';

export const dynamic = 'force-dynamic';

// GET /api/openclaw/status - Check OpenClaw connection status
// PLATFORM-008 (D1): sessions payload carries honest per-session metrics
// (ctxPct from live context, cumulativeRunPct/totalTokens as separate fields).
export async function GET() {
  try {
    const client = getOpenClawClient();

    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (err) {
        return NextResponse.json({
          connected: false,
          error: 'Failed to connect to OpenClaw Gateway',
          gateway_url: process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789',
        });
      }
    }

    // Try to list sessions to verify connection
    try {
      const sessions = await client.listSessions();
      const enriched = await enrichGatewaySessions(sessions as Parameters<typeof enrichGatewaySessions>[0]);
      return NextResponse.json({
        connected: true,
        sessions_count: sessions.length,
        sessions: enriched,
        gateway_url: process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789',
      });
    } catch (err) {
      return NextResponse.json({
        connected: true,
        error: 'Connected but failed to list sessions',
        gateway_url: process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789',
      });
    }
  } catch (error) {
    console.error('OpenClaw status check failed:', error);
    return NextResponse.json(
      {
        connected: false,
        error: 'Internal server error',
      },
      { status: 500 }
    );
  }
}
