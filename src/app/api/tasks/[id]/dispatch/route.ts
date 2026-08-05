import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getProjectsPath, getMissionControlUrl } from '@/lib/config';
import { syncGatewayAgentsToCatalog } from '@/lib/agent-catalog-sync';
import { getGatewayAgentPrefix, getSessionKeyPrefix } from '@/lib/agent-prefix';
import { pickDynamicAgent } from '@/lib/task-governance';
import { createTaskWorkspace, determineIsolationStrategy } from '@/lib/workspace-isolation';
import { getAgentRuntimeSettings } from '@/lib/runtime-settings';
import { getCodexCliStatus } from '@/lib/codex/status';
import { cancelCodexRunsForTask, startCodexTaskRun } from '@/lib/codex/dispatch';
import { buildTaskDispatchContext } from '@/lib/task-dispatch-context';
import {
  buildModelWindowMap,
  estimateLiveContextFromHistory,
  getPreviousRunTotalTokens,
  recordSessionTokens,
  resolveDispatchSession,
  resolveSessionHealthConfig,
  detectSessionCorruptionMarkers,
  estimateFileSizeFromHistory,
  recordSessionFileSize,
  type GatewaySessionInfo,
} from '@/lib/session-health';
import { formatMCPToolsForDispatch } from '@/lib/mcp/proxy';
import { getCachedCodebaseContext, type ExplorationDepth } from '@/lib/codebase-explorer';
import { recordTokenSample, evaluateTokenRateAlert } from '@/lib/token-rate-alert';
import type { Task, Agent, Product, OpenClawSession, WorkflowStage, TaskImage } from '@/lib/types';

export const dynamic = 'force-dynamic';
interface RouteParams {
  params: Promise<{ id: string }>;
}

function recordDispatchError(taskId: string, error: string): void {
  const now = new Date().toISOString();

  run(
    'UPDATE tasks SET planning_dispatch_error = ?, status_reason = ?, updated_at = ? WHERE id = ?',
    [error, `Dispatch failed: ${error}`, now, taskId]
  );

  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }
}

function dispatchErrorResponse(taskId: string, error: string, status: number) {
  recordDispatchError(taskId, error);
  return NextResponse.json({ error }, { status });
}

