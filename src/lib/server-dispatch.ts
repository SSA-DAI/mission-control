import { getMissionControlUrl } from '@/lib/config';

export interface ServerDispatchResult {
  success: boolean;
  error?: string;
  status?: number;
  /** Parsed JSON body from the dispatch endpoint (rotation/token diagnostics). */
  body?: Record<string, unknown> | null;
}

/**
 * Server-side dispatch helper.
 *
 * Client code can use relative fetch URLs, but route handlers cannot. Keeping
 * server dispatch here prevents accidental imports of browser-only helpers from
 * API routes.
 */
export async function dispatchTaskFromServer(taskId: string): Promise<ServerDispatchResult> {
  const missionControlUrl = getMissionControlUrl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (process.env.MC_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.MC_API_TOKEN}`;
  }

  try {
    const response = await fetch(`${missionControlUrl}/api/tasks/${taskId}/dispatch`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    const body = await response.json().catch(() => null);

    if (response.ok) {
      return { success: true, status: response.status, body };
    }

    const errorText = body?.error ? String(body.error) : JSON.stringify(body);
    return {
      success: false,
      status: response.status,
      error: `Dispatch failed (${response.status}): ${errorText}`,
      body,
    };
  } catch (error) {
    return {
      success: false,
      error: `Dispatch error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
