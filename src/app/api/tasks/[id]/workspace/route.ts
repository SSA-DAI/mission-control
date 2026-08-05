import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import {
  createTaskWorkspace,
  getWorkspaceStatus,
  isPipelineGreen,
  mergeWorkspace,
  prepareTaskWorkspace,
  cleanupWorkspace,
  triggerWorkspaceMerge,
} from '@/lib/workspace-isolation';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id]/workspace — Get workspace status
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    const status = getWorkspaceStatus(task);
    return NextResponse.json(status);
  } catch (error) {
    console.error('Failed to get workspace status:', error);
    return NextResponse.json({ error: 'Failed to get workspace status' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/workspace — Create workspace or trigger action
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const action = (body as { action?: string }).action || 'create';

    switch (action) {
      case 'create': {
        if (task.workspace_path) {
          return NextResponse.json({ error: 'Workspace already exists', path: task.workspace_path }, { status: 409 });
        }
        const workspace = await createTaskWorkspace(task);
        return NextResponse.json({
          success: true,
          workspacePath: workspace.path,
          strategy: workspace.strategy,
          branch: workspace.branch,
          port: workspace.port,
          baseCommit: workspace.baseCommit,
        }, { status: 201 });
      }

      case 'prepare': {
        // PLATFORM-004c pipeline step 1: idempotent pre-dispatch workspace setup.
        // If workspace_path is already set and the dir exists, returns it as-is.
        // Otherwise clones the repo + creates a branch (or points at the shared
        // project dir for tasks without a repo) and persists workspace_path.
        const workspace = await prepareTaskWorkspace(task);
        return NextResponse.json({
          success: true,
          alreadyPrepared: workspace.alreadyPrepared === true,
          workspacePath: workspace.path,
          strategy: workspace.strategy,
          branch: workspace.branch,
          port: workspace.port,
          baseCommit: workspace.baseCommit,
        }, { status: workspace.alreadyPrepared ? 200 : 201 });
      }

      case 'merge': {
        if (!task.workspace_path) {
          return NextResponse.json({ error: 'No workspace to merge' }, { status: 400 });
        }
        // PLATFORM-004c verification gate: only merge when pipeline is green.
        // Task must be 'done' (all stages passed) or 'verification', or the force
        // flag must be set for manual override.
        const force = (body as { force?: boolean }).force || false;
        const pipelineGreen = isPipelineGreen(task);
        if (!pipelineGreen && !force) {
          return NextResponse.json({
            error: `Pipeline not green: task status is '${task.status}' — must be 'done' or 'verification' to merge. Use force=true to override.`,
            currentStatus: task.status,
          }, { status: 409 });
        }
        const createPR = (body as { createPR?: boolean }).createPR !== false;
        const result = await mergeWorkspace(task, { force, createPR });
        return NextResponse.json(result);
      }

      case 'cleanup': {
        if (!task.workspace_path) {
          return NextResponse.json({ error: 'No workspace to clean up' }, { status: 400 });
        }
        const cleaned = cleanupWorkspace(task);
        return NextResponse.json({ success: cleaned });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error('Workspace operation failed:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