/**
 * POST /api/tasks/[id]/dispatch
 * 
 * Dispatches a task to its assigned agent through the configured runtime.
 * OpenClaw keeps the existing chat-session flow; Codex starts a tracked CLI run.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Parse optional body (may contain review_fix_message for PR review auto-fix)
    let reviewFixMessage: string | undefined;
    try {
      const body = await request.json();
      reviewFixMessage = body?.review_fix_message;
      // PLATFORM-008 (A5): model tiering is config-only (main=v4-pro / worker=flash).
      // Dispatch must NEVER override the model at runtime — ignore + warn loudly.
      if (body?.model !== undefined || body?.model_override !== undefined) {
        console.warn(`[Dispatch] Ignored runtime model override for task ${id} (tiering is config-only, PLATFORM-008 A5)`);
      }
    } catch {
      // No body or invalid JSON — that's fine for normal dispatches
    }

    // Keep canonical agent catalog synced before every dispatch (best-effort)
    await syncGatewayAgentsToCatalog({ reason: 'dispatch' }).catch(err => {
      console.warn('[Dispatch] agent catalog sync failed:', err);
    });

    // Get task with agent info
    const task = queryOne<Task & { assigned_agent_name?: string; workspace_id: string }>(
      `SELECT t.*, a.name as assigned_agent_name, a.is_master
       FROM tasks t
       LEFT JOIN agents a ON t.assigned_agent_id = a.id
       WHERE t.id = ?`,
      [id]
    );

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    let assignedAgentId = task.assigned_agent_id;
    if (!assignedAgentId) {
      const statusRoleMap: Record<string, string> = {
        assigned: 'builder',
        in_progress: 'builder',
        testing: 'tester',
        review: 'reviewer',
        verification: 'reviewer',
      };
      const dynamicAgent = pickDynamicAgent(id, statusRoleMap[task.status] || 'builder');
      if (dynamicAgent) {
        assignedAgentId = dynamicAgent.id;
        run('UPDATE tasks SET assigned_agent_id = ?, updated_at = datetime(\'now\') WHERE id = ?', [assignedAgentId, id]);
      }
    }

    if (!assignedAgentId) {
      return dispatchErrorResponse(id, 'Task has no routable agent', 400);
    }

    // Get agent details
    const agent = queryOne<Agent>(
      'SELECT * FROM agents WHERE id = ?',
      [assignedAgentId]
    );

    if (!agent) {
      return dispatchErrorResponse(id, 'Assigned agent not found', 404);
    }

    // Check if dispatching to the master agent while there are other orchestrators available
    if (agent.is_master) {
      // Check for other master agents in the same workspace (excluding this one)
      const otherOrchestrators = queryAll<{
        id: string;
        name: string;
        role: string;
      }>(
        `SELECT id, name, role
         FROM agents
         WHERE is_master = 1
         AND id != ?
         AND workspace_id = ?
         AND status != 'offline'`,
        [agent.id, task.workspace_id]
      );

      if (otherOrchestrators.length > 0) {
        const message = `There ${otherOrchestrators.length === 1 ? 'is' : 'are'} ${otherOrchestrators.length} other orchestrator${otherOrchestrators.length === 1 ? '' : 's'} available in this workspace: ${otherOrchestrators.map(o => o.name).join(', ')}. Consider assigning this task to them instead.`;
        recordDispatchError(id, `Other orchestrators available: ${message}`);

        return NextResponse.json({
          success: false,
          warning: 'Other orchestrators available',
          message,
          otherOrchestrators,
        }, { status: 409 }); // 409 Conflict - indicating there's an alternative
      }
    }

    const now = new Date().toISOString();

    // Cost cap warning check
    let costCapWarning: string | undefined;
    if (task.product_id) {
      const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [task.product_id]);
      if (product?.cost_cap_monthly) {
        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);
        const monthlySpend = queryOne<{ total: number }>(
          `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events
           WHERE product_id = ? AND created_at >= ?`,
          [task.product_id, monthStart.toISOString()]
        );
        if (monthlySpend && monthlySpend.total >= product.cost_cap_monthly) {
          costCapWarning = `Monthly cost cap reached: $${monthlySpend.total.toFixed(2)}/$${product.cost_cap_monthly.toFixed(2)}`;
          console.warn(`[Dispatch] ${costCapWarning} for product ${product.name}`);
        }
      }
    }

    // Get project path for deliverables — with workspace isolation if needed
    const projectsPath = getProjectsPath();
    const projectDir = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let taskProjectDir = `${projectsPath}/${projectDir}`;
    const missionControlUrl = getMissionControlUrl();

    // Create isolated workspace if parallel builds are possible
    // Only for builder dispatches (assigned/in_progress), not tester/reviewer
    let workspaceIsolated = false;
    let workspaceBranchName: string | undefined;
    let workspacePort: number | undefined;
    const isolationStrategy = determineIsolationStrategy(task as Task);
    const isBuilderDispatch = task.status === 'assigned' || task.status === 'in_progress' || task.status === 'inbox';
    if (isolationStrategy && isBuilderDispatch) {
      try {
        const workspace = await createTaskWorkspace(task as Task);
        taskProjectDir = workspace.path;
        workspaceIsolated = true;
        workspaceBranchName = workspace.branch;
        workspacePort = workspace.port;
        console.log(`[Dispatch] Created ${workspace.strategy} workspace for task ${task.id}: ${workspace.path}`);
      } catch (err) {
        console.warn(`[Dispatch] Workspace isolation failed, using default path:`, (err as Error).message);
      }
    }

    const dispatchContext = buildTaskDispatchContext({
      task: task as Task,
      agent,
      missionControlUrl,
      taskProjectDir,
      workspaceIsolated,
      workspaceBranchName,
      workspacePort,
    });
    let finalMessage = dispatchContext.message;

    if (task.product_id) {
      try {
        const mcpSection = formatMCPToolsForDispatch(task.product_id);
        if (mcpSection) finalMessage += mcpSection;
      } catch {
        // MCP injection is best-effort — never block dispatch
      }
    }

    if (task.product_id && isBuilderDispatch) {
      try {
        const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [task.product_id]);
        if (product?.repo_url) {
          const depth = (product.exploration_depth as ExplorationDepth) || 'standard';
          const context = getCachedCodebaseContext(
            task.product_id,
            product.repo_url,
            depth,
            task.title,
            task.description || undefined,
          );
          if (context) {
            finalMessage += `\n---\n${context}\n`;
          }
        }
      } catch {
        // Codebase context injection is best-effort — never block dispatch
      }
    }

    if (reviewFixMessage) {
      finalMessage = `${reviewFixMessage}\n\n---\n\n${finalMessage}`;
    }

    const runtimeSettings = getAgentRuntimeSettings();

    if (runtimeSettings.provider === 'codex') {
      const codexStatus = await getCodexCliStatus();

      if (!codexStatus.ready) {
        return dispatchErrorResponse(
          id,
          `Codex runtime is not ready: ${codexStatus.error || 'Codex CLI is not authenticated'}`,
          503
        );
      }

      const cancelledRuns = cancelCodexRunsForTask(task.id, agent.id);
      const codexPrompt = `**CODEX RUNTIME CONTEXT**
You are running inside Codex CLI for Mission Control.
Use this Mission Control API base URL exactly as written: ${missionControlUrl}
Do not replace the hostname with 127.0.0.1 or another loopback spelling.
When the task requires status, activity, deliverable, or PR updates, call the Mission Control API directly.
Every Mission Control API curl command must include:
-H "Authorization: Bearer $MC_API_TOKEN"
Never print, inspect, or echo MC_API_TOKEN.

${finalMessage}`;

      const codexRun = startCodexTaskRun({
        task: task as Task,
        agent,
        prompt: codexPrompt,
        workingDirectory: taskProjectDir,
        env: {
          CODEX_CLOUD_ENV_ID: runtimeSettings.codexCloudEnvironmentId || undefined,
          CODEX_DEFAULT_BRANCH: runtimeSettings.codexDefaultBranch || undefined,
          MISSION_CONTROL_URL: missionControlUrl,
        },
      });

      console.info('[Dispatch] Task started through Codex runtime', JSON.stringify({
        taskId: task.id,
        agentId: agent.id,
        agentName: agent.name,
        sessionId: codexRun.sessionId,
        pid: codexRun.pid,
        cwd: codexRun.cwd,
        cancelledRuns,
        contextVersion: dispatchContext.audit.version,
        contextChars: dispatchContext.audit.totalChars,
        contextSections: dispatchContext.audit.sections.map(section => ({
          key: section.key,
          chars: section.charCount,
          truncated: section.truncated,
        })),
      }));

      if (task.status === 'assigned') {
        run(
          'UPDATE tasks SET status = ?, planning_dispatch_error = NULL, status_reason = NULL, updated_at = ? WHERE id = ?',
          ['in_progress', now, id]
        );
      } else {
        run(
          'UPDATE tasks SET planning_dispatch_error = NULL, status_reason = NULL, updated_at = ? WHERE id = ?',
          [now, id]
        );
      }

      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (updatedTask) {
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['working', now, agent.id]
      );

      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'task_dispatched',
          agent.id,
          task.id,
          `Task "${task.title}" dispatched to ${agent.name} through Codex`,
          JSON.stringify({
            runtime: 'codex',
            codex_session_id: codexRun.sessionId,
            context: dispatchContext.audit,
          }),
          now,
        ]
      );

      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          task.id,
          agent.id,
          'status_changed',
          `Task dispatched to ${agent.name} through Codex - Codex is now working on this task`,
          JSON.stringify({
            runtime: 'codex',
            codex_session_id: codexRun.sessionId,
            pid: codexRun.pid,
            cwd: codexRun.cwd,
            log_path: codexRun.logPath,
            context: dispatchContext.audit,
          }),
          now,
        ]
      );

      return NextResponse.json({
        success: true,
        runtime: 'codex',
        task_id: task.id,
        agent_id: agent.id,
        session_id: codexRun.sessionId,
        codex_session_id: codexRun.sessionId,
        context_version: dispatchContext.audit.version,
        message: 'Task dispatched to Codex',
        ...(costCapWarning ? { cost_cap_warning: costCapWarning } : {}),
      });
    }

    // ---- PLATFORM-007: pre-dispatch env validation ----
    // Guard against dispatching to an agent that will immediately 401 because
    // essential tokens are missing.  Builder stages are most vulnerable because
    // the container .env may be empty or stale.
    if (!process.env.MC_API_TOKEN || process.env.MC_API_TOKEN.trim().length === 0) {
      const err = 'Dispatch blocked: MC_API_TOKEN is missing or empty in server environment. The agent container will not be able to call Mission Control APIs and will fail immediately.';
      console.error(`[Dispatch] ${err}`);
      return dispatchErrorResponse(id, err, 500);
    }
    // ---- end pre-dispatch env validation ----

    // Connect to OpenClaw Gateway only when the configured runtime is OpenClaw.
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch (err) {
        console.error('Failed to connect to OpenClaw Gateway:', err);
        client.forceReconnect();
        return dispatchErrorResponse(id, 'Failed to connect to OpenClaw Gateway', 503);
      }
    }

    // Get or create OpenClaw session for this agent + task combination
    // PLATFORM-008 (A1): health-check + rotation before any reuse. Never reuse
    // a bloated/failed/blocked session — always rotate to a NEW session key.
    const prefix = getSessionKeyPrefix(agent.role, agent.session_key_prefix);
    if (!prefix) {
      return dispatchErrorResponse(
        id,
        `Agent "${agent.name}" has no gateway session prefix — assign a canonical gateway agent (manager/builder/tester/reviewer/learner) and retry`,
        500
      );
    }

    // Latest session row for this (agent, task) regardless of status — a
    // failed/rotated previous row must never silently re-key onto its old
    // gateway transcript (the reusedExistingSession failure mode).
    const latestSession = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1',
      [agent.id, id]
    );

    // Gateway session counters (best-effort) + transcript-tail fallback for
    // the live context estimate.
    let gatewaySessions: GatewaySessionInfo[] = [];
    let contextWindow: number | null = null;
    try {
      gatewaySessions = (await client.listSessions()) as unknown as GatewaySessionInfo[];
      // Resolve the model window from the catalog so a gateway window-fallback
      // in `contextTokens` is never mistaken for live context usage.
      try {
        const models = (await client.listModels()) as unknown as Array<{ id?: string; provider?: string; contextWindow?: number }>;
        const windowMap = buildModelWindowMap(models);
        const existingKeyForWindow = latestSession ? `${prefix}${latestSession.openclaw_session_id}` : null;
        const ownRow = existingKeyForWindow
          ? gatewaySessions.find(g => g.key === existingKeyForWindow || g.sessionId === latestSession?.openclaw_session_id)
          : null;
        const modelRef = ownRow?.modelProvider && ownRow?.model
          ? `${ownRow.modelProvider}/${ownRow.model}`
          : ownRow?.model;
        contextWindow = modelRef ? windowMap[modelRef.toLowerCase()] ?? null : null;
      } catch {
        // best-effort — without the catalog, window stays unknown and only
        // total-token + status checks drive rotation (no false positives)
      }
    } catch (err) {
      console.warn('[Dispatch] sessions.list failed — falling back to DB-only health check:', (err as Error).message);
    }

    const contextEstimates: Record<string, number | null> = {};
    // PLATFORM-010 A4: corruption markers detected from session history.
    const corruptionMarkersBySession: Record<string, ReturnType<typeof import('@/lib/session-health')['detectSessionCorruptionMarkers']>> = {};
    if (latestSession) {
      const existingKey = `${prefix}${latestSession.openclaw_session_id}`;
      try {
        const history = await client.getSessionHistory(existingKey);
        const est = estimateLiveContextFromHistory(history as any[]);
        if (est !== null) contextEstimates[existingKey] = est;
        // A4: scan for memory-flush/sandbox corruption markers.
        const markers = detectSessionCorruptionMarkers(history as any[]);
        if (markers) corruptionMarkersBySession[existingKey] = markers;
        // D3: persist the estimated transcript file size (ukuran file sesi).
        const fileSize = estimateFileSizeFromHistory(history as any[]);
        if (fileSize !== null) recordSessionFileSize(latestSession.id, fileSize);
      } catch {
        // best-effort — chat.history may fail for never-used keys
      }
    }

    const resolution = resolveDispatchSession({
      taskId: id,
      agentId: agent.id,
      agentName: agent.name,
      gatewaySessions,
      contextEstimates,
      corruptionMarkersBySession,
      contextWindow,
      existingSession: latestSession,
      sessionKeyPrefix: prefix,
    });
    const session = resolution.session;
    const reusedExistingSession = resolution.reusedExistingSession;

    if (!session) {
      return dispatchErrorResponse(id, 'Failed to create agent session', 500);
    }

    if (resolution.rotated) {
      const rotatedAt = new Date().toISOString();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          id,
          agent.id,
          'session_rotated',
          `Session rotated to fresh key ${session.openclaw_session_id} (run ${resolution.runNumber}) — previous session unhealthy: ${resolution.rotationReasons.join('; ')}`,
          JSON.stringify({
            run_number: resolution.runNumber,
            reasons: resolution.rotationReasons,
            session_id: session.openclaw_session_id,
          }),
          rotatedAt,
        ]
      );
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'session_rotated',
          agent.id,
          task.id,
          `Session rotated for task "${task.title}": ${resolution.rotationReasons.join('; ')}`,
          JSON.stringify({ session_id: session.openclaw_session_id, run_number: resolution.runNumber }),
          rotatedAt,
        ]
      );
    }

    // D2: record token sample for rate tracking + evaluate alert threshold.
    if (resolution.verdict?.totalTokens != null) {
      recordTokenSample(id, agent.id, resolution.verdict.totalTokens);
      evaluateTokenRateAlert(id, agent.id, agent.name);
    }

    // A2: record honest token counters at dispatch time.
    recordSessionTokens(session.id, {
      totalTokens: resolution.verdict?.totalTokens ?? null,
      contextTokens: resolution.verdict?.contextTokens ?? null,
      runNumber: resolution.runNumber,
    });

    // A2: warn when the previous run already exceeded the cumulative cap.
    const healthConfig = resolveSessionHealthConfig();
    const previousTotal = getPreviousRunTotalTokens(id, agent.id, session.id);
    const previousRunExceeded = previousTotal !== null && previousTotal > healthConfig.maxTotalTokens;
    if (previousRunExceeded) {
      const warnedAt = new Date().toISOString();
      const warningMessage = `Previous run consumed ${previousTotal.toLocaleString('en-US')} cumulative tokens (cap ${healthConfig.maxTotalTokens.toLocaleString('en-US')}). Fresh session started — consider reviewing the previous run for token burn.`;
      console.warn(`[Dispatch] ${warningMessage}`);
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          id,
          agent.id,
          'session_token_warning',
          warningMessage,
          JSON.stringify({ previous_total_tokens: previousTotal, max_total_tokens: healthConfig.maxTotalTokens }),
          warnedAt,
        ]
      );
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'session_token_warning',
          agent.id,
          task.id,
          `Token cap warning for task "${task.title}": previous run ${previousTotal.toLocaleString('en-US')} cumulative tokens`,
          JSON.stringify({ previous_total_tokens: previousTotal, max_total_tokens: healthConfig.maxTotalTokens }),
          warnedAt,
        ]
      );
    }

      console.info('[Dispatch] Agent session resolved for task dispatch', JSON.stringify({
      runtime: 'openclaw',
      taskId: id,
      taskStatus: task.status,
      agentId: agent.id,
      agentName: agent.name,
      reusedExistingSession,
      rotated: resolution.rotated,
      rotationReasons: resolution.rotationReasons,
      runNumber: resolution.runNumber,
      sessionId: session.openclaw_session_id,
      sessionCreatedAt: session.created_at,
      sessionUpdatedAt: session.updated_at,
      totalTokens: resolution.verdict?.totalTokens ?? null,
      ctxPct: resolution.verdict?.ctxPct ?? null,
      contextVersion: dispatchContext.audit.version,
      contextChars: dispatchContext.audit.totalChars,
      contextSections: dispatchContext.audit.sections.map(section => ({
        key: section.key,
        chars: section.charCount,
        truncated: section.truncated,
      })),
    }));

    // Send message to agent's session using chat.send
    try {
      // Use sessionKey for routing to the agent's session
      // PLATFORM-002 + PLATFORM-007: resolve a role-based prefix via
      // getSessionKeyPrefix (agent row prefix → role map → hard default).
      // Fail loudly if nothing usable resolves — never silently dispatch to a
      // legacy 'agent:main:' session that has no gateway agent behind it.
      const sessionKey = `${prefix}${session.openclaw_session_id}`;
      await client.call('chat.send', {
        sessionKey,
        message: finalMessage,
        idempotencyKey: `dispatch-${task.id}-${Date.now()}`
      });

      console.info('[Dispatch] Task message delivered to agent session', JSON.stringify({
        taskId: task.id,
        agentId: agent.id,
        sessionId: session.openclaw_session_id,
        previousTaskStatus: task.status,
        expectedTaskStatus: task.status === 'assigned' ? 'in_progress' : task.status,
      }));

      // Only move to in_progress for builder dispatch (task is in 'assigned' status)
      // For tester/reviewer/verifier, the task status is already correct
      if (task.status === 'assigned') {
        run(
          'UPDATE tasks SET status = ?, planning_dispatch_error = NULL, status_reason = NULL, updated_at = ? WHERE id = ?',
          ['in_progress', now, id]
        );
      } else {
        run(
          'UPDATE tasks SET planning_dispatch_error = NULL, status_reason = NULL, updated_at = ? WHERE id = ?',
          [now, id]
        );
      }

      // Broadcast task update
      const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (updatedTask) {
        console.info('[Dispatch] Task state after dispatch delivery', JSON.stringify({
          taskId: task.id,
          agentId: agent.id,
          sessionId: session.openclaw_session_id,
          taskStatus: updatedTask.status,
          planningDispatchError: updatedTask.planning_dispatch_error || null,
          statusReason: updatedTask.status_reason || null,
        }));
        broadcast({
          type: 'task_updated',
          payload: updatedTask,
        });
      }

      // Update agent status to working
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['working', now, agent.id]
      );

      // Log dispatch event to events table
      const eventId = uuidv4();
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          eventId,
          'task_dispatched',
          agent.id,
          task.id,
          `Task "${task.title}" dispatched to ${agent.name}`,
          JSON.stringify({
            runtime: 'openclaw',
            openclaw_session_id: session.openclaw_session_id,
            context: dispatchContext.audit,
          }),
          now,
        ]
      );

      // Log dispatch activity to task_activities table (for Activity tab)
      const activityId = crypto.randomUUID();
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          activityId,
          task.id,
          agent.id,
          'status_changed',
          `Task dispatched to ${agent.name} - Agent is now working on this task`,
          JSON.stringify({
            runtime: 'openclaw',
            openclaw_session_id: session.openclaw_session_id,
            context: dispatchContext.audit,
          }),
          now,
        ]
      );

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: session.openclaw_session_id,
        context_version: dispatchContext.audit.version,
        message: 'Task dispatched to agent',
        rotated: resolution.rotated,
        run_number: resolution.runNumber,
        ...(resolution.rotationReasons.length > 0 ? { rotation_reasons: resolution.rotationReasons } : {}),
        ...(resolution.verdict?.totalTokens != null ? { total_tokens: resolution.verdict.totalTokens } : {}),
        ...(resolution.verdict?.ctxPct != null ? { ctx_pct: resolution.verdict.ctxPct } : {}),
        ...(previousRunExceeded ? { session_token_warning: `Previous run exceeded the cumulative token cap (${previousTotal} > ${healthConfig.maxTotalTokens})` } : {}),
        ...(costCapWarning ? { cost_cap_warning: costCapWarning } : {}),
      });
    } catch (err) {
      console.error('Failed to send message to agent:', err);
      // Force-reconnect so the next dispatch attempt gets a fresh WebSocket
      const client2 = getOpenClawClient();
      client2.forceReconnect();
      // Reset task to 'assigned' so dispatch can be retried
      run(
        `UPDATE tasks SET status = 'assigned', planning_dispatch_error = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ? AND status != 'done'`,
        [
          `Dispatch delivery failed: ${(err as Error).message}`,
          `Dispatch failed: ${(err as Error).message}`,
          id,
        ]
      );
      const failedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
      if (failedTask) {
        broadcast({ type: 'task_updated', payload: failedTask });
      }
      return NextResponse.json(
        { error: `Failed to deliver task to agent: ${(err as Error).message}` },
        { status: 503 }
      );
    }
  } catch (error) {
    console.error('Failed to dispatch task:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
