'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, Circle, Lock, AlertCircle, Loader2, X } from 'lucide-react';

interface PlanningOption {
  id: string;
  label: string;
}

interface PlanningQuestion {
  question: string;
  options: PlanningOption[];
  recommended?: string;
  recommended_reason?: string;
}

interface PlanningMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface PlanningState {
  taskId: string;
  sessionKey?: string;
  messages: PlanningMessage[];
  currentQuestion?: PlanningQuestion;
  isComplete: boolean;
  dispatchError?: string;
  stallInfo?: {
    stall_code: string;
    reason: string;
    userMessage: string;
  };
  spec?: {
    title: string;
    summary: string;
    deliverables: string[];
    success_criteria: string[];
    constraints: Record<string, unknown>;
  };
  agents?: Array<{
    name: string;
    role: string;
    avatar_emoji: string;
    soul_md: string;
    instructions: string;
  }>;
  isStarted: boolean;
  // PLATFORM-014: watchdog visibility
  status?: string;
  autoRestartCount?: number;
  awaitingHumanDecision?: boolean;
}

interface PlanningTabProps {
  taskId: string;
  onSpecLocked?: () => void;
}

export function PlanningTab({ taskId, onSpecLocked }: PlanningTabProps) {
  const [state, setState] = useState<PlanningState | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otherText, setOtherText] = useState('');
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [retryingDispatch, setRetryingDispatch] = useState(false);
  const [isSubmittingAnswer, setIsSubmittingAnswer] = useState(false);
  const [stalePlanning, setStalePlanning] = useState(false);
  const [awaitingUser, setAwaitingUser] = useState(false);
  
  // PLATFORM-004a: Auto-answer + fail-fast state
  const [autoAnswering, setAutoAnswering] = useState(false);
  const [autoAnswerStatus, setAutoAnswerStatus] = useState<string | null>(null);
  const [stallInfo, setStallInfo] = useState<{
    reason: string;
    userMessage: string;
    stall_code: string;
  } | null>(null);
  
  const timeoutsRef = useRef({ softWarningMs: 90000, hardTimeoutMs: 300000 });
  const [forceCompleting, setForceCompleting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [noNewMessageCount, setNoNewMessageCount] = useState(0);

  // Refs to track polling state without triggering re-renders
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollingWarningTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pollingHardTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);
  const lastSubmissionRef = useRef<{ answer: string; otherText?: string } | null>(null);
  const currentQuestionRef = useRef<string | undefined>(undefined);
  


  // Load planning state (initial load only)
  const loadState = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();
        setState(data);
        currentQuestionRef.current = data.currentQuestion?.question;
        // Don't call onSpecLocked on initial load - only when planning completes actively
      }
    } catch (err) {
      console.error('Failed to load planning state:', err);
      setError('Failed to load planning state');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  // Stop polling (defined first to avoid circular dependency)
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingWarningTimeoutRef.current) {
      clearTimeout(pollingWarningTimeoutRef.current);
      pollingWarningTimeoutRef.current = null;
    }
    if (pollingHardTimeoutRef.current) {
      clearTimeout(pollingHardTimeoutRef.current);
      pollingHardTimeoutRef.current = null;
    }
    setIsWaitingForResponse(false);
  }, []);

  // Poll for updates using the poll endpoint (lightweight OpenClaw check)
  const pollForUpdates = useCallback(async () => {
    if (isPollingRef.current) return; // Prevent overlapping polls
    isPollingRef.current = true;

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/poll`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const data = await res.json();

        // Track stale planning state from server
        if (data.stalePlanning) {
          setStalePlanning(true);
        }
        // PLATFORM-001: awaiting-user flag + server-driven timeouts
        if (data.awaitingUser !== undefined) {
          setAwaitingUser(!!data.awaitingUser);
        }
        if (data.timeouts) {
          timeoutsRef.current = data.timeouts;
        }

        // Track consecutive "no updates" polls — if we get 15+ (30 seconds)
        // with no movement after submitting an answer, something is wrong
        if (!data.hasUpdates && isWaitingForResponse) {
          setNoNewMessageCount(prev => {
            const next = prev + 1;
            if (next >= 15) setStalePlanning(true);
            return next;
          });
        }

        if (data.hasUpdates) {
          // Clear any stale waiting warnings once updates are flowing
          setError(null);
          setStalePlanning(false);
          setNoNewMessageCount(0);

          const newQuestion = data.currentQuestion?.question;
          const questionChanged = newQuestion && currentQuestionRef.current !== newQuestion;

          // Force a full state reload from server to avoid stale state issues
          const freshRes = await fetch(`/api/tasks/${taskId}/planning`, { signal: AbortSignal.timeout(15000) });
          if (freshRes.ok) {
            const freshData = await freshRes.json();
            setState(freshData);
          } else {
            setState(prev => ({
              ...prev!,
              messages: data.messages,
              isComplete: data.complete,
              spec: data.spec,
              agents: data.agents,
              currentQuestion: data.currentQuestion,
              dispatchError: data.dispatchError,
            }));
          }

          if (questionChanged) {
            currentQuestionRef.current = newQuestion;
            setSelectedOption(null);
            setOtherText('');
            setIsSubmittingAnswer(false);
          }
          // Always clear submitting state when we have a question
          if (data.currentQuestion) {
            setIsSubmittingAnswer(false);
            setSubmitting(false);
          }

          // Show dispatch error if present
          if (data.dispatchError) {
            setError(`Planning completed but dispatch failed: ${data.dispatchError}`);
          }

          if (data.complete && onSpecLocked) {
            onSpecLocked();
          }

          // Only stop polling when we actually have a question or completion
          if (data.currentQuestion || data.complete || data.dispatchError) {
            setIsWaitingForResponse(false);
            stopPolling();
          }
        }
      }
    } catch (err) {
      console.error('Failed to poll for updates:', err);
    } finally {
      isPollingRef.current = false;
    }
  }, [taskId, onSpecLocked, stopPolling, setState, setError, setIsSubmittingAnswer, setSelectedOption, setOtherText]);

  // Start polling when waiting for response
  const startPolling = useCallback(() => {
    stopPolling();
    setError(null);
    setIsWaitingForResponse(true);

    // Poll every 2 seconds for responsive UX
    pollingIntervalRef.current = setInterval(() => {
      pollForUpdates();
    }, 2000);

    // Soft warning — configurable via PLANNING_SOFT_WARNING_MS (server-driven), default 90s
    pollingWarningTimeoutRef.current = setTimeout(() => {
      setError('The orchestrator is still processing. You can refresh safely — you will not lose your place in Planning Mode.');
    }, timeoutsRef.current.softWarningMs);

    // Hard timeout — configurable via PLANNING_HARD_TIMEOUT_MS (server-driven), default 5 min
    pollingHardTimeoutRef.current = setTimeout(() => {
      stopPolling();
      setSubmitting(false);
      setIsSubmittingAnswer(false);
      setError('The orchestrator timed out after an extended wait. Please refresh the page and retry your last answer.');
    }, timeoutsRef.current.hardTimeoutMs);
  }, [pollForUpdates, stopPolling]);

  // Update currentQuestion ref when state changes
  useEffect(() => {
    if (state?.currentQuestion) {
      currentQuestionRef.current = state.currentQuestion.question;
    }
  }, [state]);

  // Initial load
  useEffect(() => {
    loadState();
    return () => stopPolling();
  }, [loadState, stopPolling]);

  // Auto-start polling if planning is in progress but no question loaded yet
  useEffect(() => {
    if (state && state.isStarted && !state.isComplete && !state.currentQuestion && !isWaitingForResponse) {
      startPolling();
    }
  }, [state, isWaitingForResponse, startPolling]);

  // Start planning session
  const startPlanning = async () => {
    setStarting(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning`, { method: 'POST', signal: AbortSignal.timeout(15000) });
      const data = await res.json();

      if (res.ok) {
        setState(prev => ({
          ...prev!,
          sessionKey: data.sessionKey,
          messages: data.messages || [],
          isStarted: true,
        }));

        // Start polling for the first question
        startPolling();
      } else {
        setError(data.error || 'Failed to start planning');
      }
    } catch (err) {
      setError('Failed to start planning');
    } finally {
      setStarting(false);
    }
  };

  // Submit answer
  const submitAnswer = async () => {
    if (!selectedOption) return;

    setSubmitting(true);
    setIsSubmittingAnswer(true); // Show submitting state in UI
    setError(null);

    // Store submission for retry
    const submission = {
      answer: selectedOption?.toLowerCase() === 'other' ? 'other' : selectedOption,
      otherText: selectedOption?.toLowerCase() === 'other' ? otherText : undefined,
    };
    lastSubmissionRef.current = submission;

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
        signal: AbortSignal.timeout(15000),
      });

      const data = await res.json();

      if (res.ok) {
        // Start polling for the next question or completion
        // Don't clear selection yet - keep it visible while waiting for response
        startPolling();
      } else {
        setError(data.error || 'Failed to submit answer');
        setIsSubmittingAnswer(false); // Clear submitting state on error
        // Clear selection on error so user can try again
        setSelectedOption(null);
        setOtherText('');
      }
    } catch (err) {
      setError('Failed to submit answer');
      setIsSubmittingAnswer(false); // Clear submitting state on error
      // Clear selection on error so user can try again
      setSelectedOption(null);
      setOtherText('');
    } finally {
      // Don't re-enable submit button here — wait until next question arrives
      // setSubmitting(false) is handled when polling gets the new question
    }
  };

  // Retry last submission
  const handleRetry = async () => {
    const submission = lastSubmissionRef.current;
    if (!submission) return;

    setSubmitting(true);
    setIsSubmittingAnswer(true); // Show submitting state
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submission),
        signal: AbortSignal.timeout(15000),
      });

      const data = await res.json();

      if (res.ok) {
        startPolling();
      } else {
        setError(data.error || 'Failed to submit answer');
        // Clear submission state and selection on error so user can retry
        setIsSubmittingAnswer(false);
        setSelectedOption(null);
        setOtherText('');
      }
    } catch (err) {
      setError('Failed to submit answer');
      // Clear submission state and selection on error so user can retry
      setIsSubmittingAnswer(false);
      setSelectedOption(null);
      setOtherText('');
    } finally {
      setSubmitting(false);
    }
  };

  // Retry dispatch for failed planning completions
  const retryDispatch = async () => {
    setRetryingDispatch(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/retry-dispatch`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
      });

      const data = await res.json();

      if (res.ok) {
        console.log('Dispatch retry successful:', data.message);
        setError(null);
      } else {
        setError(`Failed to retry dispatch: ${data.error}`);
      }
    } catch (err) {
      setError('Failed to retry dispatch');
    } finally {
      setRetryingDispatch(false);
    }
  };

  // Force complete planning when stuck
  const forceCompletePlanning = async () => {
    setForceCompleting(true);
    setError(null);

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/force-complete`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
      });

      const data = await res.json();

      if (res.ok) {
        setStalePlanning(false);
        setNoNewMessageCount(0);
        // Reload full state
        await loadState();
        if (onSpecLocked) onSpecLocked();
      } else {
        setError(data.error || 'Failed to force-complete planning');
      }
    } catch (err) {
      setError('Failed to force-complete planning');
    } finally {
      setForceCompleting(false);
    }
  };

  // Approve the plan (locks the spec, moves the task to the execution queue)
  const approvePlan = async () => {
    if (!confirm('Approve this plan? The spec will be locked and the task will move to the execution queue.')) return;
    setApproving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/approve`, {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      if (res.ok) {
        if (onSpecLocked) onSpecLocked();
      } else {
        setError(data.error || 'Failed to approve plan');
      }
    } catch (err) {
      setError('Failed to approve plan');
    } finally {
      setApproving(false);
    }
  };

  // PLATFORM-004a: Quick-accept the recommended answer
  const acceptRecommendation = () => {
    const recommended = state?.currentQuestion?.recommended;
    if (!recommended) return;
    
    const option = state?.currentQuestion?.options.find(
      (o) => o.id === recommended || o.label === recommended
    );
    if (option) {
      setSelectedOption(option.label);
    }
  };

  // PLATFORM-004a: Auto-answer — trigger backend loop
  const autoAnswer = async () => {
    setAutoAnswering(true);
    setAutoAnswerStatus('Memulai auto-answer...');
    setError(null);
    setStallInfo(null);

    try {
      // First ensure planning is started
      if (!state?.isStarted) {
        setAutoAnswerStatus('Memulai planning...');
        const startRes = await fetch(`/api/tasks/${taskId}/planning`, {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
        });
        const startData = await startRes.json();
        if (!startRes.ok) {
          setError(startData.error || 'Failed to start planning');
          setAutoAnswering(false);
          setAutoAnswerStatus(null);
          return;
        }
        // Refresh state
        const freshRes = await fetch(`/api/tasks/${taskId}/planning`, { signal: AbortSignal.timeout(15000) });
        if (freshRes.ok) {
          const freshData = await freshRes.json();
          setState(freshData);
        }
      }

      setAutoAnswerStatus('Menjawab Q&A otomatis...');

      // Trigger backend auto-answer loop (single request, backend does the loop)
      const res = await fetch(`/api/tasks/${taskId}/planning/auto-answer`, {
        method: 'POST',
        signal: AbortSignal.timeout(90000), // Allow up to 90s for the full loop
      });

      const data = await res.json();

      if (data.success) {
        setAutoAnswerStatus('✅ Planning selesai — task didispatch!');
        // Reload state after brief delay
        setTimeout(async () => {
          await loadState();
          setAutoAnswering(false);
          setAutoAnswerStatus(null);
          if (onSpecLocked) onSpecLocked();
        }, 1500);
      } else if (data.stall) {
        // Fail-fast — show stall banner
        setStallInfo({
          reason: data.reason || 'Auto-answer gagal',
          userMessage: data.userMessage || '⚠️ Menunggu keputusan — planning stall',
          stall_code: data.stall_code || 'unknown',
        });
        setAutoAnswering(false);
        setAutoAnswerStatus(null);
        // Reload state to sync with backend
        await loadState();
      } else {
        setError(data.error || 'Auto-answer gagal');
        setAutoAnswering(false);
        setAutoAnswerStatus(null);
      }
    } catch (err) {
      setStallInfo({
        reason: (err as Error).message,
        userMessage: '⚠️ Auto-answer gagal — menunggu keputusan manusia',
        stall_code: 'network_error',
      });
      setAutoAnswering(false);
      setAutoAnswerStatus(null);
      await loadState();
    }
  };

    // Cancel planning — PLATFORM-014: safe cancel (POST /planning/cancel) that
  // preserves planning messages/spec and returns the task to the inbox.
  const cancelPlanning = async () => {
    if (!confirm('Cancel planning? Messages/spec will be preserved and the task returns to the inbox.')) {
      return;
    }

    setCanceling(true);
    setError(null);
    setIsSubmittingAnswer(false); // Clear submitting state when canceling
    stopPolling(); // Stop polling when canceling

    try {
      const res = await fetch(`/api/tasks/${taskId}/planning/cancel`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok) {
        // Reset state (messages are preserved server-side; the tab shows a
        // fresh start — reload to reflect the task's new inbox status).
        setState({
          taskId,
          isStarted: false,
          messages: [],
          isComplete: false,
        });
        await loadState();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to cancel planning');
      }
    } catch (err) {
      setError('Failed to cancel planning');
    } finally {
      setCanceling(false);
    }
  };

  // PLATFORM-014: restart after a human decision — cancel (resets the
  // auto-restart budget) then start a fresh planning session.
  const restartAfterHumanDecision = async () => {
    setCanceling(true);
    setError(null);
    try {
      const cancelRes = await fetch(`/api/tasks/${taskId}/planning/cancel`, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
      });
      if (!cancelRes.ok) {
        const data = await cancelRes.json();
        setError(data.error || 'Failed to reset planning');
        return;
      }
      await startPlanning();
    } finally {
      setCanceling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-mc-accent" />
        <span className="ml-2 text-mc-text-secondary">Loading planning state...</span>
      </div>
    );
  }

  // Planning complete - show spec and agents
  if (state?.isComplete && state?.spec) {
    return (
      <div className="p-4 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-400">
            <Lock className="w-5 h-5" />
            <span className="font-medium">Planning Complete</span>
          </div>
          {state.dispatchError && (
            <div className="text-right">
              <span className="text-sm text-amber-400">⚠️ Dispatch Failed</span>
            </div>
          )}
        </div>
        
        {/* Dispatch Error with Retry */}
        {state.dispatchError && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-amber-400 text-sm font-medium mb-2">Task dispatch failed</p>
                <p className="text-amber-300 text-xs mb-3">{state.dispatchError}</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={retryDispatch}
                    disabled={retryingDispatch}
                    className="px-3 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs rounded disabled:opacity-50 flex items-center gap-1"
                  >
                    {retryingDispatch ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Retrying...
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-3 h-3" />
                        Retry Dispatch
                      </>
                    )}
                  </button>
                  <span className="text-amber-400 text-xs">
                    This will attempt to assign the task to an agent
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Spec Summary */}
        <div className="bg-mc-bg border border-mc-border rounded-lg p-4">
          <h3 className="font-medium mb-2">{state.spec.title}</h3>
          <p className="text-sm text-mc-text-secondary mb-4">{state.spec.summary}</p>
          
          {state.spec.deliverables?.length > 0 && (
            <div className="mb-3">
              <h4 className="text-sm font-medium mb-1">Deliverables:</h4>
              <ul className="list-disc list-inside text-sm text-mc-text-secondary">
                {state.spec.deliverables.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          
          {state.spec.success_criteria?.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-1">Success Criteria:</h4>
              <ul className="list-disc list-inside text-sm text-mc-text-secondary">
                {state.spec.success_criteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        
        {/* Generated Agents */}
        {state.agents && state.agents.length > 0 && (
          <div>
            <h3 className="font-medium mb-2">Agents Created:</h3>
            <div className="space-y-2">
              {state.agents.map((agent, i) => (
                <div key={i} className="bg-mc-bg border border-mc-border rounded-lg p-3 flex items-center gap-3">
                  <span className="text-2xl">{agent.avatar_emoji}</span>
                  <div>
                    <p className="font-medium">{agent.name}</p>
                    <p className="text-sm text-mc-text-secondary">{agent.role}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Approve Plan */}
        <div className="flex items-center justify-end gap-3 border-t border-mc-border pt-4">
          <button
            onClick={approvePlan}
            disabled={approving}
            className="px-6 py-2.5 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center gap-2"
          >
            {approving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Approving...
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4" />
                Approve Plan
              </>
            )}
          </button>
          {error && <span className="text-sm text-red-400">{error}</span>}
        </div>
      </div>
    );
  }

  // Not started - show start button
  if (!state?.isStarted) {
    return (
      <div className="flex flex-col items-center justify-center p-8 space-y-4">
        <div className="text-center">
          <h3 className="text-lg font-medium mb-2">Start Planning</h3>
          <p className="text-mc-text-secondary text-sm max-w-md">
            I&apos;ll ask you a few questions to understand exactly what you need. 
            All questions are multiple choice — just click to answer.
          </p>
        </div>
        
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}
        
        <button
          onClick={startPlanning}
          disabled={starting}
          className="px-6 py-3 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center gap-2"
        >
          {starting ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Starting...
            </>
          ) : (
            <>📋 Start Planning</>
          )}
        </button>
      </div>
    );
  }

  // Show current question
  return (
    <div className="flex flex-col h-full">
      {/* Progress indicator with cancel button */}
      <div className="p-4 border-b border-mc-border flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-mc-text-secondary">
          <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
          <span>Planning in progress...</span>
        </div>
        <button
          onClick={cancelPlanning}
          disabled={canceling}
          className="flex items-center gap-2 px-3 py-2 text-sm text-mc-accent-red hover:bg-mc-accent-red/10 rounded disabled:opacity-50"
        >
          {canceling ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Canceling...
            </>
          ) : (
            <>
              <X className="w-4 h-4" />
              Cancel
            </>
          )}
        </button>
      </div>

      {/* Question area */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* PLATFORM-014: watchdog banners — human decision & auto-restart visibility */}
        {state?.awaitingHumanDecision && (
          <div className="max-w-xl mx-auto mb-5 p-4 bg-red-500/10 border border-red-500/40 rounded-lg">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-red-300 font-medium text-sm">
                  ⚠️ Planning macet berulang — menunggu keputusan manusia
                </p>
                <p className="text-red-200/80 text-xs mt-1">
                  Planning agent tidak merespons setelah {state.autoRestartCount ?? 2}× auto-restart. Task tidak akan macet
                  selamanya — putuskan: reset &amp; coba lagi, atau batalkan planning (state tetap tersimpan).
                </p>
                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={restartAfterHumanDecision}
                    disabled={canceling}
                    className="px-3 py-1.5 text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded border border-red-500/30 disabled:opacity-50"
                  >
                    {canceling ? 'Memproses...' : '🔄 Reset & Restart Planning'}
                  </button>
                  <button
                    onClick={cancelPlanning}
                    disabled={canceling}
                    className="px-3 py-1.5 text-xs text-mc-text-secondary hover:text-mc-accent-red rounded border border-mc-border hover:border-mc-accent-red/30 disabled:opacity-50"
                  >
                    Cancel Planning
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {state?.status === 'planning' && (state?.autoRestartCount ?? 0) > 0 && (
          <div className="max-w-xl mx-auto mb-5 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-amber-300 font-medium text-sm">
                  🔄 Planning di-restart otomatis {state.autoRestartCount}× karena macet
                </p>
                <p className="text-amber-200/70 text-xs mt-1">
                  Watchdog mendeteksi planning tidak responsif &gt; timeout, lalu memulai ulang sesi (state sebelumnya
                  tersimpan). Setelah {state.autoRestartCount}/2 restart, task menunggu keputusan manusia.
                </p>
              </div>
            </div>
          </div>
        )}

        {state?.currentQuestion ? (
          <div className="max-w-xl mx-auto">
            {/* PLATFORM-004a: Stale / stall banner */}
            {stallInfo && (
              <div className="mb-5 p-4 bg-orange-500/10 border border-orange-500/40 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 text-orange-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-orange-300 font-medium text-sm">
                      ⚠️ Menunggu keputusan — planning stall
                    </p>
                    <p className="text-orange-200/80 text-xs mt-1">{stallInfo.reason}</p>
                    <div className="flex items-center gap-2 mt-3">
                      <button
                        onClick={() => {
                          setStallInfo(null);
                          setError(null);
                        }}
                        className="px-3 py-1.5 text-xs bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 rounded border border-orange-500/30"
                      >
                        Lanjutkan Manual
                      </button>
                      <button
                        onClick={() => {
                          setStallInfo(null);
                          autoAnswer();
                        }}
                        className="px-3 py-1.5 text-xs bg-mc-accent/20 hover:bg-mc-accent/30 text-mc-accent rounded border border-mc-accent/30"
                      >
                        Coba Auto-answer Lagi
                      </button>
                    </div>
                    <p className="text-orange-400/60 text-xs mt-2">
                      Kode: {stallInfo.stall_code}
                    </p>
                  </div>
                </div>
              </div>
            )}

            <h3 className="text-lg font-medium mb-6">
              {state.currentQuestion.question}
            </h3>

            {/* PLATFORM-004a: Quick-accept recommendation button */}
            {state.currentQuestion.recommended && (
              <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-green-400 bg-green-500/20 px-2 py-0.5 rounded">
                      💡 Rekomendasi
                    </span>
                    <span className="text-sm font-medium text-green-300">
                      {state.currentQuestion.recommended} — {state.currentQuestion.recommended_reason || 'Disarankan oleh orchestrator'}
                    </span>
                  </div>
                  <button
                    onClick={acceptRecommendation}
                    disabled={submitting}
                    className="shrink-0 px-3 py-1.5 text-xs bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded border border-green-500/30 transition-colors disabled:opacity-50"
                    title="Terima rekomendasi dan pilih jawaban ini"
                  >
                    Terima Rekomendasi
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {state.currentQuestion.options.map((option) => {
                const isSelected = selectedOption === option.label;
                const isOther = option.id === 'other' || option.label.toLowerCase() === 'other';
                const isThisOptionSubmitting = isSubmittingAnswer && isSelected;
                const isRecommended = state.currentQuestion?.recommended === option.id || 
                                       state.currentQuestion?.recommended === option.label;

                return (
                  <div key={option.id}>
                    <button
                      onClick={() => setSelectedOption(option.label)}
                      disabled={submitting}
                      className={`w-full flex items-center gap-3 p-4 rounded-lg border transition-all text-left ${
                        isThisOptionSubmitting
                          ? 'border-mc-accent bg-mc-accent/20'
                          : isSelected
                          ? 'border-mc-accent bg-mc-accent/10'
                          : isRecommended
                          ? 'border-green-500/40 bg-green-500/5 hover:border-green-500/60'
                          : 'border-mc-border hover:border-mc-accent/50'
                      } disabled:opacity-50`}
                    >
                      <span className={`w-8 h-8 rounded flex items-center justify-center text-sm font-bold ${
                        isSelected ? 'bg-mc-accent text-mc-bg' : 'bg-mc-bg-tertiary'
                      }`}>
                        {option.id.toUpperCase()}
                      </span>
                      <span className="flex-1">{option.label}</span>
                      {/* PLATFORM-004a: Recommendation badge */}
                      {isRecommended && (
                        <span
                          className="shrink-0 text-[10px] font-bold text-green-400 bg-green-500/20 px-1.5 py-0.5 rounded"
                          title={state.currentQuestion?.recommended_reason || 'Disarankan oleh orchestrator'}
                        >
                          💡 Rekomendasi
                        </span>
                      )}
                      {isThisOptionSubmitting ? (
                        <Loader2 className="w-5 h-5 text-mc-accent animate-spin" />
                      ) : isSelected && !submitting ? (
                        <CheckCircle className="w-5 h-5 text-mc-accent" />
                      ) : null}
                    </button>

                    {/* Other text input */}
                    {isOther && isSelected && (
                      <div className="mt-2 ml-11">
                        <input
                          type="text"
                          value={otherText}
                          onChange={(e) => setOtherText(e.target.value)}
                          placeholder="Please specify..."
                          className="w-full bg-mc-bg border border-mc-border rounded px-3 py-2 text-sm focus:outline-none focus:border-mc-accent"
                          disabled={submitting}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {error && (
              <div
                className={`mt-4 p-3 border rounded-lg ${
                  error.includes('still processing')
                    ? 'bg-orange-500/10 border-orange-500/40'
                    : 'bg-red-500/10 border-red-500/30'
                }`}
              >
                <div className="flex items-start gap-2">
                  <AlertCircle
                    className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                      error.includes('still processing') ? 'text-orange-300' : 'text-red-400'
                    }`}
                  />
                  <div className="flex-1">
                    <p className={`text-sm ${error.includes('still processing') ? 'text-orange-200' : 'text-red-400'}`}>
                      {error}
                    </p>
                    {!isWaitingForResponse && lastSubmissionRef.current && (
                      <button
                        onClick={handleRetry}
                        disabled={submitting}
                        className={`mt-2 text-xs underline disabled:opacity-50 ${
                          error.includes('still processing')
                            ? 'text-orange-300 hover:text-orange-200'
                            : 'text-red-400 hover:text-red-300'
                        }`}
                      >
                        {submitting ? 'Retrying...' : 'Retry'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Submit button + Auto-answer */}
            <div className="mt-6 space-y-3">
              <button
                onClick={submitAnswer}
                disabled={!selectedOption || submitting || (selectedOption === 'Other' && !otherText.trim())}
                className="w-full px-6 py-3 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Sending...
                  </>
                ) : (
                  'Continue →'
                )}
              </button>

              {/* PLATFORM-004a: Auto-answer button */}
              <button
                onClick={autoAnswer}
                disabled={autoAnswering || submitting}
                className="w-full px-6 py-2.5 border border-mc-accent/40 text-mc-accent hover:bg-mc-accent/10 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {autoAnswering ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Auto-answer...
                  </>
                ) : (
                  <>
                    ⚡ Auto-answer (pakai rekomendasi)
                  </>
                )}
              </button>

              {/* Auto-answer status */}
              {autoAnswerStatus && (
                <div className="flex items-center justify-center gap-2 text-sm text-mc-accent">
                  {autoAnswering && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>{autoAnswerStatus}</span>
                </div>
              )}

              {/* Waiting indicator after submit */}
              {isSubmittingAnswer && !submitting && !autoAnswering && (
                <div className="mt-2 flex items-center justify-center gap-2 text-sm text-mc-text-secondary">
                  <Loader2 className="w-4 h-4 animate-spin text-mc-accent" />
                  <span>Waiting for response...</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              {state?.awaitingHumanDecision ? (
                <>
                  <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-3" />
                  <p className="text-red-300 font-medium mb-2">Planning macet — menunggu keputusan manusia</p>
                  <p className="text-mc-text-secondary text-sm mb-4 max-w-sm">
                    Auto-restart habis ({state.autoRestartCount ?? 2}×). Gunakan tombol di banner atas untuk reset &amp;
                    restart atau batalkan planning.
                  </p>
                </>
              ) : awaitingUser ? (
                <>
                  <p className="text-mc-accent font-medium mb-2">Menunggu jawaban Anda — jawab pertanyaan di percakapan di atas.</p>
                  <p className="text-mc-text-secondary text-sm max-w-sm">
                    Planning berjalan normal; orchestrator sedang menunggu keputusan Anda.
                  </p>
                </>
              ) : stalePlanning ? (
                <>
                  <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
                  <p className="text-amber-300 font-medium mb-2">Planning appears stuck</p>
                  <p className="text-mc-text-secondary text-sm mb-4 max-w-sm">
                    The orchestrator hasn&apos;t responded in a while. This can happen when the completion message was processed but the dispatch didn&apos;t fire.
                  </p>
                  <div className="flex items-center justify-center gap-3">
                    <button
                      onClick={forceCompletePlanning}
                      disabled={forceCompleting}
                      className="px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-sm rounded-lg border border-amber-500/30 disabled:opacity-50 flex items-center gap-2"
                    >
                      {forceCompleting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Processing...
                        </>
                      ) : (
                        <>
                          <CheckCircle className="w-4 h-4" />
                          Force Complete &amp; Dispatch
                        </>
                      )}
                    </button>
                    <button
                      onClick={cancelPlanning}
                      disabled={canceling}
                      className="px-4 py-2 text-mc-text-secondary hover:text-mc-accent-red text-sm rounded-lg border border-mc-border hover:border-mc-accent-red/30"
                    >
                      Cancel Planning
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <Loader2 className="w-8 h-8 animate-spin text-mc-accent mx-auto mb-2" />
                  <p className="text-mc-text-secondary">
                    {isWaitingForResponse ? 'Waiting for response...' : 'Waiting for next question...'}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Conversation history (collapsed by default) */}
      {state?.messages && state.messages.length > 0 && (
        <details className="border-t border-mc-border">
          <summary className="p-3 text-sm text-mc-text-secondary cursor-pointer hover:bg-mc-bg-tertiary">
            View conversation ({state.messages.length} messages)
          </summary>
          <div className="p-3 space-y-2 max-h-48 overflow-y-auto bg-mc-bg">
            {state.messages.map((msg, i) => (
              <div key={i} className={`text-sm ${msg.role === 'user' ? 'text-mc-accent' : 'text-mc-text-secondary'}`}>
                <span className="font-medium">{msg.role === 'user' ? 'You' : 'Orchestrator'}:</span>{' '}
                <span className="opacity-75">{msg.content.substring(0, 100)}...</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
