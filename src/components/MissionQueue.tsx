'use client';

import { useEffect, useState } from 'react';
import { Plus, ChevronRight, GripVertical, ArrowRightLeft, AlertTriangle, AlertCircle, MessageSquare, RefreshCw, Loader2 } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { triggerAutoDispatch, shouldTriggerAutoDispatch } from '@/lib/auto-dispatch';
import { getConfig } from '@/lib/config';
import { useUnreadCounts } from '@/hooks/useUnreadCounts';
import type { Task, TaskStatus } from '@/lib/types';
import { TaskModal } from './TaskModal';
import { RoleChain } from './RoleChain';
import { EnvironmentIssuePanel, getTaskEnvironmentIssue } from './EnvironmentIssuePanel';
import { formatDistanceToNow } from 'date-fns';

interface MissionQueueProps {
  workspaceId?: string;
  mobileMode?: boolean;
  isPortrait?: boolean;
}

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: 'planning', label: '📋 Planning', color: 'border-t-mc-accent-purple' },
  { id: 'inbox', label: 'Inbox', color: 'border-t-mc-accent-pink' },
  { id: 'assigned', label: 'Assigned', color: 'border-t-mc-accent-yellow' },
  { id: 'in_progress', label: 'In Progress', color: 'border-t-mc-accent' },
  { id: 'convoy_active', label: '🚚 Convoy', color: 'border-t-cyan-400' },
  { id: 'testing', label: 'Testing', color: 'border-t-mc-accent-cyan' },
  { id: 'review', label: 'Review', color: 'border-t-mc-accent-purple' },
  { id: 'review_fix', label: 'Fixing PR', color: 'border-t-orange-400' },
  { id: 'verification', label: 'Verification', color: 'border-t-orange-500' },
  { id: 'menunggu_keputusan_manusia', label: '⏸️ Keputusan Manusia', color: 'border-t-red-400' },
  { id: 'done', label: 'Done', color: 'border-t-mc-accent-green' },
];

interface DispatchRetryResponse {
  success?: boolean;
  error?: string;
  userMessage?: string;
  task?: Task;
}

function getDispatchErrorSummary(error: string): string {
  const cleaned = error
    .replace(/^Auto-nudge failed:\s*/i, '')
    .replace(/^Auto-recovery failed:\s*/i, '')
    .replace(/^Retry dispatch failed:\s*/i, '')
    .trim();

  if (cleaned.toLowerCase().includes('no active') && cleaned.toLowerCase().includes('session')) {
    return 'Dispatch did not start a tracked runtime session.';
  }

  return cleaned || error;
}

