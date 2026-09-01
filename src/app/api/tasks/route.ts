import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { CreateTaskSchema } from '@/lib/validation';
import { populateTaskRolesFromAgents } from '@/lib/workflow-engine';
import { dispatchTaskFromServer } from '@/lib/server-dispatch';
import { classifyEnvironmentIssueFromTexts } from '@/lib/environment-issues';
import { syncTaskToJira } from '@/lib/jira/sync';
import { attachRoleChains } from '@/lib/task-role-chain';
import type { Task, CreateTaskRequest, Agent } from '@/lib/types';

// GET /api/tasks - List all tasks with optional filters

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const businessId = searchParams.get('business_id');
    const workspaceId = searchParams.get('workspace_id');
    const assignedAgentId = searchParams.get('assigned_agent_id');

    let sql = `
      SELECT
        t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name,
        (
          SELECT ta.message || ' ' || COALESCE(ta.metadata, '')
          FROM task_activities ta
          WHERE ta.task_id = t.id
            AND ta.activity_type IN ('environment_blocked', 'status_changed')
          ORDER BY ta.created_at DESC
          LIMIT 1
        ) as latest_activity_context,
        js.jira_issue_key,
        js.jira_issue_url
      FROM tasks t
      LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
      LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
      LEFT JOIN jira_sync js ON js.task_id = t.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (status) {
      // Support comma-separated status values (e.g., status=inbox,testing,in_progress)
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        sql += ' AND t.status = ?';
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        sql += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }
    }
    if (businessId) {
      sql += ' AND t.business_id = ?';
      params.push(businessId);
    }
    if (workspaceId) {
      sql += ' AND t.workspace_id = ?';
      params.push(workspaceId);
    }
    if (assignedAgentId) {
      sql += ' AND t.assigned_agent_id = ?';
      params.push(assignedAgentId);
    }

    sql += ' ORDER BY t.created_at DESC';

    const tasks = queryAll<Task & { assigned_agent_name?: string; assigned_agent_emoji?: string; created_by_agent_name?: string; latest_activity_context?: string | null }>(sql, params);

    // PLATFORM-004b: attach handshake role chain + learner knowledge count
    attachRoleChains({ tasks });

    // Transform to include nested agent info
    const transformedTasks = tasks.map((task) => {
      const environmentIssue = classifyEnvironmentIssueFromTexts([
        task.status_reason,
        task.planning_dispatch_error,
        task.latest_activity_context,
      ]);
      const { latest_activity_context: _latestActivityContext, ...taskFields } = task;

      return {
        ...taskFields,
        status_reason: task.status_reason || (environmentIssue ? `Environment action required: ${environmentIssue.userMessage}` : task.status_reason),
        planning_dispatch_error: task.planning_dispatch_error || (environmentIssue ? `Environment blocked (${environmentIssue.code})` : task.planning_dispatch_error),
        assigned_agent: task.assigned_agent_id
          ? {
              id: task.assigned_agent_id,
              name: task.assigned_agent_name,
              avatar_emoji: task.assigned_agent_emoji,
            }
          : undefined,
      };
    });

    return NextResponse.json(transformedTasks);
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

// POST /api/tasks - Create a new task
export async function POST(request: NextRequest) {
  try {
    const body: CreateTaskRequest = await request.json();
    console.log('[POST /api/tasks] Received body:', JSON.stringify(body));

    // Validate input with Zod
    const validation = CreateTaskSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const validatedData = validation.data;

    const id = uuidv4();
    const now = new Date().toISOString();

    const workspaceId = validatedData.workspace_id || 'default';
    const status = validatedData.status || 'inbox';

    // Auto-assign the workspace's default workflow template
    const defaultTemplate = queryOne<{ id: string }>(
      'SELECT id FROM workflow_templates WHERE workspace_id = ? AND is_default = 1 LIMIT 1',
      [workspaceId]
    );
    const workflowTemplateId = defaultTemplate?.id || null;

    // AWANFLEET Open Design: persist work item class + od project binding in metadata JSON
    let metadataObj: Record<string, unknown> = {};
    if (validatedData.frontend_work_item_type) {
      metadataObj.frontend_work_item_type = validatedData.frontend_work_item_type;
    }
    if (validatedData.open_design_project_id) {
      metadataObj.open_design_project_id = validatedData.open_design_project_id;
    }
    const metadataJson = Object.keys(metadataObj).length > 0 ? JSON.stringify(metadataObj) : null;

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, workflow_template_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        validatedData.title,
        validatedData.description || null,
        status,
        validatedData.priority || 'normal',
        validatedData.assigned_agent_id || null,
        validatedData.created_by_agent_id || null,
        workspaceId,
        validatedData.business_id || 'default',
        validatedData.due_date || null,
        workflowTemplateId,
        metadataJson,
        now,
        now,
      ]
    );

    // Log event
    let eventMessage = `New task: ${validatedData.title}`;
    if (validatedData.created_by_agent_id) {
      const creator = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [validatedData.created_by_agent_id]);
      if (creator) {
        eventMessage = `${creator.name} created task: ${validatedData.title}`;
      }
    }

    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), 'task_created', body.created_by_agent_id || null, id, eventMessage, now]
    );

    // Auto-populate workflow roles from workspace agents
    populateTaskRolesFromAgents(id, workspaceId);

    if (status === 'assigned' && validatedData.assigned_agent_id) {
      const dispatchResult = await dispatchTaskFromServer(id);
      if (!dispatchResult.success) {
        run(
          'UPDATE tasks SET planning_dispatch_error = ?, status_reason = ?, updated_at = ? WHERE id = ?',
          [
            dispatchResult.error || 'Dispatch failed',
            `Dispatch failed: ${dispatchResult.error || 'Dispatch failed'}`,
            new Date().toISOString(),
            id,
          ]
        );
      }
    } else if (status === 'assigned') {
      run(
        'UPDATE tasks SET planning_dispatch_error = ?, status_reason = ?, updated_at = ? WHERE id = ?',
        ['No agent assigned', 'Dispatch failed: No agent assigned', new Date().toISOString(), id]
      );
    }

    // Fetch created task with all joined fields after any dispatch side effects
    const task = queryOne<Task & { assigned_agent_name?: string; assigned_agent_emoji?: string; created_by_agent_name?: string; created_by_agent_emoji?: string }>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name,
        ca.avatar_emoji as created_by_agent_emoji
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
       WHERE t.id = ?`,
      [id]
    );

    const transformedTask = task
      ? {
          ...task,
          assigned_agent: task.assigned_agent_id
            ? {
                id: task.assigned_agent_id,
                name: task.assigned_agent_name,
                avatar_emoji: task.assigned_agent_emoji,
              }
            : undefined,
        }
      : task;

    // Broadcast task creation via SSE
    if (transformedTask) {
      broadcast({
        type: 'task_created',
        payload: transformedTask,
      });
    }

    // Fire-and-forget Jira sync (same pattern as auto-dispatch)
    syncTaskToJira(id).catch(err => {
      console.error('[Jira Sync] Failed to sync new task:', err);
    });

    return NextResponse.json(transformedTask, { status: 201 });
  } catch (error) {
    console.error('Failed to create task:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
