import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/frontend-authority?workspace=<id>
 * Read the Open Design binding + sync state for an Autensa workspace.
 * If no binding exists, returns sync_state NO_DESIGN (200, not error).
 */
export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get('workspace');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspace query param required' }, { status: 400 });
  }
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT * FROM frontend_design_authority WHERE autensa_workspace_id = ?'
    ).get(workspaceId);
    if (!row) {
      return NextResponse.json({
        autensa_workspace_id: workspaceId,
        provider: null,
        open_design_project_id: null,
        sync_state: 'NO_DESIGN',
        current_design_version: null,
        implemented_design_version: null,
        git_commit: null,
        development_deployment: null,
        latest_design_work_item: null,
        latest_implementation_work_item: null,
      });
    }
    return NextResponse.json(row);
  } catch (error) {
    console.error('Failed to fetch frontend authority:', error);
    return NextResponse.json({ error: 'Failed to fetch frontend authority' }, { status: 500 });
  }
}

/**
 * POST /api/frontend-authority
 * Bind or update the Open Design authority for an Autensa workspace.
 * Body:
 * {
 *   autensa_workspace_id: string,   // REQUIRED
 *   open_design_project_id: string, // REQUIRED (must match ^[A-Za-z0-9._-]{1,128}$)
 *   current_design_version?: string,
 *   implemented_design_version?: string,
 *   git_commit?: string,
 *   development_deployment?: string,
 *   sync_state?: DesignSyncState,
 *   latest_design_work_item?: string,
 *   latest_implementation_work_item?: string
 * }
 * Fail-closed: rejects ambiguous/missing identity. 1:1 enforced by UNIQUE.
 */
const SYNC_STATES = ['NO_DESIGN','DRAFT','DESIGN_READY','IMPLEMENTATION_PENDING','IMPLEMENTING','TESTING','REVIEWING','SYNCED','DESIGN_DRIFT','BLOCKED'];
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const autensaWorkspace = typeof body.autensa_workspace_id === 'string' ? body.autensa_workspace_id.trim() : '';
  const odProject = typeof body.open_design_project_id === 'string' ? body.open_design_project_id.trim() : '';

  // Fail-closed: both identities must be present and valid.
  if (!autensaWorkspace) {
    return NextResponse.json({ error: 'autensa_workspace_id required' }, { status: 400 });
  }
  if (!odProject || !PROJECT_ID_RE.test(odProject)) {
    return NextResponse.json({ error: 'open_design_project_id required, format ^[A-Za-z0-9._-]{1,128}$' }, { status: 400 });
  }
  if (body.sync_state !== undefined && !SYNC_STATES.includes(String(body.sync_state))) {
    return NextResponse.json({ error: `sync_state must be one of: ${SYNC_STATES.join(', ')}` }, { status: 400 });
  }

  try {
    const db = getDb();
    const existing = db.prepare(
      'SELECT id FROM frontend_design_authority WHERE autensa_workspace_id = ?'
    ).get(autensaWorkspace);

    const fields: Record<string, unknown> = {
      open_design_project_id: odProject,
      current_design_version: body.current_design_version ?? null,
      implemented_design_version: body.implemented_design_version ?? null,
      git_commit: body.git_commit ?? null,
      development_deployment: body.development_deployment ?? null,
      sync_state: body.sync_state ?? 'DRAFT',
      latest_design_work_item: body.latest_design_work_item ?? null,
      latest_implementation_work_item: body.latest_implementation_work_item ?? null,
    };

    if (existing) {
      const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE frontend_design_authority SET ${sets}, updated_at = datetime('now') WHERE autensa_workspace_id = ?`)
        .run(...Object.values(fields), autensaWorkspace);
    } else {
      const id = `fda-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT INTO frontend_design_authority (id, autensa_workspace_id, open_design_project_id, provider, mode,
          current_design_version, implemented_design_version, git_commit, development_deployment,
          sync_state, latest_design_work_item, latest_implementation_work_item)
        VALUES (?, ?, ?, 'open-design', 'authoritative', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, autensaWorkspace, odProject,
        fields.current_design_version, fields.implemented_design_version, fields.git_commit,
        fields.development_deployment, fields.sync_state, fields.latest_design_work_item,
        fields.latest_implementation_work_item);
    }

    const row = db.prepare(
      'SELECT * FROM frontend_design_authority WHERE autensa_workspace_id = ?'
    ).get(autensaWorkspace);
    return NextResponse.json(row);
  } catch (error) {
    console.error('Failed to bind frontend authority:', error);
    // SQLITE_CONSTRAINT_UNIQUE → conflicting binding → ambiguous → fail closed
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('UNIQUE')) {
      return NextResponse.json({ error: 'binding conflict: workspace or open-design project already bound' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to bind frontend authority' }, { status: 500 });
  }
}
