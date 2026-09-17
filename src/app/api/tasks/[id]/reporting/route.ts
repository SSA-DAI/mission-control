/**
 * Task Reporting Metadata Bridge
 * POST /api/tasks/[id]/reporting
 *
 * BOX-PATH-NORMALIZATION-FIX (2026-09-17) §12: after a successful, verified Box
 * upload, the reporting helper (bin/box-report.sh register) pushes the ACTUAL
 * Box reference into task metadata so the done-gate can check it
 * deterministically — instead of relying on prose inside WORK_RESULT.md.
 *
 * Payload (all fields optional except box_report_path):
 *   {
 *     "box_report_path": "box:408894294463/<rel>/WORK_RESULT.md",   // canonical
 *     "box_report_file_id": "2472...",                              // actual Box file id
 *     "box_report_folder_id": "4189...",                            // actual Box folder id
 *     "box_evidence_folder_id": "4189...",                          // optional
 *     "reporting_status": "PRESENT",                                // PRESENT|REPORTING_COMPLETE
 *     "git_commit_sha": "abc123..."                                 // optional exact SHA
 *   }
 *
 * The path is validated with the SAME canonical validator used by the done
 * gate (isValidBoxReportPath) — placeholders (N/A, PENDING_UPLOAD) and
 * malformed paths are rejected with 400.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { isValidBoxReportPath } from '@/lib/task-governance';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

const FINAL_STATES = ['PRESENT', 'REPORTING_COMPLETE'];

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const task = queryOne<{ id: string; metadata?: string | null; title: string }>(
      'SELECT id, metadata, title FROM tasks WHERE id = ?',
      [id]
    );
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const boxPath = typeof body.box_report_path === 'string' ? body.box_report_path.trim() : '';
    if (!boxPath) {
      return NextResponse.json({ error: 'box_report_path is required' }, { status: 400 });
    }
    if (!isValidBoxReportPath(boxPath)) {
      return NextResponse.json(
        {
          error:
            'Invalid box_report_path — must be canonical (box:<folder-id>/<relative-path>/WORK_RESULT.md or box:file:<file-id>); placeholders (N/A, PENDING_UPLOAD) and duplicate dai-core prefixes are rejected',
        },
        { status: 400 }
      );
    }

    const rawStatus = typeof body.reporting_status === 'string' ? body.reporting_status.trim().toUpperCase() : 'PRESENT';
    if (!FINAL_STATES.includes(rawStatus)) {
      return NextResponse.json(
        { error: `reporting_status must be PRESENT or REPORTING_COMPLETE (got '${rawStatus}') — non-final states are rejected so the done gate can never be satisfied by a pending report` },
        { status: 400 }
      );
    }

    let meta: Record<string, unknown> = {};
    if (task.metadata) {
      try {
        meta = JSON.parse(task.metadata) as Record<string, unknown>;
      } catch {
        meta = {};
      }
    }
    meta.box_report_path = boxPath;
    meta.reporting_status = rawStatus;
    if (typeof body.box_report_file_id === 'string' && body.box_report_file_id.trim()) {
      meta.box_report_file_id = body.box_report_file_id.trim();
    }
    if (typeof body.box_report_folder_id === 'string' && body.box_report_folder_id.trim()) {
      meta.box_report_folder_id = body.box_report_folder_id.trim();
    }
    if (typeof body.box_evidence_folder_id === 'string' && body.box_evidence_folder_id.trim()) {
      meta.box_evidence_folder_id = body.box_evidence_folder_id.trim();
    }
    if (typeof body.git_commit_sha === 'string' && body.git_commit_sha.trim()) {
      meta.git_commit_sha = body.git_commit_sha.trim();
    }

    const now = new Date().toISOString();
    run('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ?', [JSON.stringify(meta), now, id]);

    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
       VALUES (lower(hex(randomblob(16))), ?, 'updated', ?, ?)`,
      [id, `Box reporting metadata registered: ${boxPath} (reporting_status=${rawStatus})`, now]
    );

    broadcast({
      type: 'task_updated',
      payload: { id, metadata: JSON.stringify(meta), box_report_path: boxPath, reporting_status: rawStatus },
    });

    return NextResponse.json({ ok: true, task_id: id, box_report_path: boxPath, reporting_status: rawStatus });
  } catch (error) {
    console.error('Error registering reporting metadata:', error);
    return NextResponse.json({ error: 'Failed to register reporting metadata' }, { status: 500 });
  }
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const task = queryOne<{ id: string; metadata?: string | null }>('SELECT id, metadata FROM tasks WHERE id = ?', [id]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    let meta: Record<string, unknown> = {};
    if (task.metadata) {
      try {
        meta = JSON.parse(task.metadata) as Record<string, unknown>;
      } catch {
        meta = {};
      }
    }
    return NextResponse.json({
      task_id: id,
      box_report_path: meta.box_report_path ?? null,
      box_report_file_id: meta.box_report_file_id ?? null,
      box_report_folder_id: meta.box_report_folder_id ?? null,
      box_evidence_folder_id: meta.box_evidence_folder_id ?? null,
      reporting_status: meta.reporting_status ?? null,
      git_commit_sha: meta.git_commit_sha ?? null,
    });
  } catch (error) {
    console.error('Error reading reporting metadata:', error);
    return NextResponse.json({ error: 'Failed to read reporting metadata' }, { status: 500 });
  }
}
