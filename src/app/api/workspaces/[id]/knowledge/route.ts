import { NextRequest, NextResponse } from 'next/server';
import { queryAll, run } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/workspaces/[id]/knowledge
 * Query knowledge entries for a workspace
 * Supports query params: category, tags, limit
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category');
  const taskId = searchParams.get('task_id'); // PLATFORM-004b: filter by task
  const limit = parseInt(searchParams.get('limit') || '50', 10);

  try {
    let sql = 'SELECT * FROM knowledge_entries WHERE workspace_id = ?';
    const sqlParams: unknown[] = [workspaceId];

    if (category) {
      sql += ' AND category = ?';
      sqlParams.push(category);
    }
    if (taskId) {
      sql += ' AND task_id = ?';
      sqlParams.push(taskId);
    }

    sql += ' ORDER BY confidence DESC, created_at DESC LIMIT ?';
    sqlParams.push(limit);

    const entries = queryAll<{
      id: string; workspace_id: string; task_id: string; category: string;
      title: string; content: string; tags: string; confidence: number;
      created_by_agent_id: string; created_at: string;
    }>(sql, sqlParams);

    const parsed = entries.map(e => ({
      ...e,
      tags: e.tags ? JSON.parse(e.tags) : [],
    }));

    return NextResponse.json(parsed);
  } catch (error) {
    console.error('Failed to fetch knowledge entries:', error);
    return NextResponse.json({ error: 'Failed to fetch entries' }, { status: 500 });
  }
}

/**
 * POST /api/workspaces/[id]/knowledge
 * Create a knowledge entry (used by Learner agent)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  try {
    const body = await request.json();
    const { task_id, category, title, content, tags, confidence, created_by_agent_id } = body;

    if (!category || !title || !content) {
      return NextResponse.json(
        { error: 'category, title, and content are required' },
        { status: 400 }
      );
    }

    const id = crypto.randomUUID();

    run(
      `INSERT INTO knowledge_entries (id, workspace_id, task_id, category, title, content, tags, confidence, created_by_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        id, workspaceId, task_id || null, category, title, content,
        tags ? JSON.stringify(tags) : null,
        confidence ?? 0.5,
        created_by_agent_id || null
      ]
    );

    // PLATFORM-004b: learner activity visibility. When a knowledge entry is
    // written for a task, surface it in the task's activity log (task card +
    // ActivityLog feed) and the global live feed so learner work is visible.
    if (task_id) {
      const now = new Date().toISOString();
      const activityId = crypto.randomUUID();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, 'knowledge', ?, ?)`,
        [activityId, task_id, created_by_agent_id || null, `📚 Knowledge: ${title} (${category}, confidence ${confidence ?? 0.5})`, now]
      );
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
         VALUES (?, 'knowledge_created', ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), created_by_agent_id || null, task_id, `📚 Knowledge saved: ${title}`, JSON.stringify({ knowledge_entry_id: id, category, confidence: confidence ?? 0.5 }), now]
      );
    }

    return NextResponse.json({ id, message: 'Knowledge entry created' }, { status: 201 });
  } catch (error) {
    console.error('Failed to create knowledge entry:', error);
    return NextResponse.json({ error: 'Failed to create entry' }, { status: 500 });
  }
}
