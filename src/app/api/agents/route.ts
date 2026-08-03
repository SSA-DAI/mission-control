import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { evaluateAgentHealth, type AgentHealthEvaluation } from '@/lib/agent-health';
import { mapHealthToDbStatus } from '@/lib/agent-health-status';
import type { Agent, AgentActiveTask, CreateAgentRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

function enrichAgentWithHealth(agent: Agent, evaluation: AgentHealthEvaluation): Agent {
  const activeTask: AgentActiveTask | undefined = evaluation.task_id
    ? {
        id: evaluation.task_id,
        title: evaluation.display_label, // best-effort title — may be display_label
        status: evaluation.signals.task_status ?? 'unknown',
        priority: 'normal', // not queried in health eval; consumer should look up full task if needed
      }
    : undefined;

  // Enrich active_task with real title/priority if available
  if (evaluation.task_id) {
    const task = queryOne<{ title: string; status: string; priority: string }>(
      'SELECT title, status, priority FROM tasks WHERE id = ?',
      [evaluation.task_id]
    );
    if (task) {
      activeTask!.title = task.title;
      activeTask!.status = task.status;
      activeTask!.priority = task.priority;
    }
  }

  return {
    ...agent,
    status: mapHealthToDbStatus(evaluation.health_state),
    display_state: evaluation.display_state,
    reason: evaluation.reason,
    latest_activity_message: evaluation.signals.latest_activity_message,
    active_task: activeTask,
    last_activity_at: evaluation.last_activity_at,
  };
}

// GET /api/agents - List all agents
export async function GET(request: NextRequest) {
  try {
    const workspaceId = request.nextUrl.searchParams.get('workspace_id');
    
    let agents: Agent[];
    if (workspaceId) {
      agents = queryAll<Agent>(`
        SELECT * FROM agents WHERE workspace_id = ? ORDER BY is_master DESC, name ASC
      `, [workspaceId]);
      // Multi-project: also include canonical agents actively assigned to this
      // workspace's tasks. They live in the operational/default workspace but
      // work cross-workspace, so without this the UI would only show local
      // seed agents and report "0 active" while a canonical agent is working.
      const workingOnWs = queryAll<Agent>(`
        SELECT DISTINCT a.* FROM agents a
        JOIN tasks t ON t.assigned_agent_id = a.id
        WHERE t.workspace_id = ? AND t.status IN ('assigned','in_progress','testing','verification')
      `, [workspaceId]);
      const known = new Set(agents.map((a) => a.id));
      for (const a of workingOnWs) {
        if (!known.has(a.id)) {
          agents.push(a);
          known.add(a.id);
        }
      }
    } else {
      agents = queryAll<Agent>(`
        SELECT * FROM agents ORDER BY is_master DESC, name ASC
      `);
    }

    // Enrich every agent with real health state from evaluateAgentHealth().
    // This replaces the old activeMap-based reconciliation that only checked
    // task assignment and produced cosmetic WORKING/STANDBY labels.
    const enrichedAgents = agents.map((agent) => {
      try {
        const evaluation = evaluateAgentHealth(agent.id);
        return enrichAgentWithHealth(agent, evaluation);
      } catch (err) {
        console.error(`[agents] Health evaluation failed for ${agent.id} (${agent.name}):`, err);
        // Fallback: keep original status, mark as offline if unknown
        return {
          ...agent,
          status: agent.status === 'offline' ? 'offline' : 'standby',
          display_state: 'offline' as const,
          reason: 'Health evaluation failed; status may be stale.',
        };
      }
    });

    return NextResponse.json(enrichedAgents);
  } catch (error) {
    console.error('Failed to fetch agents:', error);
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
}

// POST /api/agents - Create a new agent
export async function POST(request: NextRequest) {
  try {
    const body: CreateAgentRequest = await request.json();

    if (!body.name || !body.role) {
      return NextResponse.json({ error: 'Name and role are required' }, { status: 400 });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    run(
      `INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, soul_md, user_md, agents_md, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.name,
        body.role,
        body.description || null,
        body.avatar_emoji || '🤖',
        body.is_master ? 1 : 0,
        (body as { workspace_id?: string }).workspace_id || 'default',
        body.soul_md || null,
        body.user_md || null,
        body.agents_md || null,
        body.model || null,
        now,
        now,
      ]
    );

    // Log event
    run(
      `INSERT INTO events (id, type, agent_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'agent_joined', id, `${body.name} joined the team`, now]
    );

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    return NextResponse.json(agent, { status: 201 });
  } catch (error) {
    console.error('Failed to create agent:', error);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}
