import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { getProjectsPath, getMissionControlUrl } from '@/lib/config';
import { syncGatewayAgentsToCatalog } from '@/lib/agent-catalog-sync';
import { getGatewayAgentPrefix, getSessionKeyPrefix } from '@/lib/agent-prefix';
import { ensureCanonicalAgent, mapRoleToCanonical } from '@/lib/canonical-agents';
import { stageRoleForStatus } from '@/lib/stage-role-map';
import { pickDynamicAgent } from '@/lib/task-governance';
import { prepareTaskWorkspace } from '@/lib/workspace-isolation';
import { createTaskWorktree, worktreesEnabled } from '@/lib/worktree-manager';
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
  isBusySessionError,
  rotateToFreshSession,
  isSessionBusy,
  resolveLocalSessionsPath,
  rotationReasonLabel,
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
      // PLATFORM-015: statusRoleMap corrected — the verification stage is owned
      // by the VERIFIER role, not reviewer (was verification→reviewer, which
      // could route a verify-stage task without an assigned agent to the
      // reviewer canonical agent). Shared with tests via @/lib/stage-role-map.
      const role = stageRoleForStatus(task.status);

      // PLATFORM-015: canonical-first resolution — resolve the stage role to the
      // workspace's canonical agent (create-once) BEFORE dynamic routing. This is
      // the safety net for direct/legacy dispatches that bypass the workflow
      // engine: a verify-stage task without an assigned agent always resolves to
      // the canonical verifier (agent:verifier:), never to the previous stage's
      // agent or an arbitrary dynamic pick.
      const canonicalRole = mapRoleToCanonical(role);
      if (canonicalRole) {
        try {
          assignedAgentId = ensureCanonicalAgent(task.workspace_id, canonicalRole);
          console.log(`[Dispatch] Resolved ${task.status} → canonical ${canonicalRole} agent ${assignedAgentId} (PLATFORM-015)`);
        } catch (err) {
          console.error(`[Dispatch] ensureCanonicalAgent failed for role "${role}":`, (err as Error).message);
        }
      }
      if (!assignedAgentId) {
        const dynamicAgent = pickDynamicAgent(id, role);
        if (dynamicAgent) {
          assignedAgentId = dynamicAgent.id;
        }
      }
      if (assignedAgentId) {
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

    // PLATFORM-004c: prepare workspace for EVERY builder dispatch (idempotent).
    // Previously gated on determineIsolationStrategy() — tasks without repo_url
    // (and no parallel siblings) skipped this and reached 'done' with
    // workspace_path=NULL → NO_MERGE (5/5 occurrences). prepareTaskWorkspace
    // always persists workspace_path (project dir when no isolation is needed),
    // so the merge/PR step in triggerWorkspaceMerge always has a workspace.
    let workspaceIsolated = false;
    let workspaceBranchName: string | undefined;
    let workspacePort: number | undefined;
    const isBuilderDispatch = task.status === 'assigned' || task.status === 'in_progress' || task.status === 'inbox';
    if (isBuilderDispatch) {
      try {
        // PLATFORM-018: repo-backed tasks get an isolated git worktree (from
        // origin/HEAD, branch platform-<id>/<short>) so the agent can NEVER
        // commit into the shared supervisor repo. Non-repo tasks keep the
        // legacy workspace-isolation flow.
        const useTaskWorktree = worktreesEnabled() && Boolean((task as Task).repo_url);
        const workspace = useTaskWorktree
          ? await createTaskWorktree(task as Task)
          : await prepareTaskWorkspace(task as Task);
        taskProjectDir = workspace.path;
        workspaceIsolated = true;
        workspaceBranchName = workspace.branch;
        workspacePort = workspace.port;
        console.log(`[Dispatch] Prepared ${workspace.strategy} workspace for task ${task.id} (branch=${workspace.branch}): ${workspace.path}`);
      } catch (err) {
        console.warn(`[Dispatch] Workspace prepare failed, using default path:`, (err as Error).message);
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
        `Agent "${agent.name}" has no gateway session prefix — assign a canonical gateway agent (manager/builder/tester/reviewer/verifier/learner) and retry`,
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

    // PLATFORM-013: pre-reuse busy check (hybrid: local sessions.json fast
    // path → gateway poll fallback). A target session whose turn is STILL
    // processing must rotate — reusing it throws
    // EmbeddedAttemptSessionTakeoverError and stalls the task (P009). The
    // gateway agent id is derived from the session prefix (agent:tester: →
    // tester) so the per-agent sessions.json resolves even when the MC agent
    // row id differs from the gateway agent id.
    const gatewayAgentId = prefix.replace(/^agent:/, '').replace(/:$/, '');
    const busyOverride = latestSession
      ? isSessionBusy({
          sessionKey: `${prefix}${latestSession.openclaw_session_id}`,
          gatewaySessions,
          localSessionsPath: resolveLocalSessionsPath(gatewayAgentId),
        })
      : null;
    if (busyOverride?.busy) {
      console.warn(`[Dispatch] Pre-reuse busy check: session ${prefix}${latestSession!.openclaw_session_id} is ${busyOverride.status ?? 'busy'} (${busyOverride.reason}, source=${busyOverride.source}) — will rotate for task ${id}`);
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
      busyOverride,
    });
    const session = resolution.session;
    const reusedExistingSession = resolution.reusedExistingSession;

    if (!session) {
      return dispatchErrorResponse(id, 'Failed to create agent session', 500);
    }

    if (resolution.rotated) {
      const rotatedAt = new Date().toISOString();
      const rotationLabel = rotationReasonLabel(resolution.rotationReasons);
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
            rotation_reason: rotationLabel,
            session_id: session.openclaw_session_id,
            rotated_from: latestSession?.openclaw_session_id ?? null,
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
          JSON.stringify({
            session_id: session.openclaw_session_id,
            run_number: resolution.runNumber,
            rotated_from: latestSession?.openclaw_session_id ?? null,
            rotation_reason: rotationLabel,
          }),
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
    // PLATFORM-013: success-path finalizer shared by normal dispatch and
    // busy-session auto-recovery retry (so both paths keep identical
    // status/event/activity bookkeeping).
    const finalizeDispatch = (
      usedSession: OpenClawSession,
      wasRotated: boolean,
      rotationReasons: string[],
      verdictTokens: { totalTokens: number | null; ctxPct: number | null } | null,
    ): NextResponse => {
      console.info('[Dispatch] Task message delivered to agent session', JSON.stringify({
        taskId: task.id,
        agentId: agent.id,
        sessionId: usedSession.openclaw_session_id,
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
          sessionId: usedSession.openclaw_session_id,
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
            openclaw_session_id: usedSession.openclaw_session_id,
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
            openclaw_session_id: usedSession.openclaw_session_id,
            context: dispatchContext.audit,
          }),
          now,
        ]
      );

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agent.id,
        session_id: usedSession.openclaw_session_id,
        context_version: dispatchContext.audit.version,
        message: 'Task dispatched to agent',
        rotated: wasRotated,
        ...(wasRotated ? { reason: rotationReasonLabel(rotationReasons) } : {}),
        run_number: usedSession.run_number,
        ...(rotationReasons.length > 0 ? { rotation_reasons: rotationReasons } : {}),
        ...(verdictTokens?.totalTokens != null ? { total_tokens: verdictTokens.totalTokens } : {}),
        ...(verdictTokens?.ctxPct != null ? { ctx_pct: verdictTokens.ctxPct } : {}),
        ...(previousRunExceeded ? { session_token_warning: `Previous run exceeded the cumulative token cap (${previousTotal} > ${healthConfig.maxTotalTokens})` } : {}),
        ...(costCapWarning ? { cost_cap_warning: costCapWarning } : {}),
      });
    };

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

      return finalizeDispatch(
        session,
        resolution.rotated,
        resolution.rotationReasons,
        {
          totalTokens: resolution.verdict?.totalTokens ?? null,
          ctxPct: resolution.verdict?.ctxPct ?? null,
        },
      );
    } catch (err) {
      console.error('Failed to send message to agent:', err);
      const errMessage = (err as Error).message || String(err);

      // PLATFORM-013: busy-session auto-recovery. When the target session's
      // previous turn is STILL processing (P009 stall signature), reuse would
      // throw EmbeddedAttemptSessionTakeoverError and leave the task stuck
      // until a manual retry-dispatch. Rotate to a fresh session and retry
      // the delivery ONCE — with a session_rotated activity (reason
      // busy_session) so the rotation is visible in the Activity tab.
      if (isBusySessionError(errMessage) && latestSession) {
        try {
          const rotated = rotateToFreshSession({
            taskId: id,
            agentId: agent.id,
            agentName: agent.name,
            previousSession: latestSession,
            reason: 'busy_session:auto-recovery',
          });
          const rotatedAt = new Date().toISOString();
          run(
            `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              crypto.randomUUID(),
              id,
              agent.id,
              'session_rotated',
              `Session rotated to fresh key ${rotated.session.openclaw_session_id} (run ${rotated.runNumber}) — previous session busy (turn still processing): ${errMessage.slice(0, 160)}`,
              JSON.stringify({
                run_number: rotated.runNumber,
                reasons: ['busy_session:auto-recovery'],
                rotation_reason: 'busy_session',
                session_id: rotated.session.openclaw_session_id,
                rotated_from: latestSession.openclaw_session_id,
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
              `Session rotated for task "${task.title}": busy_session (auto-recovery)`,
              JSON.stringify({
                session_id: rotated.session.openclaw_session_id,
                run_number: rotated.runNumber,
                rotated_from: latestSession.openclaw_session_id,
                rotation_reason: 'busy_session',
              }),
              rotatedAt,
            ]
          );
          console.warn(`[Dispatch] Busy-session auto-recovery: rotated ${latestSession.openclaw_session_id} → ${rotated.session.openclaw_session_id} (run ${rotated.runNumber}) for task ${id}`);

          const retryKey = `${prefix}${rotated.session.openclaw_session_id}`;
          await client.call('chat.send', {
            sessionKey: retryKey,
            message: finalMessage,
            idempotencyKey: `dispatch-${task.id}-${Date.now()}-retry`,
          });

          return finalizeDispatch(rotated.session, true, ['busy_session:auto-recovery'], null);
        } catch (retryErr) {
          console.error('Busy-session auto-recovery retry failed:', retryErr);
          // fall through to the standard failure path below
        }
      }

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