export function MissionQueue({ workspaceId, mobileMode = false, isPortrait = true }: MissionQueueProps) {
  const { tasks, updateTaskStatus, addEvent } = useMissionControl();
  const [compactEmptyColumns, setCompactEmptyColumns] = useState(true);
  const unreadCounts = useUnreadCounts();

  useEffect(() => {
    const cfg = getConfig();
    setCompactEmptyColumns(cfg.kanbanCompactEmptyColumns ?? true);
  }, []);

  const getDesktopColumnWidth = (taskCount: number): string => {
    if (!compactEmptyColumns) return '280px';
    if (taskCount === 0) return 'fit-content';
    // Slightly grow busy columns while keeping a sane cap
    const widthPx = Math.min(380, 250 + taskCount * 14);
    return `${widthPx}px`;
  };
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [mobileStatus, setMobileStatus] = useState<TaskStatus>('planning');
  const [statusMoveTask, setStatusMoveTask] = useState<Task | null>(null);
  const [pendingMove, setPendingMove] = useState<{ task: Task; targetStatus: TaskStatus } | null>(null);

  const getTasksByStatus = (status: TaskStatus) => tasks.filter((task) => task.status === status);

  // Active pipeline states where manual moves are dangerous
  const ACTIVE_PIPELINE_STATES: TaskStatus[] = ['assigned', 'in_progress', 'convoy_active', 'testing', 'review', 'review_fix', 'verification'];

  const getPipelineWarning = (task: Task, targetStatus: TaskStatus): string | null => {
    if (!ACTIVE_PIPELINE_STATES.includes(task.status)) return null;
    // Moving to the same status or to done is less dangerous
    if (task.status === targetStatus) return null;

    const stateLabels: Record<string, string> = {
      assigned: 'queued for dispatch',
      in_progress: 'being built by an agent',
      convoy_active: 'running as a convoy',
      testing: 'being tested by an agent',
      review: 'in the review queue',
      review_fix: 'fixing PR reviewer feedback',
      verification: 'being verified by an agent',
    };

    const current = stateLabels[task.status] || task.status;
    return `This task is currently ${current}. Moving it manually will interrupt the automation pipeline and may cause the assigned agent to lose context. Are you sure you want to override?`;
  };

  const attemptMove = async (task: Task, targetStatus: TaskStatus) => {
    const warning = getPipelineWarning(task, targetStatus);
    if (warning) {
      setPendingMove({ task, targetStatus });
      return;
    }
    await updateTaskStatusWithPersist(task, targetStatus);
  };

  const confirmPendingMove = async () => {
    if (!pendingMove) return;
    const { task, targetStatus } = pendingMove;
    setPendingMove(null);
    setStatusMoveTask(null);
    await updateTaskStatusWithPersist(task, targetStatus);
  };

  const updateTaskStatusWithPersist = async (task: Task, targetStatus: TaskStatus) => {
    if (task.status === targetStatus) return;

    updateTaskStatus(task.id, targetStatus);

    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: targetStatus }),
      });

      if (res.ok) {
        addEvent({
          id: task.id + '-' + Date.now(),
          type: targetStatus === 'done' ? 'task_completed' : 'task_status_changed',
          task_id: task.id,
          message: `Task "${task.title}" moved to ${targetStatus}`,
          created_at: new Date().toISOString(),
        });

        if (shouldTriggerAutoDispatch(task.status, targetStatus, task.assigned_agent_id)) {
          const result = await triggerAutoDispatch({
            taskId: task.id,
            taskTitle: task.title,
            agentId: task.assigned_agent_id,
            agentName: task.assigned_agent?.name || 'Unknown Agent',
            workspaceId: task.workspace_id,
          });

          if (!result.success) {
            console.error('Auto-dispatch failed:', result.error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to update task status:', error);
      updateTaskStatus(task.id, task.status);
    }
  };

  const handleDragStart = (e: React.DragEvent, task: Task) => {
    if (mobileMode) return;
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (mobileMode) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: TaskStatus) => {
    if (mobileMode) return;
    e.preventDefault();
    if (!draggedTask || draggedTask.status === targetStatus) {
      setDraggedTask(null);
      return;
    }

    await attemptMove(draggedTask, targetStatus);
    setDraggedTask(null);
  };

  const mobileTasks = getTasksByStatus(mobileStatus);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="p-3 border-b border-mc-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChevronRight className="w-4 h-4 text-mc-text-secondary" />
          <span className="text-sm font-medium uppercase tracking-wider">Mission Queue</span>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 min-h-11 bg-mc-accent-pink text-mc-bg rounded text-sm font-medium hover:bg-mc-accent-pink/90"
        >
          <Plus className="w-4 h-4" />
          New Task
        </button>
      </div>

      {!mobileMode ? (
        <div className="mission-queue-scroll-x flex-1 flex gap-3 p-3 overflow-x-auto">
          {COLUMNS.map((column) => {
            const columnTasks = getTasksByStatus(column.id);
            const hasTasks = columnTasks.length > 0;
            return (
              <div
                key={column.id}
                style={{ width: getDesktopColumnWidth(columnTasks.length) }}
                className={`flex-none ${compactEmptyColumns ? (hasTasks ? 'min-w-[240px]' : 'min-w-[110px] max-w-[180px]') : 'min-w-[250px] max-w-[320px]'} flex flex-col bg-mc-bg rounded-lg border border-mc-border/50 border-t-2 transition-[width] duration-200 ${column.color}`}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, column.id)}
              >
                <div className="p-2 border-b border-mc-border flex items-center justify-between gap-2">
                  <span className="text-xs font-medium uppercase text-mc-text-secondary whitespace-nowrap">{column.label}</span>
                  <span className="text-xs bg-mc-bg-tertiary px-2 py-0.5 rounded text-mc-text-secondary">{columnTasks.length}</span>
                </div>

                <div className={`flex-1 overflow-y-auto p-2 ${hasTasks ? 'space-y-2' : ''}`}>
                  {columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onDragStart={handleDragStart}
                      onClick={() => setEditingTask(task)}
                      onMoveStatus={() => setStatusMoveTask(task)}
                      isDragging={draggedTask?.id === task.id}
                      mobileMode={false}
                      portraitMode={false}
                      unreadCount={unreadCounts[task.id] || 0}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className={`flex-1 overflow-y-auto ${isPortrait ? 'p-3 pb-[calc(1rem+env(safe-area-inset-bottom))]' : 'p-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))]'}`}>
          <div className={`flex gap-2 overflow-x-auto ${isPortrait ? 'pb-3' : 'pb-2'}`}>
            {COLUMNS.map((column) => {
              const count = getTasksByStatus(column.id).length;
              const selected = mobileStatus === column.id;
              return (
                <button
                  key={column.id}
                  onClick={() => setMobileStatus(column.id)}
                  className={`min-h-11 px-4 rounded-full border whitespace-nowrap ${isPortrait ? 'text-sm' : 'text-xs'} ${
                    selected
                      ? 'bg-mc-accent text-mc-bg border-mc-accent font-medium'
                      : 'bg-mc-bg-secondary border-mc-border text-mc-text-secondary'
                  }`}
                >
                  {column.label} ({count})
                </button>
              );
            })}
          </div>

          <div className={`min-w-0 ${isPortrait ? 'space-y-3' : 'space-y-2'}`}>
            {mobileTasks.length === 0 ? (
              <div className="text-sm text-mc-text-secondary bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
                No tasks in this status.
              </div>
            ) : (
              mobileTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onDragStart={handleDragStart}
                  onClick={() => setEditingTask(task)}
                  onMoveStatus={() => setStatusMoveTask(task)}
                  isDragging={false}
                  mobileMode
                  portraitMode={isPortrait}
                  unreadCount={unreadCounts[task.id] || 0}
                />
              ))
            )}
          </div>
        </div>
      )}

      {showCreateModal && <TaskModal onClose={() => setShowCreateModal(false)} workspaceId={workspaceId} />}
      {editingTask && <TaskModal task={editingTask} onClose={() => setEditingTask(null)} workspaceId={workspaceId} />}

      {mobileMode && statusMoveTask && (
        <div className="fixed inset-0 z-50 bg-black/60 p-4 flex items-end sm:items-center sm:justify-center" onClick={() => setStatusMoveTask(null)}>
          <div
            className="w-full sm:max-w-md bg-mc-bg-secondary border border-mc-border rounded-t-xl sm:rounded-xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm text-mc-text-secondary mb-2">Move task</div>
            <div className="font-medium mb-4 line-clamp-2">{statusMoveTask.title}</div>
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {COLUMNS.map((column) => (
                <button
                  key={column.id}
                  onClick={async () => {
                    await attemptMove(statusMoveTask, column.id);
                    if (!getPipelineWarning(statusMoveTask, column.id)) {
                      setStatusMoveTask(null);
                    }
                  }}
                  disabled={statusMoveTask.status === column.id}
                  className="w-full min-h-11 px-4 rounded-lg border border-mc-border bg-mc-bg text-left text-sm disabled:opacity-40"
                >
                  {column.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Pipeline override warning dialog */}
      {pendingMove && (
        <div className="fixed inset-0 z-[60] bg-black/60 p-4 flex items-center justify-center" onClick={() => setPendingMove(null)}>
          <div
            className="w-full max-w-md bg-mc-bg-secondary border border-amber-500/30 rounded-xl p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="font-semibold text-mc-text">Override automation?</h3>
                <p className="text-sm text-mc-text-secondary mt-1">
                  {getPipelineWarning(pendingMove.task, pendingMove.targetStatus)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 p-3 bg-mc-bg rounded-lg border border-mc-border text-sm">
              <span className="text-mc-text-secondary">Moving:</span>
              <span className="font-medium text-mc-text truncate">{pendingMove.task.title}</span>
              <span className="text-mc-text-secondary mx-1">&rarr;</span>
              <span className="font-medium text-mc-text">{COLUMNS.find(c => c.id === pendingMove.targetStatus)?.label || pendingMove.targetStatus}</span>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPendingMove(null)}
                className="min-h-11 px-4 rounded-lg text-sm text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary"
              >
                Cancel
              </button>
              <button
                onClick={confirmPendingMove}
                className="min-h-11 px-4 rounded-lg text-sm font-medium bg-amber-500 text-black hover:bg-amber-400"
              >
                Override &amp; Move
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AssignedStatusBadge({
  task,
  portraitMode,
  retrying,
  retryError,
  onRetryDispatch,
}: {
  task: Task;
  portraitMode: boolean;
  retrying: boolean;
  retryError: string | null;
  onRetryDispatch: (e: React.MouseEvent) => void;
}) {
  const updatedAt = new Date(task.updated_at).getTime();
  const staleMs = Date.now() - updatedAt;
  const isStale = staleMs > 2 * 60 * 1000; // 2 minutes

  if (isStale) {
    const staleMinutes = Math.floor(staleMs / 60000);
    return (
      <div className={`${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-amber-500/10 rounded-md border border-amber-500/30`}>
        <div className="flex items-center gap-2 mb-1.5">
          <div className="w-2 h-2 bg-amber-400 rounded-full flex-shrink-0" />
          <span className="text-xs text-amber-200">Stuck in assigned for {staleMinutes}m</span>
        </div>
        <button
          onClick={onRetryDispatch}
          disabled={retrying}
          className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded border border-amber-500/30 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} />
          {retrying ? 'Dispatching...' : 'Retry Dispatch'}
        </button>
        {retryError && (
          <div className="mt-1.5 text-[11px] text-red-300 line-clamp-2" title={retryError}>
            {retryError}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-yellow-500/10 rounded-md border border-yellow-500/30`}>
      <div className="w-2 h-2 bg-yellow-400 rounded-full flex-shrink-0" />
      <span className="text-xs text-yellow-200">Assigned and validating — auto-start will move this to In Progress.</span>
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  onDragStart: (e: React.DragEvent, task: Task) => void;
  onClick: () => void;
  onMoveStatus: () => void;
  isDragging: boolean;
  mobileMode: boolean;
  portraitMode?: boolean;
  unreadCount?: number;
}

function TaskCard({ task, onDragStart, onClick, onMoveStatus, isDragging, mobileMode, portraitMode = true, unreadCount = 0 }: TaskCardProps) {
  const updateTask = useMissionControl((state) => state.updateTask);
  const [retryingDispatch, setRetryingDispatch] = useState(false);
  const [retryDispatchError, setRetryDispatchError] = useState<string | null>(null);
  const priorityStyles = {
    low: 'text-mc-text-secondary',
    normal: 'text-mc-accent',
    high: 'text-mc-accent-yellow',
    urgent: 'text-mc-accent-red',
  };

  const priorityDots = {
    low: 'bg-mc-text-secondary/40',
    normal: 'bg-mc-accent',
    high: 'bg-mc-accent-yellow',
    urgent: 'bg-mc-accent-red',
  };

  const isPlanning = task.status === 'planning';
  const isConvoyActive = task.status === 'convoy_active';
  const isReviewFix = task.status === 'review_fix';
  const isSubtask = !!task.is_subtask;
  const isAssigned = task.status === 'assigned';
  const isHumanDecision = task.status === 'menunggu_keputusan_manusia';
  const dispatchError = task.planning_dispatch_error;
  const environmentIssue = getTaskEnvironmentIssue(task);

  const handleRetryDispatch = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRetryingDispatch(true);
    setRetryDispatchError(null);

    try {
      const res = await fetch(`/api/tasks/${task.id}/dispatch/retry`, { method: 'POST' });
      const data = await res.json().catch(() => ({} as DispatchRetryResponse));

      if (!res.ok || !data.success) {
        const message = data.userMessage || data.error || 'Dispatch retry failed';
        setRetryDispatchError(message);
        console.error('Retry dispatch failed:', data.error || message);
        return;
      }

      if (data.task) {
        updateTask(data.task);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Dispatch retry failed';
      setRetryDispatchError(message);
      console.error('Retry dispatch error:', err);
    } finally {
      setRetryingDispatch(false);
    }
  };

  return (
    <div
      draggable={!mobileMode}
      onDragStart={(e) => onDragStart(e, task)}
      onClick={onClick}
      className={`group bg-mc-bg-secondary border rounded-lg cursor-pointer transition-all hover:shadow-lg hover:shadow-black/20 ${
        isDragging ? 'opacity-50 scale-95' : ''
      } ${isPlanning ? 'border-purple-500/40 hover:border-purple-500' : 'border-mc-border/50 hover:border-mc-accent/40'}`}
    >
      {!mobileMode && (
        <div className="flex items-center justify-center py-1.5 border-b border-mc-border/30 opacity-0 group-hover:opacity-100 transition-opacity">
          <GripVertical className="w-4 h-4 text-mc-text-secondary/50 cursor-grab" />
        </div>
      )}

      <div className={portraitMode ? 'p-4' : 'p-3'}>
        <div className="flex items-start justify-between gap-1.5">
          <h4 className={`font-medium leading-snug line-clamp-2 ${portraitMode ? 'text-sm mb-3' : 'text-xs mb-2'}`}>{task.title}</h4>
          {unreadCount > 0 && (
            <span className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 bg-mc-accent/15 text-mc-accent rounded text-[10px] font-medium" title={`${unreadCount} unread message${unreadCount !== 1 ? 's' : ''}`}>
              <MessageSquare className="w-2.5 h-2.5" />
              {unreadCount}
            </span>
          )}
        </div>

        {isPlanning && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-purple-500/10 rounded-md border border-purple-500/20`}>
            <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse flex-shrink-0" />
            <span className="text-xs text-purple-400 font-medium">Continue planning</span>
          </div>
        )}

        {isHumanDecision && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-red-500/10 rounded-md border border-red-500/30`}>
            <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
            <span className="text-xs text-red-300 font-medium">
              ⏸️ Menunggu keputusan manusia — planning macet ({(task as any).auto_restart_count ?? 2}× restart)
            </span>
          </div>
        )}

        {isConvoyActive && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-cyan-500/10 rounded-md border border-cyan-500/20`}>
            <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse flex-shrink-0" />
            <span className="text-xs text-cyan-300 font-medium">Convoy active — sub-tasks running</span>
          </div>
        )}

        {isReviewFix && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-orange-500/10 rounded-md border border-orange-500/20`}>
            <div className="w-2 h-2 bg-orange-400 rounded-full animate-pulse flex-shrink-0" />
            <span className="text-xs text-orange-300 font-medium">
              Fixing PR — cycle {task.review_fix_count ?? 0}/{task.review_fix_max ?? 3}
            </span>
          </div>
        )}

        {isSubtask && (
          <div className={`flex items-center gap-1 ${portraitMode ? 'mb-2' : 'mb-1.5'}`}>
            <span className="text-[10px] px-1.5 py-0.5 bg-cyan-500/15 text-cyan-400 rounded border border-cyan-500/20">SUB-TASK</span>
          </div>
        )}

        {environmentIssue && (
          <EnvironmentIssuePanel
            task={task}
            compact
            className={portraitMode ? 'mb-3' : 'mb-2'}
          />
        )}

        {isAssigned && dispatchError && !environmentIssue && (
          <div className={`${portraitMode ? 'mb-3 p-3' : 'mb-2 p-2.5'} bg-red-500/10 rounded-md border border-red-500/30`}>
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-red-300 mt-0.5 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-red-200">Dispatch blocked</div>
                <div className="text-[11px] text-red-300/90 line-clamp-2" title={dispatchError}>
                  {getDispatchErrorSummary(dispatchError)}
                </div>
              </div>
            </div>
            <button
              onClick={handleRetryDispatch}
              disabled={retryingDispatch}
              className="mt-2 inline-flex items-center gap-1.5 text-[11px] px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-200 rounded border border-red-500/30 disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${retryingDispatch ? 'animate-spin' : ''}`} />
              {retryingDispatch ? 'Retrying...' : 'Retry dispatch'}
            </button>
            {retryDispatchError && (
              <div className="mt-1.5 text-[11px] text-red-300 line-clamp-2" title={retryDispatchError}>
                {retryDispatchError}
              </div>
            )}
          </div>
        )}

        {isAssigned && !dispatchError && !environmentIssue && (
          <AssignedStatusBadge
            task={task}
            portraitMode={portraitMode}
            retrying={retryingDispatch}
            retryError={retryDispatchError}
            onRetryDispatch={handleRetryDispatch}
          />
        )}

        {task.status === 'inbox' && !task.assigned_agent_id && (
          <div className={`space-y-2 ${portraitMode ? 'mb-3' : 'mb-2'}`}>
            {/* PLATFORM-004a: Run button for inbox tasks */}
            <RunTaskButton 
              taskId={task.id} 
              onStarted={() => onClick()}
              portraitMode={portraitMode}
            />
            <div className="flex items-center gap-2 py-1.5 px-2.5 bg-amber-500/10 rounded-md border border-amber-500/30">
              <div className="w-2 h-2 bg-amber-400 rounded-full flex-shrink-0" />
              <span className="text-xs text-amber-200">Or assign agent manually to start</span>
            </div>
          </div>
        )}

        {/* PLATFORM-004a: Progress badge inline */}
        {task.status === 'planning' && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-2 py-1.5 px-2.5' : 'mb-1.5 py-1 px-2'} bg-purple-500/10 rounded-md border border-purple-500/20`}>
            <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse flex-shrink-0" />
            <span className="text-xs text-purple-400">🔄 Planning...</span>
          </div>
        )}
        {task.status === 'assigned' && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-2 py-1.5 px-2.5' : 'mb-1.5 py-1 px-2'} bg-yellow-500/10 rounded-md border border-yellow-500/20`}>
            <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse flex-shrink-0" />
            <span className="text-xs text-yellow-300">📤 Dispatching...</span>
          </div>
        )}
        {task.status === 'in_progress' && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-2 py-1.5 px-2.5' : 'mb-1.5 py-1 px-2'} bg-blue-500/10 rounded-md border border-blue-500/20`}>
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse flex-shrink-0" />
            <span className="text-xs text-blue-300">🔨 Building...</span>
          </div>
        )}

        {['testing', 'verification'].includes(task.status) && dispatchError && !environmentIssue && (
          <div className={`flex items-start gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-red-500/10 rounded-md border border-red-500/30`}>
            <div className="w-2 h-2 bg-red-400 rounded-full mt-1 flex-shrink-0" />
            <span className="text-xs text-red-300">{dispatchError}</span>
          </div>
        )}

        {task.status === 'review' && !dispatchError && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} bg-cyan-500/10 rounded-md border border-cyan-500/30`}>
            <div className="w-2 h-2 bg-cyan-400 rounded-full flex-shrink-0" />
            <span className="text-xs text-cyan-200">In queue — waiting for verification</span>
          </div>
        )}

        {task.assigned_agent && (
          <div className={`flex items-center gap-2 ${portraitMode ? 'mb-3 py-1.5 px-2' : 'mb-2 py-1 px-2'} bg-mc-bg-tertiary/50 rounded`}>
            <span className="text-base">{(task.assigned_agent as unknown as { avatar_emoji: string }).avatar_emoji}</span>
            <span className="text-xs text-mc-text-secondary truncate">{(task.assigned_agent as unknown as { name: string }).name}</span>
          </div>
        )}

        {/* PLATFORM-004b: handshake role chain (main→builder→tester→reviewer→verifier→learner) */}
        {task.role_chain && task.role_chain.length > 0 && (
          <div className={`${portraitMode ? 'mb-3' : 'mb-2'}`}>
            <div className="text-[9px] uppercase tracking-wider text-mc-text-secondary/60 mb-1">Handshake</div>
            <RoleChain chain={task.role_chain} knowledgeCount={task.knowledge_count} variant="compact" />
          </div>
        )}

        {task.workspace_path && (
          <div className={`flex items-center gap-1.5 ${portraitMode ? 'mb-2' : 'mb-1.5'}`}>
            <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/15 text-purple-400 rounded border border-purple-500/20">
              {task.workspace_strategy === 'worktree' ? '\u{1F500}' : '\u{1F512}'} ISOLATED
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-mc-border/20">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${priorityDots[task.priority]}`} />
            <span className={`text-xs capitalize ${priorityStyles[task.priority]}`}>{task.priority}</span>
            {task.jira_issue_key && (
              <span className="text-[10px] font-medium text-blue-400" title={`Linked: ${task.jira_issue_key}`}>
                JIRA
              </span>
            )}
          </div>
          <span className="text-[10px] text-mc-text-secondary/60">{formatDistanceToNow(new Date(task.created_at), { addSuffix: true })}</span>
        </div>

        {mobileMode && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMoveStatus();
            }}
            className={`w-full min-h-11 rounded-md border border-mc-border bg-mc-bg flex items-center justify-center gap-2 text-mc-text-secondary ${portraitMode ? 'mt-3 text-sm' : 'mt-2 text-xs'}`}
          >
            <ArrowRightLeft className="w-4 h-4" />
            Move Status
          </button>
        )}
      </div>
    </div>
  );
}

function RunTaskButton({ taskId, onStarted, portraitMode }: { taskId: string; onStarted: () => void; portraitMode: boolean }) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const handleRun = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRunning(true);
    setRunError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/run`, {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();

      if (res.ok && data.success) {
        // Planning started — open the task modal to show Q&A
        onStarted();
      } else if (data.alreadyPlanning) {
        // Already planning — just open
        onStarted();
      } else {
        setRunError(data.error || 'Failed to start');
      }
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <button
        onClick={handleRun}
        disabled={running}
        className={`w-full flex items-center justify-center gap-1.5 py-1.5 px-3 bg-green-600 hover:bg-green-500 text-white rounded-md font-medium transition-colors disabled:opacity-50 ${
          portraitMode ? 'text-sm' : 'text-xs'
        }`}
      >
        {running ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Starting...
          </>
        ) : (
          <>▶ Run</>
        )}
      </button>
      {runError && (
        <p className="mt-1 text-[10px] text-red-400">{runError}</p>
      )}
    </div>
  );
}
