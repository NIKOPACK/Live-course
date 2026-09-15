'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useStageStore } from '@/lib/store';
import { PENDING_SCENE_ID } from '@/lib/store/stage';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useI18n } from '@/lib/hooks/use-i18n';
import { CanvasArea } from '@/components/canvas/canvas-area';
import { PlaybackEngine, computePlaybackView, shouldAutoResumeLecture } from '@/lib/playback';
import { hasPlayableSceneActions } from '@/lib/playback/scene-playability';
import type { EngineMode, TriggerEvent, Effect } from '@/lib/playback';
import {
  canJumpWithinReconstructablePrefix,
  isUnsafePlaybackNavigationAction,
} from '@/lib/playback/action-navigation';
import {
  getActionResumeRestoreCursor,
  clearActionResumePosition,
  createActionResumePosition,
  getActionResumeStorageKey,
  readActionResumeState,
  saveActionResumePosition,
} from '@/lib/playback/action-resume';
import { loadCursor, saveCursor, type PlaybackCursor } from '@/lib/playback/cursor';
import { ActionEngine } from '@/lib/action/engine';
import { createAudioPlayer } from '@/lib/utils/audio-player';
import { useDiscussionTTS } from '@/lib/hooks/use-discussion-tts';
import { isLiveCourseTTSEnabled } from '@/lib/config/feature-flags';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import type { AudioIndicatorState } from '@/components/roundtable/audio-indicator';
import type { Action, DiscussionAction, SpeechAction } from '@/lib/types/action';
import { ChatArea, type ChatAreaRef } from '@/components/chat/chat-area';
import type { SessionCleanupPayload } from '@/components/chat/use-chat-sessions';
import { agentsToParticipants, useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { AlertTriangle } from 'lucide-react';
import { VisuallyHidden } from 'radix-ui';
import { ClassroomSessionBar } from '@/components/livecourse/ClassroomSessionBar';
import { LiveCaptionOverlay } from '@/components/livecourse/LiveCaptionOverlay';
import { useLiveCaptionStore } from '@/lib/store/live-caption';
import { TeacherAvatarHost } from '@/components/livecourse/TeacherAvatarHost';
import { nodeIdForScene } from '@/lib/livecourse/domain';
import {
  useLiveCourseSessionOptional,
  type LiveCourseSessionValue,
  type TeachingActionInput,
} from '@/lib/livecourse/session/context';
import { readClassroomActionAuthority } from '@/lib/livecourse/session/controller';
import { buildPlaybackCompletionInput } from '@/lib/livecourse/session/playback-completion';
import {
  pauseTeachingPlayback,
  resumeTeachingPlayback,
  type TeachingPlaybackControlPort,
} from '@/lib/livecourse/session/teaching-playback-control';
import {
  freezeRealtimePlayback,
  releaseRealtimePlayback,
  retainRealtimePlaybackHoldAfterFreezeFailure,
  type RealtimePlaybackControlPort,
} from '@/lib/livecourse/session/realtime-playback-control';
import type { StageStore } from '@/lib/api/stage-api-types';
import type { ReplayPresentationBridge } from '@/components/livecourse/ReplayPresentationBoundary';
import type { TeacherSpeechPort } from '@/lib/livecourse/realtime/client/teacher-speech';
import {
  checkpointFeedbackText,
  createCheckpointSubmissionCoordinator,
  nextTeachingNode,
  type CheckpointFeedbackInput,
} from '@/lib/livecourse/session/teaching-flow';
import { splitLongSpeechText } from '@/lib/audio/tts-utils';
import { createBrowserUuid } from '@/lib/utils/random-id';

const MOBILE_LAYOUT_MEDIA_QUERY = '(max-width: 767px)';
// Bound even slow Chinese narration below Realtime's per-response audio budget.
const TEACHER_SPEECH_CHUNK_LENGTH = 200;

type PlaybackSessionIdentity = Pick<LiveCourseSessionValue, 'courseId' | 'lessonId' | 'learnerId'>;

interface PlaybackBoundaryContext {
  readonly nodeId: string;
  readonly sceneId: string;
  readonly epoch: number;
  readonly runGeneration: number;
  readonly sessionEpoch: number;
  readonly sessionIdentity: PlaybackSessionIdentity | null;
  readonly engine: PlaybackEngine;
}

interface PlaybackSpeechBoundary extends PlaybackBoundaryContext {
  readonly actionId: string;
}

interface PlaybackSpeechCycle {
  readonly generation: number;
  readonly context: PlaybackBoundaryContext;
  startPromise: Promise<PlaybackSpeechBoundary | null>;
  start: PlaybackSpeechBoundary | null;
  endPromise: Promise<string | null> | null;
  endActionId: string | null;
}

type TeachingControlKind = 'pause' | 'resume';

interface PendingTeachingControl {
  readonly kind: TeachingControlKind;
  readonly nodeId: string;
  readonly idempotencyKey: string;
  /** A resume that commits W but cannot release playback compensates with a new pause. */
  readonly compensationKey: string;
  compensationPending: boolean;
}

interface PendingTeachingRetry {
  readonly nodeId: string;
  readonly idempotencyKey: string;
}

/**
 * All asynchronous teaching writes for one engine are kept together.  A
 * scene switch creates a new attempt, so a late speech/effect promise can
 * never be mistaken for a boundary belonging to the next scene.
 */
interface PlaybackAttempt {
  context: PlaybackBoundaryContext;
  expectsTeachingSession: boolean;
  /** Identity captured for the active teaching run. */
  teachingSessionEpoch: number | null;
  teachingSessionIdentity: PlaybackSessionIdentity | null;
  runGeneration: number;
  speechGeneration: number;
  speechCycles: PlaybackSpeechCycle[];
  activeSpeech: PlaybackSpeechCycle | null;
  effectActionIds: string[];
  effectActionPromises: Array<Promise<string | null>>;
  failure: Error | null;
  completionGuard: boolean;
}

function createPlaybackAttempt(input: {
  sceneId: string;
  nodeId: string;
  epoch: number;
  sessionEpoch: number;
  sessionIdentity: PlaybackSessionIdentity | null;
  engine: PlaybackEngine;
  expectsTeachingSession: boolean;
}): PlaybackAttempt {
  return {
    context: {
      nodeId: input.nodeId,
      sceneId: input.sceneId,
      epoch: input.epoch,
      runGeneration: 0,
      sessionEpoch: input.sessionEpoch,
      sessionIdentity: input.sessionIdentity,
      engine: input.engine,
    },
    expectsTeachingSession: input.expectsTeachingSession,
    teachingSessionEpoch: input.sessionIdentity ? input.sessionEpoch : null,
    teachingSessionIdentity: input.sessionIdentity,
    runGeneration: 0,
    speechGeneration: 0,
    speechCycles: [],
    activeSpeech: null,
    effectActionIds: [],
    effectActionPromises: [],
    failure: null,
    completionGuard: false,
  };
}

function readPlaybackSessionIdentity(
  session: LiveCourseSessionValue | null,
): PlaybackSessionIdentity | null {
  if (!session || session.status !== 'ready') return null;
  const { courseId, lessonId, learnerId } = session;
  if (
    typeof courseId !== 'string' ||
    courseId.trim().length === 0 ||
    typeof lessonId !== 'string' ||
    lessonId.trim().length === 0 ||
    typeof learnerId !== 'string' ||
    learnerId.trim().length === 0
  ) {
    return null;
  }
  return { courseId, lessonId, learnerId };
}

function samePlaybackSessionIdentity(
  left: PlaybackSessionIdentity | null,
  right: PlaybackSessionIdentity | null,
): boolean {
  return Boolean(
    left &&
    right &&
    left.courseId === right.courseId &&
    left.lessonId === right.lessonId &&
    left.learnerId === right.learnerId,
  );
}

function toPlaybackError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(error == null ? fallback : String(error));
}

function createTeachingControlKey(
  kind: TeachingControlKind | 'retry',
  nodeId: string,
  generation: number,
): string {
  const nonce = createBrowserUuid();
  // The action schema caps identifiers at 240 characters. Keep the useful
  // node prefix while leaving room for the operation generation and nonce.
  return `lesson.${kind}:${nodeId.slice(0, 96)}:${generation}:${nonce}`;
}

function requireCommittedActionId(result: unknown, fallback: string): string {
  const actionId = (result as { action?: { id?: unknown } } | null)?.action?.id;
  if (typeof actionId !== 'string' || actionId.trim().length === 0) {
    throw new Error(fallback);
  }
  return actionId;
}

function mustReconcileTeachingWrite(error: unknown): boolean {
  const authority = readClassroomActionAuthority(error);
  return authority === 'uncertain' || authority === 'committed';
}

function subscribeMobileLayout(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const media = window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

function getMobileLayoutSnapshot(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY).matches;
}

/**
 * Imperative handle exposed via `ref` so the parent (`Stage`) can tear
 * down playback state synchronously before flipping mode to `'edit'`.
 * Unmount cleanup would run anyway, but the toggle needs to `await`
 * `endActiveSession()` (which aborts SSE) before we trust the engine /
 * chat to be quiescent — fire-and-forget on unmount loses that guarantee.
 */
export interface PlaybackChromeRootHandle {
  /** Ends any active SSE session, stops the engine, cleans up TTS audio. */
  teardown: () => Promise<void>;
}

interface PlaybackChromeRootProps {
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
  /** Routes playback-only Stage API mutations through an in-memory adapter. */
  readonly presentationStore?: StageStore;
  readonly presentationOnly?: boolean;
  /** Whether the Pro Switch in Header should be enabled. */
  readonly canEnterProMode?: boolean;
  /** Pro Switch click handler — parent coordinates editLock + teardown. */
  readonly onEnterProMode?: () => void;
  /** Replay-only advance hook. The replay controller owns the authoritative W cursor. */
  readonly replayBridge?: ReplayPresentationBridge;
}

/**
 * PlaybackChromeRoot — owns the entire playback/autonomous chrome and
 * its state. Mounted whenever `mode !== 'edit'`. The Pro Switch in
 * `Header` calls `onEnterProMode`; the parent `Stage` is responsible
 * for calling `ref.teardown()` before unmounting this root so SSE and
 * the engine wind down cleanly.
 */
export const PlaybackChromeRoot = forwardRef<PlaybackChromeRootHandle, PlaybackChromeRootProps>(
  function PlaybackChromeRoot(
    { onRetryOutline, presentationStore, presentationOnly = false, replayBridge },
    ref,
  ) {
    const { t, locale } = useI18n();
    const {
      mode,
      stage,
      getCurrentScene,
      scenes,
      currentSceneId,
      setCurrentSceneId,
      generatingOutlines,
      outlines,
    } = useStageStore();
    const failedOutlines = useStageStore.use.failedOutlines();
    const generationComplete = useStageStore.use.generationComplete();

    const currentScene = getCurrentScene();
    const playbackStore = presentationStore ?? useStageStore;
    const liveCourseSession = useLiveCourseSessionOptional();
    const emitLiveCourseAction = liveCourseSession?.emitAction;
    const liveCourseSessionRef = useRef(liveCourseSession);
    const teacherSpeechRef = useRef<TeacherSpeechPort | null>(null);
    const [startingTeaching, setStartingTeaching] = useState(false);
    const startingTeachingRef = useRef(false);
    const [checkpointFeedbackBusy, setCheckpointFeedbackBusy] = useState(false);
    const feedbackAbortRef = useRef<AbortController | null>(null);
    const feedbackSubmissionsRef = useRef(createCheckpointSubmissionCoordinator<void>());
    const pendingCompletionRef = useRef<{
      input: Parameters<LiveCourseSessionValue['completeTeachingNode']>[0];
      epoch: number;
    } | null>(null);
    const relistenRef = useRef<{
      originNodeId: string;
      originSceneId: string;
      actionIndex: number;
      wasPlaying: boolean;
      wasIdle: boolean;
      targetNodeId: string;
      startKey: string;
      endKey: string;
      startConfirmed: boolean;
      endPending: boolean;
      restoreReady?: Promise<void>;
      releaseRestore?: () => void;
    } | null>(null);
    const relistenRestoreRef = useRef<{
      sceneId: string;
      actionIndex: number;
      wasPlaying: boolean;
      wasIdle: boolean;
      ready: Promise<void>;
    } | null>(null);
    const endRelistenRef = useRef<(() => Promise<void>) | null>(null);
    const handleTeacherChange = useCallback((teacher: TeacherSpeechPort | null) => {
      teacherSpeechRef.current = teacher;
    }, []);
    const connectTeacher = useCallback(async () => {
      const teacher = teacherSpeechRef.current;
      if (!teacher) throw new Error('Classroom teacher is not ready');
      await teacher.connect();
      if (teacherSpeechRef.current !== teacher) throw new Error('Classroom teacher changed');
    }, []);
    const speakClassroomText = useCallback(async (text: string, signal: AbortSignal) => {
      const teacher = teacherSpeechRef.current;
      if (!teacher) throw new Error('Classroom teacher is not ready');
      for (const chunk of splitLongSpeechText(text, TEACHER_SPEECH_CHUNK_LENGTH)) {
        signal.throwIfAborted();
        if (teacherSpeechRef.current !== teacher) throw new Error('Classroom teacher changed');
        await teacher.speak(chunk, { signal });
      }
    }, []);
    const sessionIdentityKey = liveCourseSession
      ? [
          liveCourseSession.status,
          liveCourseSession.courseId,
          liveCourseSession.lessonId,
          liveCourseSession.learnerId ?? '',
        ].join('\u0000')
      : 'none';
    const sessionIdentityKeyRef = useRef(sessionIdentityKey);
    const sessionEpochRef = useRef(0);
    const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Layout effects run in the same commit as the provider transition, before
    // any promise continuation can observe the new tree. This keeps callbacks
    // synchronous without mutating refs during render.
    useLayoutEffect(() => {
      liveCourseSessionRef.current = liveCourseSession;
      if (sessionIdentityKeyRef.current !== sessionIdentityKey) {
        sessionIdentityKeyRef.current = sessionIdentityKey;
        sessionEpochRef.current += 1;
      }
    }, [liveCourseSession, sessionIdentityKey]);
    const clearAutoAdvanceTimer = useCallback(() => {
      if (autoAdvanceTimerRef.current) {
        clearTimeout(autoAdvanceTimerRef.current);
        autoAdvanceTimerRef.current = null;
      }
    }, []);
    const emitLiveCourseActionSafely = useCallback(
      (input: TeachingActionInput): Promise<unknown> => {
        if (presentationOnly) return Promise.resolve(null);
        const session = liveCourseSessionRef.current;
        if (!session?.emitAction || session.status !== 'ready') return Promise.resolve(null);
        if (relistenRef.current) return Promise.resolve(null);
        if (!['teaching', 'checking', 'interrupted'].includes(session.classroomState))
          return Promise.resolve(null);
        return session.emitAction(input).catch((error) => {
          console.error('[LiveCourse] Failed to publish playback action', error);
          return null;
        });
      },
      [presentationOnly],
    );

    const switchScene = useCallback(
      async (targetSceneId: string): Promise<boolean> => {
        // Any explicit navigation supersedes a delayed auto-advance from the
        // completed scene. The timer callback itself has already cleared this
        // ref, so this is safe for both manual and automatic navigation.
        clearAutoAdvanceTimer();
        if (presentationOnly && targetSceneId === PENDING_SCENE_ID) {
          // The synthetic generation/completion slot is outside replay W. Do
          // not pass it to the controller or fall back to `advance()`.
          setPlaybackError('Replay cannot navigate to a pending scene');
          return false;
        }
        if (
          presentationOnly &&
          replayBridge?.canNavigate &&
          !replayBridge.canNavigate(nodeIdForScene(targetSceneId))
        ) {
          // An un-taught scene is not a playback failure; it is simply outside
          // the replay range and must remain inert in the navigation chrome.
          return false;
        }
        if (presentationOnly && replayBridge) {
          try {
            if (!replayBridge.navigate) {
              throw new Error('Replay navigation is not ready');
            }
            const result = await replayBridge.navigate(nodeIdForScene(targetSceneId));
            if (result.ended) replayBridge.complete?.();
            return result.advanced;
          } catch (error) {
            console.error('[LiveCourse] Failed to navigate replay', error);
            setPlaybackError('Failed to navigate replay');
            playbackRetryRequiredRef.current = true;
            return false;
          }
        }
        if (presentationOnly) return false;
        if (presentationOnly || !emitLiveCourseAction || targetSceneId === PENDING_SCENE_ID) {
          if (presentationOnly) {
            playbackStore.setState({ currentSceneId: targetSceneId });
          } else {
            setCurrentSceneId(targetSceneId);
          }
          return true;
        }

        try {
          const targetNodeId = nodeIdForScene(targetSceneId);
          await emitLiveCourseAction({
            type: 'lesson.goto_node',
            nodeId: targetNodeId,
            payload: { targetNodeId },
          });
          return true;
        } catch (error) {
          console.error('[LiveCourse] Failed to switch classroom scene', error);
          return false;
        }
      },
      [
        clearAutoAdvanceTimer,
        emitLiveCourseAction,
        playbackStore,
        presentationOnly,
        setCurrentSceneId,
        replayBridge,
      ],
    );

    useEffect(() => {
      if (!currentScene) return;
      emitLiveCourseActionSafely({
        type: 'avatar.look_at',
        payload: { target: currentScene.type === 'slide' ? 'slides' : 'student' },
      });
    }, [currentScene, emitLiveCourseActionSafely]);

    // Layout state from settings store (persisted via localStorage)
    const sidebarCollapsed = useSettingsStore((s) => s.sidebarCollapsed);
    const setSidebarCollapsed = useSettingsStore((s) => s.setSidebarCollapsed);
    const isMobileLayout = useSyncExternalStore(
      subscribeMobileLayout,
      getMobileLayoutSnapshot,
      () => false,
    );
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
    const effectiveSidebarCollapsed = isMobileLayout ? !mobileSidebarOpen : sidebarCollapsed;
    const setSidebarOpen = useCallback(
      (open: boolean) => {
        if (isMobileLayout) {
          setMobileSidebarOpen(open);
          return;
        }
        setSidebarCollapsed(!open);
      },
      [isMobileLayout, setSidebarCollapsed],
    );
    const toggleSidebar = useCallback(() => {
      setSidebarOpen(effectiveSidebarCollapsed);
    }, [effectiveSidebarCollapsed, setSidebarOpen]);
    const chatAreaWidth = useSettingsStore((s) => s.chatAreaWidth);
    const setChatAreaWidth = useSettingsStore((s) => s.setChatAreaWidth);
    const chatAreaCollapsed = useSettingsStore((s) => s.chatAreaCollapsed);
    const setChatAreaCollapsed = useSettingsStore((s) => s.setChatAreaCollapsed);
    const [isLiveCourseRecordOpen, setIsLiveCourseRecordOpen] = useState(false);
    const setTTSMuted = useSettingsStore((s) => s.setTTSMuted);
    const setTTSVolume = useSettingsStore((s) => s.setTTSVolume);

    // PlaybackEngine state
    const [engineMode, setEngineMode] = useState<EngineMode>('idle');
    const [playbackCompleted, setPlaybackCompleted] = useState(false); // Distinguishes "never played" idle from "finished" idle
    const [playbackError, setPlaybackError] = useState<string | null>(null);
    const [classroomControlError, setClassroomControlError] = useState<string | null>(null);
    const [lectureSpeech, setLectureSpeech] = useState<string | null>(null); // From PlaybackEngine (lecture)
    const [currentPlaybackActionIndex, setCurrentPlaybackActionIndex] = useState<number | null>(0);
    const [liveSpeech, setLiveSpeech] = useState<string | null>(null); // From buffer (discussion/QA)
    const [speechProgress, setSpeechProgress] = useState<number | null>(null); // StreamBuffer reveal progress (0–1)
    const [discussionTrigger, setDiscussionTrigger] = useState<TriggerEvent | null>(null);

    // Speaking agent tracking (Issue 2)
    const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);

    // Thinking state (Issue 5)
    const [thinkingState, setThinkingState] = useState<{
      stage: string;
      agentId?: string;
    } | null>(null);

    // Cue user state (Issue 7)
    const [isCueUser, setIsCueUser] = useState(false);

    // End flash state (Issue 3)
    const [showEndFlash, setShowEndFlash] = useState(false);
    const [endFlashSessionType, setEndFlashSessionType] = useState<'qa' | 'discussion'>(
      'discussion',
    );

    // Streaming state for stop button (Issue 1)
    const [chatIsStreaming, setChatIsStreaming] = useState(false);
    const [chatIsSoftClosing, setChatIsSoftClosing] = useState(false);
    const [softCloseDeadline, setSoftCloseDeadline] = useState<number | undefined>();
    const [chatSessionType, setChatSessionType] = useState<string | null>(null);

    // Topic pending state: session is soft-paused, bubble stays visible, waiting for user input
    const [isTopicPending, setIsTopicPending] = useState(false);

    // Active bubble ID for playback highlight in chat area (Issue 8)
    const [activeBubbleId, setActiveBubbleId] = useState<string | null>(null);

    // Scene switch confirmation dialog state
    const [pendingSceneId, setPendingSceneId] = useState<string | null>(null);
    const sceneSwitchRequestRef = useRef(0);
    const sceneSwitchConfirmingRef = useRef(false);
    const [isPresenting, setIsPresenting] = useState(false);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [isPresentationInteractionActive, setIsPresentationInteractionActive] = useState(false);

    // Whiteboard state (from canvas store so AI tools can open it)
    const whiteboardOpen = useCanvasStore.use.whiteboardOpen();
    const setWhiteboardOpen = useCanvasStore.use.setWhiteboardOpen();

    // Selected agents from settings store (Zustand)
    const selectedAgentIds = useSettingsStore((s) => s.selectedAgentIds);
    const ttsMuted = useSettingsStore((s) => s.ttsMuted);
    const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);

    // Generate participants from selected agents
    const participants = useMemo(
      () => agentsToParticipants(selectedAgentIds, t),
      [selectedAgentIds, t],
    );

    // Resolved AgentConfig array for hooks that need full agent objects
    // Subscribe to the agents record so voiceConfig changes trigger re-resolution
    const agentsRecord = useAgentRegistry((s) => s.agents);
    const selectedAgents = useMemo(
      () =>
        selectedAgentIds.map((id) => agentsRecord[id]).filter((a): a is AgentConfig => a != null),
      [agentsRecord, selectedAgentIds],
    );

    // Discussion TTS: audio indicator state
    const [audioIndicatorState, setAudioIndicatorState] = useState<AudioIndicatorState>('idle');
    const [audioAgentId, setAudioAgentId] = useState<string | null>(null);

    const discussionTTS = useDiscussionTTS({
      enabled: isLiveCourseTTSEnabled() && ttsEnabled && !ttsMuted,
      agents: selectedAgents,
      onAudioStateChange: (agentId, state) => {
        setAudioAgentId(agentId);
        setAudioIndicatorState(state);
      },
    });

    // Pick a student agent for discussion trigger (prioritize student > non-teacher > fallback)
    const pickStudentAgent = useCallback((): string => {
      const registry = useAgentRegistry.getState();
      const agents = selectedAgentIds
        .map((id) => registry.getAgent(id))
        .filter((a): a is AgentConfig => a != null);
      const students = agents.filter((a) => a.role === 'student');
      if (students.length > 0) {
        return students[Math.floor(Math.random() * students.length)].id;
      }
      const nonTeachers = agents.filter((a) => a.role !== 'teacher');
      if (nonTeachers.length > 0) {
        return nonTeachers[Math.floor(Math.random() * nonTeachers.length)].id;
      }
      return agents[0]?.id || 'default-1';
    }, [selectedAgentIds]);

    const engineRef = useRef<PlaybackEngine | null>(null);
    const teachingControlGenerationRef = useRef(0);
    const pendingTeachingControlRef = useRef<PendingTeachingControl | null>(null);
    const pendingTeachingRetryRef = useRef<PendingTeachingRetry | null>(null);
    const teachingControlPromiseRef = useRef<Promise<void> | null>(null);
    const teachingRetryPromiseRef = useRef<Promise<void> | null>(null);
    /** Node whose local lecture engine is frozen for a Realtime interruption. */
    const realtimeFrozenNodeRef = useRef<string | null>(null);
    const audioPlayerRef = useRef(createAudioPlayer());
    const chatAreaRef = useRef<ChatAreaRef>(null);
    const lectureSessionIdRef = useRef<string | null>(null);
    const lectureActionCounterRef = useRef(0);
    const playbackAttemptRef = useRef<PlaybackAttempt | null>(null);
    const currentPlaybackActionIndexRef = useRef<number | null>(currentPlaybackActionIndex);
    const activeSceneIdRef = useRef<string | null>(currentSceneId);
    const discussionAbortRef = useRef<AbortController | null>(null);
    const presentationIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cursorSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingCursorRef = useRef<{ stageId: string; cursor: PlaybackCursor } | null>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const mountedRef = useRef(false);
    // Monotonic counter incremented on each scene switch.  It is part of every
    // speech/effect boundary so late callbacks cannot cross scene boundaries.
    const sceneEpochRef = useRef(0);
    const playbackRetryRequiredRef = useRef(false);
    // A replay Host can request the first start before the scene-specific
    // engine has finished mounting. Keep the target node so a stale request
    // cannot auto-start a later manually selected scene.
    const replayStartTargetRef = useRef<string | null>(null);
    const replayStartPausedRef = useRef(false);
    const replayStartRequestGenerationRef = useRef<number | null>(null);
    // Guard to prevent double flash when manual stop triggers onDiscussionEnd
    const manualStopRef = useRef(false);

    const updateCurrentPlaybackActionIndex = useCallback((actionIndex: number | null) => {
      currentPlaybackActionIndexRef.current = actionIndex;
      setCurrentPlaybackActionIndex(actionIndex);
    }, []);

    const persistCursorSafely = useCallback(
      ({ stageId, cursor }: { stageId: string; cursor: PlaybackCursor }) => {
        if (presentationOnly) return;
        void saveCursor(stageId, cursor).catch((error) => {
          console.warn(`Failed to save playback cursor for stage ${stageId}:`, error);
        });
      },
      [presentationOnly],
    );

    const scheduleCursorSave = useCallback(
      (stageId: string, cursor: PlaybackCursor) => {
        if (presentationOnly) return;
        pendingCursorRef.current = { stageId, cursor };
        if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current);
        cursorSaveTimerRef.current = setTimeout(() => {
          cursorSaveTimerRef.current = null;
          const pending = pendingCursorRef.current;
          pendingCursorRef.current = null;
          if (pending) persistCursorSafely(pending);
        }, 1000);
      },
      [persistCursorSafely, presentationOnly],
    );

    const actionResumeStorageKey = useMemo(
      () => getActionResumeStorageKey(stage?.id ?? currentScene?.stageId),
      [currentScene?.stageId, stage?.id],
    );

    const saveSceneResumePosition = useCallback(
      (sceneId: string | null | undefined, actionIndex: number | null | undefined) => {
        if (presentationOnly || !sceneId || typeof window === 'undefined') return;
        const scene = scenes.find((s) => s.id === sceneId);
        const actions = scene?.actions ?? [];
        if (!scene || actions.length === 0) return;

        if (Number.isInteger(actionIndex) && actionIndex! >= actions.length) {
          clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          return;
        }

        const action = Number.isInteger(actionIndex) ? actions[actionIndex!] : null;
        if (action && action.type !== 'speech') {
          const crossedUnsafe = actions
            .slice(0, actionIndex! + 1)
            .some(isUnsafePlaybackNavigationAction);
          if (crossedUnsafe) {
            clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          }
          return;
        }

        const position = createActionResumePosition(actions, actionIndex);
        if (!position) return;
        if (!canJumpWithinReconstructablePrefix(actions, 0, position.actionIndex)) {
          clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
          return;
        }
        saveActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId, position);
      },
      [actionResumeStorageKey, presentationOnly, scenes],
    );

    const clearSceneResumePosition = useCallback(
      (sceneId: string | null | undefined) => {
        if (presentationOnly || !sceneId || typeof window === 'undefined') return;
        clearActionResumePosition(window.sessionStorage, actionResumeStorageKey, sceneId);
      },
      [actionResumeStorageKey, presentationOnly],
    );

    const resetPlaybackAttempt = useCallback(() => {
      // A retry, scene switch, or session transition invalidates any delayed
      // auto-advance created by the previous attempt.
      clearAutoAdvanceTimer();
      const attempt = playbackAttemptRef.current;
      if (attempt) {
        // Keep the callback-owned attempt object so a retry can use the same
        // engine. Every boundary captures the old generation and is rejected
        // by isCurrentTeachingContext after this increment.
        attempt.runGeneration += 1;
        attempt.speechGeneration = 0;
        attempt.speechCycles = [];
        attempt.activeSpeech = null;
        attempt.effectActionIds = [];
        attempt.effectActionPromises = [];
        attempt.failure = null;
        attempt.completionGuard = false;
        const identity = readPlaybackSessionIdentity(liveCourseSessionRef.current);
        attempt.teachingSessionEpoch = identity ? sessionEpochRef.current : null;
        attempt.teachingSessionIdentity = identity;
        attempt.expectsTeachingSession =
          !presentationOnly &&
          liveCourseSessionRef.current !== null &&
          (!relistenRef.current || relistenRestoreRef.current?.sceneId === attempt.context.sceneId);
        attempt.context = {
          ...attempt.context,
          runGeneration: attempt.runGeneration,
          sessionEpoch: sessionEpochRef.current,
          sessionIdentity: identity,
        };
      }
      playbackRetryRequiredRef.current = false;
      setPlaybackError(null);
    }, [clearAutoAdvanceTimer, presentationOnly]);

    const installPlaybackAttempt = useCallback(
      (engine: PlaybackEngine, sceneId: string): PlaybackAttempt => {
        const session = liveCourseSessionRef.current;
        const attempt = createPlaybackAttempt({
          sceneId,
          nodeId: nodeIdForScene(sceneId),
          epoch: sceneEpochRef.current,
          sessionEpoch: sessionEpochRef.current,
          sessionIdentity: readPlaybackSessionIdentity(session),
          engine,
          expectsTeachingSession:
            !presentationOnly &&
            session !== null &&
            (!relistenRef.current || relistenRestoreRef.current?.sceneId === sceneId),
        });
        playbackAttemptRef.current = attempt;
        playbackRetryRequiredRef.current = false;
        setPlaybackError(null);
        return attempt;
      },
      [presentationOnly],
    );

    const isCurrentEngineEpoch = useCallback((context: PlaybackBoundaryContext): boolean => {
      return Boolean(
        mountedRef.current &&
        engineRef.current === context.engine &&
        sceneEpochRef.current === context.epoch,
      );
    }, []);

    const isCurrentTeachingContext = useCallback(
      (context: PlaybackBoundaryContext): boolean => {
        const attempt = playbackAttemptRef.current;
        if (
          !isCurrentEngineEpoch(context) ||
          !attempt ||
          attempt.context.engine !== context.engine ||
          attempt.context.sceneId !== context.sceneId ||
          attempt.context.epoch !== context.epoch ||
          attempt.context.nodeId !== context.nodeId ||
          attempt.runGeneration !== context.runGeneration ||
          sessionEpochRef.current !== context.sessionEpoch ||
          !context.sessionIdentity
        ) {
          return false;
        }
        return samePlaybackSessionIdentity(
          readPlaybackSessionIdentity(liveCourseSessionRef.current),
          context.sessionIdentity,
        );
      },
      [isCurrentEngineEpoch],
    );

    const markPlaybackAttemptFailure = useCallback(
      (
        attempt: PlaybackAttempt,
        cause: unknown,
        fallback: string,
        boundaryContext?: PlaybackBoundaryContext,
      ): Error | null => {
        const error = toPlaybackError(cause, fallback);
        // A late rejection from a superseded engine must not surface as a
        // failure for the newly installed scene/attempt.
        if (
          playbackAttemptRef.current !== attempt ||
          !isCurrentEngineEpoch(attempt.context) ||
          (boundaryContext !== undefined &&
            (boundaryContext.engine !== attempt.context.engine ||
              boundaryContext.sceneId !== attempt.context.sceneId ||
              boundaryContext.epoch !== attempt.context.epoch ||
              boundaryContext.nodeId !== attempt.context.nodeId ||
              attempt.runGeneration !== boundaryContext.runGeneration ||
              sessionEpochRef.current !== boundaryContext.sessionEpoch ||
              (boundaryContext.sessionIdentity
                ? !samePlaybackSessionIdentity(
                    readPlaybackSessionIdentity(liveCourseSessionRef.current),
                    boundaryContext.sessionIdentity,
                  )
                : readPlaybackSessionIdentity(liveCourseSessionRef.current) !== null)))
        ) {
          return null;
        }
        attempt.failure = error;
        playbackRetryRequiredRef.current = true;
        setPlaybackError(error.message);
        return error;
      },
      [isCurrentEngineEpoch],
    );

    // A status/identity transition invalidates every in-flight teaching
    // boundary. Stop the engine first so callbacks that are already queued by
    // its audio/timer generation cannot be attached to the new session.
    useEffect(() => {
      const attempt = playbackAttemptRef.current;
      const hadInFlightWork = Boolean(
        attempt && (attempt.speechCycles.length > 0 || engineRef.current?.getMode() !== 'idle'),
      );
      if (hadInFlightWork) {
        engineRef.current?.stop();
      }
      resetPlaybackAttempt();
      if (hadInFlightWork && !presentationOnly) {
        playbackRetryRequiredRef.current = true;
        setPlaybackError('Classroom session changed before playback completed; please retry.');
      }
    }, [presentationOnly, resetPlaybackAttempt, sessionIdentityKey]);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        sessionEpochRef.current += 1;
        liveCourseSessionRef.current = null;
        resetPlaybackAttempt();
      };
    }, [resetPlaybackAttempt]);

    // When true, the next engine init will auto-start playback (for auto-play
    // scene advance or an explicit replay start request).
    const autoStartRef = useRef(false);
    const pendingAdvanceRef = useRef<{
      nodeId: string;
      targetNodeId: string;
      idempotencyKey: string;
      epoch: number;
      confirmed: boolean;
    } | null>(null);
    const advancePromiseRef = useRef<Promise<void> | null>(null);

    const advanceTeachingNode = useCallback(
      (nodeId: string): Promise<void> => {
        if (advancePromiseRef.current) return advancePromiseRef.current;
        const session = liveCourseSessionRef.current;
        if (!session?.lessonPlan || session.status !== 'ready') {
          return Promise.reject(new Error('Classroom is not ready to continue'));
        }
        const next = nextTeachingNode(session.lessonPlan, nodeId);
        if (!next) return Promise.resolve();
        if (session.currentNodeId !== nodeId && session.currentNodeId !== next.id) {
          return Promise.reject(new Error('Teaching position changed before advancing'));
        }
        const previous = pendingAdvanceRef.current;
        const pending =
          previous?.nodeId === nodeId && previous.epoch === sessionEpochRef.current
            ? previous
            : {
                nodeId,
                targetNodeId: next.id,
                idempotencyKey: `teaching:advance:${createBrowserUuid()}`,
                epoch: sessionEpochRef.current,
                confirmed: false,
              };
        pendingAdvanceRef.current = pending;
        clearAutoAdvanceTimer();
        const promise = (async () => {
          autoStartRef.current = true;
          try {
            await session.emitAction({
              type: 'lesson.goto_node',
              nodeId: pending.targetNodeId,
              idempotencyKey: pending.idempotencyKey,
              payload: { targetNodeId: pending.targetNodeId },
            });
            if (sessionEpochRef.current !== pending.epoch)
              throw new Error('Classroom changed while advancing');
            pending.confirmed = true;
            if (activeSceneIdRef.current === next.sceneId && engineRef.current) {
              autoStartRef.current = false;
              const engine = engineRef.current;
              const lecture = await chatAreaRef.current?.startLecture(next.sceneId);
              if (engineRef.current !== engine) throw new Error('Next teaching scene changed');
              if (!lecture) throw new Error('Next lecture session is not ready');
              lectureSessionIdRef.current = lecture;
              resetPlaybackAttempt();
              engine.start();
            }
            pendingAdvanceRef.current = null;
            setPlaybackError(null);
          } catch (cause) {
            autoStartRef.current = false;
            if (sessionEpochRef.current === pending.epoch) {
              engineRef.current?.stop();
              setPlaybackError(
                toPlaybackError(cause, 'Could not enter the next teaching node').message,
              );
            }
            throw cause;
          }
        })();
        advancePromiseRef.current = promise;
        const release = () => {
          if (advancePromiseRef.current === promise) advancePromiseRef.current = null;
        };
        void promise.then(release, release);
        return promise;
      },
      [clearAutoAdvanceTimer, resetPlaybackAttempt],
    );

    const playCheckpointFeedback = useCallback(
      (input: CheckpointFeedbackInput): Promise<void> =>
        feedbackSubmissionsRef.current(input.attemptId, async () => {
          const session = liveCourseSessionRef.current;
          const scene = playbackStore.getState().scenes.find((item) => item.id === input.sceneId);
          if (!scene || session?.currentNodeId !== input.nodeId) {
            throw new Error('Checkpoint changed before teacher feedback');
          }
          await connectTeacher();
          if (liveCourseSessionRef.current?.currentNodeId !== input.nodeId) {
            throw new Error('Checkpoint changed while connecting the teacher');
          }
          const goalId = session.lessonPlan?.nodes.find((node) => node.id === input.nodeId)
            ?.goalIds[0];
          const passScore =
            session.lessonPlan?.goals.find((goal) => goal.id === goalId)?.rule.passScore ?? 0.7;
          const text = checkpointFeedbackText({
            result: input,
            scene,
            language: locale,
            passScore,
          });
          clearAutoAdvanceTimer();
          engineRef.current?.stop();
          const lifetime = new AbortController();
          feedbackAbortRef.current?.abort();
          feedbackAbortRef.current = lifetime;
          setCheckpointFeedbackBusy(true);
          try {
            await new Promise<void>((resolve, reject) => {
              const feedbackEngine = new PlaybackEngine(
                [
                  {
                    ...scene,
                    actions: [{ id: `feedback:${input.attemptId}`, type: 'speech', text }],
                  },
                ],
                new ActionEngine(playbackStore, audioPlayerRef.current),
                audioPlayerRef.current,
                {
                  speak: speakClassroomText,
                  onModeChange: (nextMode) => {
                    if (mountedRef.current && engineRef.current === feedbackEngine)
                      setEngineMode(nextMode);
                  },
                  onComplete: () => resolve(),
                  onError: reject,
                },
              );
              lifetime.signal.addEventListener(
                'abort',
                () => {
                  feedbackEngine.stop();
                  reject(new Error('Checkpoint feedback was cancelled'));
                },
                { once: true },
              );
              engineRef.current = feedbackEngine;
              feedbackEngine.start();
            });
          } finally {
            if (feedbackAbortRef.current === lifetime) {
              feedbackAbortRef.current = null;
              if (mountedRef.current) setCheckpointFeedbackBusy(false);
            }
          }
        }),
      [clearAutoAdvanceTimer, connectTeacher, locale, playbackStore, speakClassroomText],
    );
    const registerCheckpointTeacher = liveCourseSession?.registerCheckpointTeacher;
    useEffect(() => {
      if (!registerCheckpointTeacher || presentationOnly) return;
      return registerCheckpointTeacher({
        feedback: playCheckpointFeedback,
        continueLesson: advanceTeachingNode,
      });
    }, [advanceTeachingNode, playCheckpointFeedback, presentationOnly, registerCheckpointTeacher]);

    /**
     * Start one replay scene after its engine is ready. The replay Host may
     * issue this command in the same commit as controller.start/advance, when
     * the scene effect has not installed `engineRef` yet; the target ref lets
     * that request be consumed by exactly the intended scene.
     */
    const startEnginePlayback = useCallback(
      async (
        engine: PlaybackEngine,
        scene: NonNullable<typeof currentScene>,
        options: { restart: boolean; paused?: boolean },
      ): Promise<void> => {
        if (engineRef.current !== engine) {
          throw new Error('Replay playback engine is no longer current');
        }
        if (options.restart) {
          setPlaybackCompleted(false);
          resetPlaybackAttempt();
          lectureActionCounterRef.current = 0;
        }

        let sessionId: string | null = null;
        try {
          if (chatAreaRef.current) {
            sessionId = await chatAreaRef.current.startLecture(scene.id);
            if (engineRef.current !== engine) {
              await chatAreaRef.current.endSession(sessionId);
              throw new Error('Replay playback scene changed while starting audio');
            }
            lectureSessionIdRef.current = sessionId;
          }
          if (engineRef.current !== engine) {
            throw new Error('Replay playback scene changed before engine start');
          }
          if (options.restart) engine.start();
          else engine.continuePlayback();
          // A manual navigation made while replay was paused still needs the
          // new scene's engine to be in the paused state. `start()` is
          // synchronous up to the first scheduled action, so pausing here
          // prevents the target from running ahead before the UI renders.
          if (options.paused && engine.getMode() === 'playing') engine.pause();
        } catch (error) {
          // A failed start must not leave a lecture ChatArea session detached
          // from the engine. Completion may already have ended it, in which
          // case the ref no longer points at this session and no cleanup is
          // attempted twice.
          if (sessionId && lectureSessionIdRef.current === sessionId) {
            lectureSessionIdRef.current = null;
            await chatAreaRef.current?.endSession(sessionId);
          }
          throw error;
        }
      },
      [resetPlaybackAttempt],
    );

    const startReplayEngine = useCallback(
      async (
        targetNodeId?: string,
        options: { paused?: boolean; requestGeneration?: number } = {},
      ): Promise<void> => {
        if (!presentationOnly) {
          throw new Error('Replay playback controls are unavailable in teaching mode');
        }
        const latestStage = useStageStore.getState();
        const latestScene =
          latestStage.scenes.find((scene) => scene.id === latestStage.currentSceneId) ??
          (targetNodeId ? undefined : currentScene);
        const requestedNodeId =
          targetNodeId ?? (latestScene ? nodeIdForScene(latestScene.id) : null);
        if (!requestedNodeId) throw new Error('Replay scene is not ready');
        replayStartTargetRef.current = requestedNodeId;
        replayStartPausedRef.current = options.paused === true;
        replayStartRequestGenerationRef.current = options.requestGeneration ?? null;
        autoStartRef.current = true;

        const engine = engineRef.current;
        const scene = latestScene;
        if (
          !scene ||
          nodeIdForScene(scene.id) !== requestedNodeId ||
          !engine ||
          engine.getCurrentSceneId() !== scene.id
        ) {
          // The scene effect will consume this request immediately after it
          // installs the new engine.
          return;
        }
        if (engine.getMode() === 'playing') {
          autoStartRef.current = false;
          replayStartTargetRef.current = null;
          replayStartPausedRef.current = false;
          replayStartRequestGenerationRef.current = null;
          if (options.requestGeneration !== undefined) {
            replayBridge?.reportPlaybackStarted?.(options.requestGeneration);
          }
          return;
        }
        if (engine.getMode() !== 'idle') {
          throw new Error(`Cannot start replay while engine is ${engine.getMode()}`);
        }

        autoStartRef.current = false;
        replayStartTargetRef.current = null;
        const paused = replayStartPausedRef.current;
        replayStartPausedRef.current = false;
        const requestGeneration = replayStartRequestGenerationRef.current;
        replayStartRequestGenerationRef.current = null;
        await startEnginePlayback(engine, scene, { restart: true, paused });
        if (requestGeneration !== null) {
          replayBridge?.reportPlaybackStarted?.(requestGeneration);
        }
      },
      [currentScene, presentationOnly, replayBridge, startEnginePlayback],
    );

    const pauseReplayEngine = useCallback(() => {
      if (!presentationOnly) {
        throw new Error('Replay playback controls are unavailable in teaching mode');
      }
      const engine = engineRef.current;
      if (!engine || engine.getMode() !== 'playing') {
        throw new Error('Replay engine is not playing');
      }
      saveSceneResumePosition(currentScene?.id, currentPlaybackActionIndexRef.current);
      engine.pause();
      try {
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.pauseBuffer(lectureSessionIdRef.current);
        }
        if (engineRef.current !== engine || engine.getMode() !== 'paused') {
          throw new Error('Replay engine did not enter paused state');
        }
      } catch (error) {
        // Keep the local engine aligned when a paired buffer operation fails.
        if (engineRef.current === engine && engine.getMode() === 'paused') {
          engine.resume();
        }
        throw error;
      }
    }, [currentScene?.id, presentationOnly, saveSceneResumePosition]);

    const resumeReplayEngine = useCallback(() => {
      if (!presentationOnly) {
        throw new Error('Replay playback controls are unavailable in teaching mode');
      }
      const engine = engineRef.current;
      if (!engine || engine.getMode() !== 'paused') {
        throw new Error('Replay engine is not paused');
      }
      engine.resume();
      try {
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.resumeBuffer(lectureSessionIdRef.current);
        }
        if (engineRef.current !== engine || engine.getMode() !== 'playing') {
          throw new Error('Replay engine did not resume playing');
        }
      } catch (error) {
        // `resume()` is synchronous, but an attached buffer can still reject
        // the paired transition. Restore the paused engine before surfacing it.
        if (engineRef.current === engine && engine.getMode() === 'playing') {
          engine.pause();
        }
        throw error;
      }
    }, [presentationOnly]);

    const retryReplayEngine = useCallback(async () => {
      if (!presentationOnly) {
        throw new Error('Replay playback controls are unavailable in teaching mode');
      }
      const engine = engineRef.current;
      const scene = currentScene;
      if (!engine || !scene || engine.getCurrentSceneId() !== scene.id) {
        throw new Error('Replay scene is not ready to retry');
      }

      const mode = engine.getMode();
      if (mode === 'idle') {
        try {
          await startEnginePlayback(engine, scene, { restart: true });
        } catch (error) {
          // Leave the local side in a known idle state so the controller's
          // compensating notifyPlaybackFailure remains truthful.
          if (engineRef.current === engine && engine.getMode() !== 'idle') {
            engine.stop();
          }
          throw error;
        }
        return;
      }

      if (mode === 'paused') {
        resetPlaybackAttempt();
        setPlaybackCompleted(false);
        resumeReplayEngine();
        return;
      }

      if (mode === 'playing') {
        // A navigation failure may leave local playback running while the
        // controller is marked failed. It is already at the retained node;
        // reset only the attempt metadata and keep the running engine.
        resetPlaybackAttempt();
        setPlaybackCompleted(false);
        return;
      }

      throw new Error(`Cannot retry replay while engine is ${mode}`);
    }, [
      currentScene,
      presentationOnly,
      resetPlaybackAttempt,
      resumeReplayEngine,
      startEnginePlayback,
    ]);

    const stopReplayEngine = useCallback(async () => {
      replayStartTargetRef.current = null;
      replayStartPausedRef.current = false;
      replayStartRequestGenerationRef.current = null;
      autoStartRef.current = false;
      const engine = engineRef.current;
      engine?.stop();
      const sessionId = lectureSessionIdRef.current;
      lectureSessionIdRef.current = null;
      if (sessionId) await chatAreaRef.current?.endSession(sessionId);
    }, []);

    // The replay Host owns controller/W commands; this root only publishes
    // the local engine port. Identity-guarded cleanup prevents a StrictMode
    // synthetic cleanup from deleting a replacement port.
    useEffect(() => {
      if (!presentationOnly || !replayBridge) return;
      const engineControls = {
        start: startReplayEngine,
        pause: pauseReplayEngine,
        resume: resumeReplayEngine,
        retry: retryReplayEngine,
        stop: stopReplayEngine,
      };
      if (replayBridge.registerEngineControls) {
        replayBridge.registerEngineControls(engineControls);
      } else {
        replayBridge.engineControls = engineControls;
      }
      return () => {
        if (replayBridge.unregisterEngineControls) {
          replayBridge.unregisterEngineControls(engineControls);
        } else if (replayBridge.engineControls === engineControls) {
          delete replayBridge.engineControls;
        }
      };
    }, [
      pauseReplayEngine,
      presentationOnly,
      replayBridge,
      resumeReplayEngine,
      retryReplayEngine,
      startReplayEngine,
      stopReplayEngine,
    ]);

    // Discussion buffer-level pause state (distinct from soft-pause which aborts SSE)
    const [isDiscussionPaused, setIsDiscussionPaused] = useState(false);

    /**
     * Resume a soft-paused topic: re-call /chat with existing session messages.
     * The director picks the next agent to continue.
     */
    const doResumeTopic = useCallback(async () => {
      // Clear old bubble immediately — no lingering on interrupted text
      setIsTopicPending(false);
      setLiveSpeech(null);
      setSpeakingAgentId(null);
      setThinkingState({ stage: 'director' });
      setChatIsStreaming(true);
      // Transition engine back to live — onInputActivate paused it when soft-pausing,
      // so we must explicitly resume to keep engine mode in sync with the chat loop.
      engineRef.current?.resume();
      // Fire new chat round — SSE events will drive thinking → agent_start → speech
      await chatAreaRef.current?.resumeActiveSession();
    }, []);

    /** Reset all live/discussion state (shared by doSessionCleanup & onDiscussionEnd) */
    const resetLiveState = useCallback(() => {
      setLiveSpeech(null);
      setSpeakingAgentId(null);
      setSpeechProgress(null);
      setThinkingState(null);
      setIsCueUser(false);
      setIsTopicPending(false);
      setChatIsStreaming(false);
      setChatIsSoftClosing(false);
      setChatSessionType(null);
      setIsDiscussionPaused(false);
    }, []);

    /** Full scene reset (scene switch) — resetLiveState + lecture/visual state */
    const resetSceneState = useCallback(
      (initial?: { actionIndex?: number | null; lectureSpeech?: string | null }) => {
        resetLiveState();
        setPlaybackCompleted(false);
        setLectureSpeech(initial?.lectureSpeech ?? null);
        updateCurrentPlaybackActionIndex(initial?.actionIndex ?? 0);
        setSpeechProgress(null);
        setShowEndFlash(false);
        setActiveBubbleId(null);
        setDiscussionTrigger(null);
      },
      [resetLiveState, updateCurrentPlaybackActionIndex],
    );

    /** Request failure should exit live discussion UI without hard-closing the session. */
    const handleLiveSessionError = useCallback(() => {
      engineRef.current?.handleDiscussionError();
      resetLiveState();
      setActiveBubbleId(null);
    }, [resetLiveState]);

    /**
     * Unified session cleanup — called by both roundtable stop button and chat area end button.
     * Handles: engine transition, flash, roundtable state clearing.
     */
    const doSessionCleanup = useCallback(() => {
      const activeType = chatSessionType;

      // Engine cleanup — guard to avoid double flash from onDiscussionEnd
      manualStopRef.current = true;
      engineRef.current?.handleEndDiscussion();
      manualStopRef.current = false;

      // Show end flash with correct session type
      if (activeType === 'qa' || activeType === 'discussion') {
        setEndFlashSessionType(activeType);
        setShowEndFlash(true);
        setTimeout(() => setShowEndFlash(false), 1800);
      }

      // Stop any in-flight discussion TTS audio
      discussionTTS.cleanup();

      resetLiveState();
    }, [chatSessionType, resetLiveState, discussionTTS]);

    // Shared stop-discussion handler (used by both Roundtable and Canvas toolbar)
    const handleStopDiscussion = useCallback(async () => {
      await chatAreaRef.current?.stopActiveSession();
    }, []);

    const handleContinueDiscussion = useCallback(() => {
      if (chatAreaRef.current?.continueActiveSoftClosingSession()) {
        setChatIsSoftClosing(false);
        setSoftCloseDeadline(undefined);
      }
    }, []);

    /**
     * Session-stop callback from the chat layer. Runs the normal cleanup, then —
     * only when a confirmed or timed-out soft close ended a Q&A that had
     * interrupted an active lecture — auto-resumes from the saved position.
     *
     * hadLectureInterruption MUST be read before doSessionCleanup(), because
     * handleEndDiscussion() restores and clears the saved lecture position.
     */
    const handleSessionStop = useCallback(
      async (payload: SessionCleanupPayload) => {
        const engine = engineRef.current;
        const hadLectureInterruption = engine?.hasLectureInterruption() ?? false;

        doSessionCleanup();

        if (!engine) return;
        const eligible = shouldAutoResumeLecture({
          source: payload.source,
          endReason: payload.endReason,
          hadLectureInterruption,
          engineMode: engine.getMode(),
          isExhausted: engine.isExhausted(),
          playbackCompleted,
        });
        if (!eligible) return;

        // Use the restored engine position, not the stale React currentScene.
        const sceneId = engine.getCurrentSceneId();
        if (!sceneId || !chatAreaRef.current) return;

        // startLecture is async — re-check the engine is still idle AND still
        // the installed engine afterwards. A scene switch during the await
        // stops the captured engine (leaving it idle, so the mode check alone
        // passes) and installs a new one; resuming the orphan would emit
        // progress snapshots for the old scene over the new scene's cursor.
        const sessionId = await chatAreaRef.current.startLecture(sceneId);
        if (engineRef.current !== engine) {
          await chatAreaRef.current.endSession(sessionId);
          return;
        }
        if (engine.getMode() !== 'idle') {
          // The engine left idle during the async startLecture (e.g. a new live
          // session began) — tear down the lecture session we just
          // created/reactivated so it doesn't linger without playing.
          await chatAreaRef.current.endSession(sessionId);
          return;
        }
        lectureSessionIdRef.current = sessionId;
        engine.continuePlayback();
      },
      [doSessionCleanup, playbackCompleted],
    );

    // Imperative teardown so the parent can `await` SSE / engine / TTS
    // shutdown before flipping mode to 'edit'. Mirrors what the old in-
    // component `handleToggleEditMode` did, but exposed through ref so
    // the toggle lives one layer up.
    useImperativeHandle(
      ref,
      () => ({
        teardown: async () => {
          clearAutoAdvanceTimer();
          await chatAreaRef.current?.endActiveSession();
          if (discussionAbortRef.current) {
            discussionAbortRef.current.abort();
            discussionAbortRef.current = null;
          }
          engineRef.current?.stop();
          discussionTTS.cleanup();
          resetSceneState();
        },
      }),
      [clearAutoAdvanceTimer, discussionTTS, resetSceneState],
    );

    const clearPresentationIdleTimer = useCallback(() => {
      if (presentationIdleTimerRef.current) {
        clearTimeout(presentationIdleTimerRef.current);
        presentationIdleTimerRef.current = null;
      }
    }, []);

    const resetPresentationIdleTimer = useCallback(() => {
      setControlsVisible(true);
      clearPresentationIdleTimer();
      if (isPresenting && !isPresentationInteractionActive) {
        presentationIdleTimerRef.current = setTimeout(() => {
          setControlsVisible(false);
        }, 3000);
      }
    }, [clearPresentationIdleTimer, isPresenting, isPresentationInteractionActive]);

    const togglePresentation = useCallback(async () => {
      const stageElement = stageRef.current;
      if (!stageElement) return;

      try {
        if (document.fullscreenElement === stageElement) {
          // Unlock Escape key before exiting fullscreen
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigator as any).keyboard?.unlock?.();
          await document.exitFullscreen();
          return;
        }

        setControlsVisible(true);
        await stageElement.requestFullscreen();
        // Lock Escape key so it doesn't auto-exit fullscreen (#255)
        // Escape is handled manually in our keydown handler instead
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (navigator as any).keyboard?.lock?.(['Escape']).catch(() => {});
        setSidebarOpen(false);
        setChatAreaCollapsed(true);
      } catch {
        // Firefox may deny fullscreen from certain keyboard events (e.g. F11)
        console.warn('[Presentation] Fullscreen request denied — browser policy');
      }
    }, [setChatAreaCollapsed, setSidebarOpen]);

    useEffect(() => {
      const onFullscreenChange = () => {
        const active = document.fullscreenElement === stageRef.current;
        setIsPresenting(active);

        if (!active) {
          // Ensure keyboard unlock on any fullscreen exit
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigator as any).keyboard?.unlock?.();
          setControlsVisible(true);
          clearPresentationIdleTimer();
        }
      };

      document.addEventListener('fullscreenchange', onFullscreenChange);
      return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
    }, [clearPresentationIdleTimer]);

    useEffect(() => {
      if (!isPresenting) {
        setControlsVisible(true);
        clearPresentationIdleTimer();
        return;
      }

      const handleActivity = () => {
        resetPresentationIdleTimer();
      };

      window.addEventListener('mousemove', handleActivity);
      window.addEventListener('mousedown', handleActivity);
      window.addEventListener('touchstart', handleActivity);
      if (isPresentationInteractionActive) {
        setControlsVisible(true);
        clearPresentationIdleTimer();
      } else {
        resetPresentationIdleTimer();
      }

      return () => {
        window.removeEventListener('mousemove', handleActivity);
        window.removeEventListener('mousedown', handleActivity);
        window.removeEventListener('touchstart', handleActivity);
        clearPresentationIdleTimer();
      };
    }, [
      clearPresentationIdleTimer,
      isPresenting,
      isPresentationInteractionActive,
      resetPresentationIdleTimer,
    ]);

    // Initialize playback engine when scene changes
    useEffect(() => {
      let cancelled = false;
      const initializeScene = async () => {
        const previousSceneId = activeSceneIdRef.current;
        if (previousSceneId && previousSceneId !== currentScene?.id) {
          saveSceneResumePosition(previousSceneId, currentPlaybackActionIndexRef.current);
        }

        // Bump epoch so any stale SSE callbacks from the previous scene are discarded
        sceneEpochRef.current++;
        resetPlaybackAttempt();

        // Wait for an in-flight presentation action before initializing the next
        // scene against shared whiteboard state.
        await chatAreaRef.current?.endActiveSession({ source: 'scene_switch' });
        if (cancelled) return;

        // Also abort the engine-level discussion controller
        if (discussionAbortRef.current) {
          discussionAbortRef.current.abort();
          discussionAbortRef.current = null;
        }

        // Stop any in-flight discussion TTS audio on scene switch
        discussionTTS.cleanup();

        const sessionResumeCursor =
          currentScene && typeof window !== 'undefined'
            ? getActionResumeRestoreCursor(
                readActionResumeState(window.sessionStorage, actionResumeStorageKey),
                currentScene.id,
                currentScene.actions ?? [],
              )
            : { actionIndex: 0, position: null };
        let savedResumeActionIndex = sessionResumeCursor.actionIndex;
        const playbackStageId = stage?.id ?? currentScene?.stageId;
        if (currentScene && playbackStageId && !sessionResumeCursor.position) {
          try {
            const cursor = await loadCursor(playbackStageId);
            if (
              cursor?.sceneId === currentScene.id &&
              currentScene.actions?.[cursor.actionIndex] &&
              canJumpWithinReconstructablePrefix(currentScene.actions, 0, cursor.actionIndex)
            ) {
              savedResumeActionIndex = cursor.actionIndex;
            }
          } catch (error) {
            console.warn(`Failed to load playback cursor for stage ${playbackStageId}:`, error);
          }
        }

        if (cancelled) return;

        const savedResumeAction = currentScene?.actions?.[savedResumeActionIndex];

        // Reset all roundtable/live state so scenes are fully isolated. Use the
        // saved action cursor immediately so mount/refresh cannot persist the
        // default first-speech cursor before the async engine jump finishes.
        resetSceneState({
          actionIndex: savedResumeActionIndex,
          lectureSpeech:
            savedResumeAction?.type === 'speech' ? (savedResumeAction as SpeechAction).text : null,
        });

        // A slide scene with no actions is still playable: the engine dwells on it
        // (see resolvePlaybackCursor) so a freshly inserted / emptied blank slide
        // shows for a beat and auto-play advances past it. Non-slide scenes
        // (quiz / interactive / pbl) without timeline actions get no lecture engine
        // as before. Don't touch `autoStartRef` here: in the PENDING_SCENE_ID
        // handoff `currentScene` is null while a pending auto-start legitimately
        // waits for the next generated scene to materialize.
        const hasPlayableActions =
          hasPlayableSceneActions(currentScene) ||
          (!presentationOnly && !!liveCourseSessionRef.current && currentScene?.type === 'quiz');
        if (!currentScene || !hasPlayableActions) {
          // The previous engine may still own audio/timers while the new
          // scene is loading (or while the pending scene has no actions).
          // Stop it before dropping the reference so those resources cannot
          // outlive the scene boundary.
          if (engineRef.current) {
            engineRef.current.stop();
          }
          engineRef.current = null;
          playbackAttemptRef.current = null;
          setEngineMode('idle');
          activeSceneIdRef.current = currentSceneId;
          // `currentScene === null` is the normal teaching handoff while the
          // synthetic pending slot waits for the next generated scene.  A
          // replay target is never represented by that null scene, so do not
          // consume/clear the teaching auto-start latch merely because both
          // values happen to be null.
          if (currentScene && replayStartTargetRef.current === nodeIdForScene(currentScene.id)) {
            replayStartTargetRef.current = null;
            replayStartPausedRef.current = false;
            autoStartRef.current = false;
          }

          return;
        }

        // Stop previous engine
        if (engineRef.current) {
          engineRef.current.stop();
        }

        // Widget iframe messaging callback for interactive scenes, resolved lazily
        // at send time (keyed by sceneId). The interactive iframe now lives in the
        // keep-alive host (#619), which registers its postMessage callback a commit
        // after this engine is built — so resolving eagerly here would capture null
        // on a scene's first visit and silently drop every widget action. Looking it
        // up per-send always sees the live registration.
        const sceneIdForWidget = currentScene.id;
        const widgetSendMessage = (type: string, payload: Record<string, unknown>) =>
          useWidgetIframeStore.getState().getSendMessage(sceneIdForWidget)?.(type, payload);

        // Create ActionEngine for playback (with audioPlayer for TTS and widget messaging)
        const actionEngine = new ActionEngine(
          playbackStore,
          audioPlayerRef.current,
          widgetSendMessage,
        );

        // Every callback below belongs to this exact scene epoch and engine.
        // The attempt is installed immediately after construction; the engine
        // constructor is side-effect free, so no callback can run before then.
        const engineEpoch = sceneEpochRef.current;
        // The callbacks passed to the constructor close over these values; the
        // engine is assigned exactly once immediately after construction.
        // eslint-disable-next-line prefer-const
        let engine!: PlaybackEngine;
        // eslint-disable-next-line prefer-const
        let attempt!: PlaybackAttempt;
        const captureTeachingContext = (nodeId: string): PlaybackBoundaryContext | null => {
          const session = liveCourseSessionRef.current;
          const identity = readPlaybackSessionIdentity(session);
          if (!session || session.status !== 'ready' || !identity) return null;

          if (attempt.teachingSessionIdentity) {
            if (
              attempt.teachingSessionEpoch !== sessionEpochRef.current ||
              !samePlaybackSessionIdentity(attempt.teachingSessionIdentity, identity)
            ) {
              return null;
            }
          } else {
            attempt.teachingSessionEpoch = sessionEpochRef.current;
            attempt.teachingSessionIdentity = identity;
          }

          return {
            nodeId,
            sceneId: currentScene.id,
            epoch: engineEpoch,
            runGeneration: attempt.runGeneration,
            sessionEpoch: attempt.teachingSessionEpoch,
            sessionIdentity: attempt.teachingSessionIdentity,
            engine,
          };
        };
        const currentContext = (
          nodeId = nodeIdForScene(currentScene.id),
        ): PlaybackBoundaryContext => ({
          nodeId,
          sceneId: currentScene.id,
          epoch: engineEpoch,
          runGeneration: attempt.runGeneration,
          sessionEpoch: sessionEpochRef.current,
          sessionIdentity: readPlaybackSessionIdentity(liveCourseSessionRef.current),
          engine,
        });

        // Create new PlaybackEngine
        const teachingScene =
          !presentationOnly &&
          liveCourseSessionRef.current &&
          currentScene.type === 'quiz' &&
          !currentScene.actions?.some((action) => action.type === 'speech')
            ? {
                ...currentScene,
                actions: [
                  {
                    id: `checkpoint-intro:${currentScene.id}`,
                    type: 'speech' as const,
                    text: t('livecourse.checkpointInstruction'),
                  },
                  ...(currentScene.actions ?? []),
                ],
              }
            : currentScene;
        engine = new PlaybackEngine([teachingScene], actionEngine, audioPlayerRef.current, {
          ...(!presentationOnly && liveCourseSessionRef.current
            ? { speak: speakClassroomText }
            : {}),
          ...(presentationOnly || liveCourseSessionRef.current
            ? { skipRoundtableDiscussion: true }
            : {}),
          onSpeechCancel: () => {
            useLiveCaptionStore.getState().releaseCaption();
            if (playbackAttemptRef.current !== attempt) return;
            const cycle = attempt.activeSpeech;
            if (!cycle) return;
            attempt.speechCycles = attempt.speechCycles.filter((item) => item !== cycle);
            attempt.activeSpeech = null;
          },
          onError: (error) => {
            markPlaybackAttemptFailure(attempt, error, 'Teacher speech failed');
          },
          onModeChange: (mode) => {
            if (engineRef.current !== engine || sceneEpochRef.current !== engineEpoch) return;
            setEngineMode(mode);
          },
          onProgress: (snapshot) => {
            // Identity guard: a superseded engine (scene switch during an
            // async resume) must not publish its old scene's position over
            // the installed engine's cursor.
            if (
              !mountedRef.current ||
              engineRef.current !== engine ||
              sceneEpochRef.current !== engineEpoch
            ) {
              return;
            }
            updateCurrentPlaybackActionIndex(snapshot.actionIndex);
            saveSceneResumePosition(snapshot.sceneId, snapshot.actionIndex);
            if (playbackStageId && snapshot.sceneId) {
              scheduleCursorSave(playbackStageId, {
                sceneId: snapshot.sceneId,
                actionIndex: snapshot.actionIndex,
                updatedAt: new Date().toISOString(),
              });
            }
          },
          onSceneChange: (_sceneId) => {
            // Scene change handled by engine
          },
          onSpeechStart: (text) => {
            const activeAttempt = playbackAttemptRef.current;
            if (
              !activeAttempt ||
              activeAttempt !== attempt ||
              !isCurrentEngineEpoch(attempt.context)
            ) {
              return;
            }

            setLectureSpeech(text);
            // Authored speech is known before any realtime transcript arrives.
            // Project it as the classroom caption so J3.1 is visible even when
            // the transport does not emit audio-transcript events.
            if (text.trim()) {
              const captions = useLiveCaptionStore.getState();
              captions.setCaption({ speaker: 'teacher', text });
              captions.holdCaption();
            }
            const nodeId = nodeIdForScene(currentScene.id);
            attempt.speechGeneration += 1;
            const speechGeneration = attempt.speechGeneration;
            const activeSession = liveCourseSessionRef.current;
            if (attempt.expectsTeachingSession) {
              const context = captureTeachingContext(nodeId);
              const cycleContext = context ?? currentContext(nodeId);
              const cycle: PlaybackSpeechCycle = {
                generation: speechGeneration,
                context: cycleContext,
                startPromise: Promise.resolve(null),
                start: null,
                endPromise: null,
                endActionId: null,
              };
              attempt.activeSpeech = cycle;
              attempt.speechCycles.push(cycle);

              if (!activeSession?.emitAction || activeSession.status !== 'ready' || !context) {
                markPlaybackAttemptFailure(
                  attempt,
                  new Error('Cannot publish speech start without a ready classroom identity'),
                  'Cannot publish speech start without a ready classroom identity',
                  cycleContext,
                );
                cycle.startPromise = Promise.resolve(null);
              } else {
                cycle.startPromise = Promise.resolve()
                  .then(() =>
                    activeSession.emitAction({
                      type: 'avatar.speech_start',
                      nodeId,
                      payload: { text },
                    }),
                  )
                  .then((result) => {
                    if (
                      playbackAttemptRef.current !== attempt ||
                      !isCurrentTeachingContext(context)
                    ) {
                      return null;
                    }
                    const actionId = requireCommittedActionId(
                      result,
                      'Speech start did not return a committed action id',
                    );
                    const committed: PlaybackSpeechBoundary = {
                      ...context,
                      actionId,
                    };
                    cycle.start = committed;
                    return committed;
                  })
                  .catch((error) => {
                    const failure = markPlaybackAttemptFailure(
                      attempt,
                      error,
                      'Failed to publish speech start',
                      context,
                    );
                    if (failure) {
                      console.error('[LiveCourse] Failed to publish speech start', error);
                    }
                    return null;
                  });
              }
            }
            // Add to lecture session with incrementing index for dedup
            // Chat area pacing is handled by the StreamBuffer (onTextReveal)
            if (lectureSessionIdRef.current) {
              const idx = lectureActionCounterRef.current++;
              const speechId = `speech-${Date.now()}`;
              chatAreaRef.current?.addLectureMessage(
                lectureSessionIdRef.current,
                { id: speechId, type: 'speech', text } as Action,
                idx,
              );
              // Track active bubble for highlight (Issue 8)
              const msgId = chatAreaRef.current?.getLectureMessageId(lectureSessionIdRef.current!);
              if (msgId) setActiveBubbleId(msgId);
            }
          },
          onSpeechEnd: () => {
            useLiveCaptionStore.getState().releaseCaption();
            // Don't clear lectureSpeech — let it persist until the next
            // onSpeechStart replaces it or the scene transitions.
            // Clearing here causes fallback to idleText (first sentence).
            if (playbackAttemptRef.current !== attempt || !isCurrentEngineEpoch(attempt.context)) {
              return;
            }
            setActiveBubbleId(null);
            if (!attempt.expectsTeachingSession) return;
            const cycle = attempt.activeSpeech;
            if (!cycle || cycle.generation !== attempt.speechGeneration) {
              markPlaybackAttemptFailure(
                attempt,
                new Error('Speech ended without a committed speech start'),
                'Speech ended without a committed speech start',
                currentContext(nodeIdForScene(currentScene.id)),
              );
              return;
            }
            if (cycle.endPromise) return;
            const endPromise = cycle.startPromise.then(async (start) => {
              if (!start) return null;
              if (playbackAttemptRef.current !== attempt || !isCurrentTeachingContext(start)) {
                return null;
              }
              const currentSession = liveCourseSessionRef.current;
              if (!currentSession?.emitAction || currentSession.status !== 'ready') {
                markPlaybackAttemptFailure(
                  attempt,
                  new Error('Classroom session became unavailable before speech ended'),
                  'Classroom session became unavailable before speech ended',
                  start,
                );
                return null;
              }
              try {
                const result = await currentSession.emitAction({
                  type: 'avatar.speech_end',
                  nodeId: start.nodeId,
                  payload: {},
                });
                if (playbackAttemptRef.current !== attempt || !isCurrentTeachingContext(start)) {
                  return null;
                }
                const actionId = requireCommittedActionId(
                  result,
                  'Speech end did not return a committed action id',
                );
                cycle.endActionId = actionId;
                return actionId;
              } catch (error) {
                const failure = markPlaybackAttemptFailure(
                  attempt,
                  error,
                  'Failed to publish speech end',
                  start,
                );
                if (failure) console.error('[LiveCourse] Failed to publish speech end', error);
                return null;
              }
            });
            cycle.endPromise = endPromise;
          },
          onEffectFire: (effect: Effect) => {
            if (playbackAttemptRef.current !== attempt || !isCurrentEngineEpoch(attempt.context)) {
              return;
            }
            if (effect.kind === 'spotlight' || effect.kind === 'laser') {
              if (attempt.expectsTeachingSession) {
                const context = captureTeachingContext(nodeIdForScene(currentScene.id));
                const activeSession = liveCourseSessionRef.current;
                if (!activeSession?.emitAction || activeSession.status !== 'ready' || !context) {
                  markPlaybackAttemptFailure(
                    attempt,
                    new Error(
                      `Cannot publish ${effect.kind} action without a ready classroom identity`,
                    ),
                    `Cannot publish ${effect.kind} action without a ready classroom identity`,
                    context ?? currentContext(nodeIdForScene(currentScene.id)),
                  );
                  const effectPromise: Promise<string | null> = Promise.resolve(null);
                  attempt.effectActionPromises.push(effectPromise);
                } else {
                  const effectPromise = Promise.resolve()
                    .then(() =>
                      activeSession.emitAction({
                        type: 'avatar.look_at',
                        nodeId: context.nodeId,
                        payload: { target: 'slides' },
                      }),
                    )
                    .then((result) => {
                      if (
                        playbackAttemptRef.current !== attempt ||
                        !isCurrentTeachingContext(context)
                      ) {
                        return null;
                      }
                      const actionId = requireCommittedActionId(
                        result,
                        `The ${effect.kind} action did not return a committed action id`,
                      );
                      attempt.effectActionIds.push(actionId);
                      return actionId;
                    })
                    .catch((error) => {
                      const failure = markPlaybackAttemptFailure(
                        attempt,
                        error,
                        `Failed to publish ${effect.kind} action`,
                        context,
                      );
                      if (failure) {
                        console.error(
                          `[LiveCourse] Failed to publish ${effect.kind} action`,
                          error,
                        );
                      }
                      return null;
                    });
                  attempt.effectActionPromises.push(effectPromise);
                }
              }
            }
            // Add to lecture session with incrementing index
            if (
              lectureSessionIdRef.current &&
              (effect.kind === 'spotlight' || effect.kind === 'laser')
            ) {
              const idx = lectureActionCounterRef.current++;
              chatAreaRef.current?.addLectureMessage(
                lectureSessionIdRef.current,
                {
                  id: `${effect.kind}-${Date.now()}`,
                  type: effect.kind,
                  elementId: effect.targetId,
                } as Action,
                idx,
              );
            }
          },
          onProactiveShow: (trigger) => {
            if (presentationOnly) return;
            if (!trigger.agentId) {
              // Mutate in-place so engine.currentTrigger also gets the agentId
              // (confirmDiscussion reads agentId from the same object reference)
              trigger.agentId = pickStudentAgent();
            }
            setDiscussionTrigger(trigger);
          },
          onProactiveHide: () => {
            if (presentationOnly) return;
            setDiscussionTrigger(null);
          },
          onDiscussionConfirmed: (topic, prompt, agentId) => {
            if (presentationOnly) return;
            // Start SSE discussion via ChatArea
            handleDiscussionSSE(topic, prompt, agentId);
          },
          onDiscussionEnd: () => {
            if (presentationOnly) return;
            // Abort any active SSE
            if (discussionAbortRef.current) {
              discussionAbortRef.current.abort();
              discussionAbortRef.current = null;
            }
            setDiscussionTrigger(null);
            // Stop any in-flight discussion TTS audio
            discussionTTS.cleanup();
            // Clear roundtable state (idempotent — may already be cleared by doSessionCleanup)
            resetLiveState();
            // Only show flash for engine-initiated ends (not manual stop — that's handled by doSessionCleanup)
            if (!manualStopRef.current) {
              setEndFlashSessionType('discussion');
              setShowEndFlash(true);
              setTimeout(() => setShowEndFlash(false), 1800);
            }
            // If all actions are exhausted (discussion was the last action), mark
            // playback as completed so the bubble shows reset instead of play.
            if (!attempt.expectsTeachingSession && engineRef.current?.isExhausted()) {
              setPlaybackCompleted(true);
            }
          },
          onUserInterrupt: (text) => {
            if (presentationOnly) return;
            if (typeof text !== 'string' || text.trim().length === 0) return;
            // User interrupted → start a discussion via chat
            void chatAreaRef.current?.sendMessage(text);
          },
          isAgentSelected: (agentId) => {
            const ids = useSettingsStore.getState().selectedAgentIds;
            return ids.includes(agentId);
          },
          getPlaybackSpeed: () => useSettingsStore.getState().playbackSpeed || 1,
          onComplete: () => {
            const activeAttempt = playbackAttemptRef.current;
            if (
              !activeAttempt ||
              activeAttempt !== attempt ||
              !isCurrentEngineEpoch(attempt.context)
            ) {
              return;
            }

            // PlaybackEngine can deliver completion more than once (for
            // example after a synchronous audio cancellation). Claim the
            // completion before any UI or replay-W side effect so one engine
            // attempt can advance at most one node.
            if (activeAttempt.completionGuard) return;
            activeAttempt.completionGuard = true;
            if (relistenRef.current && !activeAttempt.expectsTeachingSession) {
              void endRelistenRef.current?.().catch((cause) => {
                activeAttempt.completionGuard = false;
                setPlaybackError(
                  toPlaybackError(cause, 'Could not return from relistening').message,
                );
              });
              return;
            }

            // Keep the visible final sentence until the next scene or an
            // explicit restart. UI completion is committed only after the
            // authoritative teaching command below succeeds.
            const finishPlaybackUi = () => {
              const completedSceneId = currentScene.id;
              const completedAttempt = activeAttempt;
              const completedEngine = engine;
              const completedEpoch = engineEpoch;
              const completedRunGeneration = completedAttempt.runGeneration;
              const completedSessionEpoch = sessionEpochRef.current;
              const completedSessionIdentity = readPlaybackSessionIdentity(
                liveCourseSessionRef.current,
              );
              const isSameCompletedSession = () => {
                const currentIdentity = readPlaybackSessionIdentity(liveCourseSessionRef.current);
                return completedSessionIdentity
                  ? samePlaybackSessionIdentity(currentIdentity, completedSessionIdentity)
                  : currentIdentity === null;
              };

              updateCurrentPlaybackActionIndex(currentScene.actions?.length ?? 0);
              clearSceneResumePosition(currentScene.id);
              setPlaybackCompleted(true);
              setPlaybackError(null);
              playbackRetryRequiredRef.current = false;

              if (lectureSessionIdRef.current) {
                chatAreaRef.current?.endSession(lectureSessionIdRef.current);
                lectureSessionIdRef.current = null;
              }

              if (presentationOnly) return;

              // Auto-play: advance to next scene after a short pause.
              const { autoPlayLecture } = useSettingsStore.getState();
              if (!completedAttempt.expectsTeachingSession && !autoPlayLecture) return;
              if (currentScene.type === 'quiz') return;
              clearAutoAdvanceTimer();
              autoAdvanceTimerRef.current = setTimeout(() => {
                autoAdvanceTimerRef.current = null;
                // The user may have navigated, retried, changed classroom
                // identity, or unmounted the root while the delay elapsed.
                // Every one of those transitions invalidates this callback.
                if (
                  !mountedRef.current ||
                  playbackAttemptRef.current !== completedAttempt ||
                  engineRef.current !== completedEngine ||
                  sceneEpochRef.current !== completedEpoch ||
                  completedAttempt.runGeneration !== completedRunGeneration ||
                  completedAttempt.context.sceneId !== completedSceneId ||
                  completedAttempt.context.epoch !== completedEpoch ||
                  sessionEpochRef.current !== completedSessionEpoch ||
                  !isSameCompletedSession()
                ) {
                  return;
                }
                if (completedAttempt.expectsTeachingSession) {
                  const session = liveCourseSessionRef.current;
                  if (session?.classroomState !== 'teaching') return;
                  void advanceTeachingNode(nodeIdForScene(completedSceneId)).catch((cause) => {
                    setPlaybackError(toPlaybackError(cause, 'Could not continue teaching').message);
                  });
                  return;
                }
                if (!useSettingsStore.getState().autoPlayLecture) return;
                const stageState = playbackStore.getState();
                const { generatingOutlines: currentGeneratingOutlines } = useStageStore.getState();
                const allScenes = stageState.scenes;
                const curId = stageState.currentSceneId;
                if (curId !== completedSceneId) return;
                const idx = allScenes.findIndex((scene) => scene.id === curId);
                if (idx >= 0 && idx < allScenes.length - 1) {
                  const nextScene = allScenes[idx];
                  if (
                    nextScene.type === 'quiz' ||
                    nextScene.type === 'interactive' ||
                    nextScene.type === 'pbl'
                  ) {
                    return;
                  }
                  autoStartRef.current = true;
                  void switchScene(allScenes[idx + 1].id).then((switched) => {
                    if (!switched) autoStartRef.current = false;
                  });
                } else if (idx === allScenes.length - 1 && currentGeneratingOutlines.length > 0) {
                  // Last scene exhausted but the next one is still generating.
                  const lastScene = allScenes[idx];
                  if (
                    lastScene.type === 'quiz' ||
                    lastScene.type === 'interactive' ||
                    lastScene.type === 'pbl'
                  ) {
                    return;
                  }
                  autoStartRef.current = true;
                  void switchScene(PENDING_SCENE_ID).then((switched) => {
                    if (!switched) autoStartRef.current = false;
                  });
                }
              }, 1500);
            };

            // Replay owns its authoritative node cursor in replay W. Query it
            // before committing local completion UI so a stale callback cannot
            // end a lecture bubble or clear the recovery point for a newer
            // scene. The target engine is started only after the old scene has
            // been finalized locally.
            if (presentationOnly && replayBridge) {
              const advance = replayBridge.advance;
              if (!advance) {
                activeAttempt.completionGuard = false;
                playbackRetryRequiredRef.current = true;
                setPlaybackError('Replay controls are not ready; please retry.');
                return;
              }
              void advance(nodeIdForScene(currentScene.id))
                .then(async (result) => {
                  if (result.positionMismatch) {
                    if (playbackAttemptRef.current === activeAttempt) {
                      activeAttempt.completionGuard = false;
                    }
                    return;
                  }
                  if (!result.advanced && !result.ended) {
                    if (playbackAttemptRef.current === activeAttempt) {
                      activeAttempt.completionGuard = false;
                      playbackRetryRequiredRef.current = true;
                      setPlaybackError('Replay did not advance; please retry.');
                    }
                    return;
                  }
                  finishPlaybackUi();
                  if (result.ended) {
                    replayBridge.complete?.();
                    return;
                  }
                  try {
                    if (!replayBridge.startReplay) {
                      throw new Error('Replay controls are not ready; please retry.');
                    }
                    await replayBridge.startReplay(result.nodeId);
                  } catch (error) {
                    if (playbackAttemptRef.current === activeAttempt) {
                      activeAttempt.completionGuard = false;
                      playbackRetryRequiredRef.current = true;
                      setPlaybackError('Failed to start replay playback');
                    }
                    console.error('[LiveCourse] Failed to start next replay scene', error);
                  }
                })
                .catch((error) => {
                  if (playbackAttemptRef.current === activeAttempt) {
                    activeAttempt.completionGuard = false;
                    playbackRetryRequiredRef.current = true;
                    setPlaybackError('Failed to advance replay');
                  }
                  console.error('[LiveCourse] Failed to advance replay', error);
                });
              return;
            }

            // Ordinary playback has no teaching controller. It can finish its
            // local UI immediately, while a teaching attempt must first prove
            // every speech/effect action was committed.
            if (!activeAttempt.expectsTeachingSession) {
              finishPlaybackUi();
              return;
            }
            if (currentScene.type === 'quiz') {
              finishPlaybackUi();
              return;
            }

            const nodeId = nodeIdForScene(currentScene.id);
            const capturedEngine = engine;
            const capturedSceneEpoch = engineEpoch;
            const capturedAttempt = activeAttempt;
            const capturedSession = liveCourseSessionRef.current;
            const capturedIdentity = readPlaybackSessionIdentity(capturedSession);
            const capturedSessionEpoch = sessionEpochRef.current;
            const capturedRunGeneration = capturedAttempt.runGeneration;
            const capturedCycles = [...capturedAttempt.speechCycles];
            const capturedEffectPromises = [...capturedAttempt.effectActionPromises];
            const capturedContext: PlaybackBoundaryContext = {
              nodeId,
              sceneId: currentScene.id,
              epoch: capturedSceneEpoch,
              runGeneration: capturedRunGeneration,
              sessionEpoch: capturedSessionEpoch,
              sessionIdentity: capturedIdentity,
              engine: capturedEngine,
            };

            const failCompletion = (cause: unknown, fallback: string) => {
              // A stale completion belongs to an old scene/session. Do not
              // surface it as an error for the newly installed attempt.
              if (
                playbackAttemptRef.current !== capturedAttempt ||
                !isCurrentEngineEpoch(capturedContext) ||
                capturedAttempt.runGeneration !== capturedRunGeneration ||
                sessionEpochRef.current !== capturedSessionEpoch ||
                (capturedIdentity
                  ? !samePlaybackSessionIdentity(
                      readPlaybackSessionIdentity(liveCourseSessionRef.current),
                      capturedIdentity,
                    )
                  : readPlaybackSessionIdentity(liveCourseSessionRef.current) !== null)
              ) {
                return;
              }
              capturedAttempt.completionGuard = false;
              markPlaybackAttemptFailure(capturedAttempt, cause, fallback, capturedContext);
            };

            void (async () => {
              try {
                if (!capturedSession || capturedSession.status !== 'ready' || !capturedIdentity) {
                  throw new Error('Cannot complete node without a ready classroom identity');
                }
                if (
                  capturedAttempt.teachingSessionEpoch !== capturedSessionEpoch ||
                  !samePlaybackSessionIdentity(
                    capturedAttempt.teachingSessionIdentity,
                    capturedIdentity,
                  )
                ) {
                  throw new Error('Teaching session identity changed before node completion');
                }
                if (capturedCycles.length === 0) {
                  throw new Error('Cannot complete node without a committed speech cycle');
                }

                const committedSpeech = await Promise.all(
                  capturedCycles.map(async (cycle) => {
                    if (
                      cycle.context.engine !== capturedEngine ||
                      cycle.context.epoch !== capturedSceneEpoch ||
                      cycle.context.runGeneration !== capturedRunGeneration ||
                      cycle.context.sessionEpoch !== capturedSessionEpoch ||
                      !samePlaybackSessionIdentity(cycle.context.sessionIdentity, capturedIdentity)
                    ) {
                      throw new Error('Speech boundary belongs to a stale teaching context');
                    }
                    const start = await cycle.startPromise;
                    if (!start) throw new Error('Speech start was not committed');
                    const end = cycle.endPromise ? await cycle.endPromise : null;
                    if (!end) throw new Error('Speech end was not committed');
                    return { start, end };
                  }),
                );

                const effectActionIds = await Promise.all(capturedEffectPromises);
                const committedEffectActionIds = effectActionIds.filter(
                  (actionId): actionId is string => actionId !== null,
                );
                if (committedEffectActionIds.length !== effectActionIds.length) {
                  throw new Error('A teaching effect was not committed');
                }
                if (
                  !isCurrentTeachingContext(capturedContext) ||
                  !capturedSession.emitAction ||
                  capturedSession.status !== 'ready'
                ) {
                  throw new Error('Teaching session changed before node completion');
                }

                const lastSpeech = committedSpeech.at(-1);
                if (!lastSpeech) throw new Error('No committed speech boundary was found');
                const actionIds = Array.from(
                  new Set([
                    ...committedSpeech.flatMap(({ start, end }) => [start.actionId, end]),
                    ...committedEffectActionIds,
                  ]),
                );
                const input = buildPlaybackCompletionInput({
                  nodeId,
                  idempotencyKey: `lesson.complete_node:${capturedIdentity.courseId}:${nodeId}`,
                  speechStartActionId: lastSpeech.start.actionId,
                  speechEndActionId: lastSpeech.end,
                  actionIds,
                });
                if (!input) throw new Error('Committed speech boundaries are incomplete');

                const pendingCompletion = { input, epoch: capturedSessionEpoch };
                pendingCompletionRef.current = pendingCompletion;
                await capturedSession.completeTeachingNode(input);
                if (pendingCompletionRef.current === pendingCompletion)
                  pendingCompletionRef.current = null;

                // The controller may update its provider state while the
                // command is in flight. Only the still-current engine/session
                // may update this component or schedule the next scene.
                if (
                  !isCurrentTeachingContext(capturedContext) ||
                  readPlaybackSessionIdentity(liveCourseSessionRef.current) === null ||
                  !samePlaybackSessionIdentity(
                    readPlaybackSessionIdentity(liveCourseSessionRef.current),
                    capturedIdentity,
                  )
                ) {
                  return;
                }
                finishPlaybackUi();
              } catch (error) {
                console.error('[LiveCourse] Failed to complete lesson node', error);
                failCompletion(error, 'Failed to complete lesson node');
              }
            })();
          },
        });

        attempt = installPlaybackAttempt(engine, currentScene.id);
        engineRef.current = engine;
        // Callback guards require the exact engine object to be installed
        // before any playback method is invoked.
        activeSceneIdRef.current = currentScene.id;

        // Auto-start if triggered by ordinary auto-play, or by an explicit
        // replay Host start request for this exact scene. A stale replay
        // request must never start a later manually selected scene.
        const replayStartRequested =
          presentationOnly && replayStartTargetRef.current === nodeIdForScene(currentScene.id);
        const replayStartPaused = replayStartPausedRef.current;
        const restore = relistenRestoreRef.current;
        if (restore?.sceneId === currentScene.id) {
          await restore.ready;
          if (cancelled || engineRef.current !== engine) return;
          relistenRestoreRef.current = null;
          autoStartRef.current = false;
          if (restore.wasIdle) {
            engine.stop();
          } else if (
            !(await engine.jumpToAction(restore.actionIndex, { autoplay: restore.wasPlaying }))
          ) {
            setPlaybackError('Could not restore the original teaching position');
          }
        } else if (autoStartRef.current && (!presentationOnly || replayStartRequested)) {
          autoStartRef.current = false;
          if (replayStartRequested) {
            replayStartTargetRef.current = null;
            replayStartPausedRef.current = false;
          }
          if (presentationOnly) {
            const requestGeneration = replayStartRequestGenerationRef.current;
            replayStartRequestGenerationRef.current = null;
            void startEnginePlayback(engine, currentScene, {
              restart: true,
              paused: replayStartPaused,
            })
              .then(() => {
                if (requestGeneration !== null) {
                  replayBridge?.reportPlaybackStarted?.(requestGeneration);
                }
              })
              .catch((error) => {
                console.error('[LiveCourse] Failed to start replay playback', error);
                playbackRetryRequiredRef.current = true;
                setPlaybackError('Failed to start replay playback');
                if (requestGeneration !== null) {
                  void replayBridge?.reportPlaybackFailure?.(requestGeneration, error);
                }
              });
          } else {
            void (async () => {
              if (relistenRef.current && !relistenRef.current.startConfirmed) return;
              if (pendingAdvanceRef.current && !pendingAdvanceRef.current.confirmed) return;
              await connectTeacher();
              if (currentScene && chatAreaRef.current) {
                const sessionId = await chatAreaRef.current.startLecture(currentScene.id);
                lectureSessionIdRef.current = sessionId;
                lectureActionCounterRef.current = 0;
              }
              if (engineRef.current !== engine) return;
              engine.start();
            })().catch((cause) => {
              markPlaybackAttemptFailure(attempt, cause, 'Could not start teaching');
            });
          }
        } else if (presentationOnly && autoStartRef.current) {
          // The request was for a different scene and has been superseded.
          autoStartRef.current = false;
          replayStartTargetRef.current = null;
          replayStartPausedRef.current = false;
          replayStartRequestGenerationRef.current = null;
        } else {
          // Load saved playback state and restore position (but never auto-play).
          if (savedResumeActionIndex > 0 && engine.canJumpToAction(savedResumeActionIndex)) {
            void engine
              .jumpToAction(savedResumeActionIndex, { autoplay: false })
              .then((restored) => {
                if (!restored || engineRef.current !== engine) return;
                updateCurrentPlaybackActionIndex(savedResumeActionIndex);
                const action = currentScene.actions?.[savedResumeActionIndex];
                if (action?.type === 'speech') {
                  setLectureSpeech(action.text);
                }
              });
          }
        }
      };

      void initializeScene().catch((cause) => {
        if (cancelled) return;
        console.error('[LiveCourse] Could not initialize teaching playback', cause);
        engineRef.current?.stop();
        setPlaybackError(toPlaybackError(cause, 'Could not initialize teaching playback').message);
        playbackRetryRequiredRef.current = true;
      });
      return () => {
        cancelled = true;
        feedbackAbortRef.current?.abort();
        clearAutoAdvanceTimer();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Only re-run when scene changes, functions are stable refs
    }, [currentScene, playbackStore]);

    // Cleanup on unmount
    useEffect(() => {
      const audioPlayer = audioPlayerRef.current;
      const chatArea = chatAreaRef.current;
      return () => {
        relistenRef.current?.releaseRestore?.();
        feedbackAbortRef.current?.abort();
        clearAutoAdvanceTimer();
        if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current);
        cursorSaveTimerRef.current = null;
        const pendingCursor = pendingCursorRef.current;
        pendingCursorRef.current = null;
        if (pendingCursor) persistCursorSafely(pendingCursor);
        saveSceneResumePosition(activeSceneIdRef.current, currentPlaybackActionIndexRef.current);
        if (engineRef.current) {
          engineRef.current.stop();
        }
        audioPlayer.destroy();
        if (discussionAbortRef.current) {
          discussionAbortRef.current.abort();
        }
        discussionTTS.cleanup();
        chatArea?.endActiveSession();
        clearPresentationIdleTimer();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup, timer and teardown refs are stable
    }, []);

    // Sync mute state from settings store to audioPlayer
    useEffect(() => {
      audioPlayerRef.current.setMuted(ttsMuted);
    }, [ttsMuted]);

    // Sync volume from settings store to audioPlayer
    const ttsVolume = useSettingsStore((s) => s.ttsVolume);
    useEffect(() => {
      if (!ttsMuted) {
        audioPlayerRef.current.setVolume(ttsVolume);
      }
    }, [ttsVolume, ttsMuted]);

    // Sync playback speed to audio player (for live-updating current audio)
    const playbackSpeed = useSettingsStore((s) => s.playbackSpeed);
    useEffect(() => {
      audioPlayerRef.current.setPlaybackRate(playbackSpeed);
    }, [playbackSpeed]);

    /**
     * Handle discussion SSE — POST /api/chat and push events to engine
     */
    const handleDiscussionSSE = useCallback(
      async (topic: string, prompt?: string, agentId?: string) => {
        // Start discussion display in ChatArea (lecture speech is preserved independently)
        chatAreaRef.current?.startDiscussion({
          topic,
          prompt,
          agentId: agentId || 'default-1',
        });
        // Auto-switch to chat tab when discussion starts
        chatAreaRef.current?.switchToTab('chat');
        // Immediately mark streaming for synchronized stop button
        setChatIsStreaming(true);
        setChatSessionType('discussion');
        // Optimistic thinking: show thinking dots immediately (same as onMessageSend)
        setThinkingState({ stage: 'director' });
      },
      [],
    );

    // First speech text for idle display (extracted here for playbackView)
    const firstSpeechText = useMemo(
      () =>
        currentScene?.actions?.find((a): a is SpeechAction => a.type === 'speech')?.text ?? null,
      [currentScene],
    );

    // Whether the speaking agent is a student (for bubble role derivation)
    const speakingStudentFlag = useMemo(() => {
      if (!speakingAgentId) return false;
      const agent = useAgentRegistry.getState().getAgent(speakingAgentId);
      return agent?.role !== 'teacher';
    }, [speakingAgentId]);

    // Centralised derived playback view
    const playbackView = useMemo(
      () =>
        computePlaybackView({
          engineMode,
          lectureSpeech,
          liveSpeech,
          speakingAgentId,
          thinkingState,
          isCueUser,
          isTopicPending,
          chatIsStreaming,
          discussionTrigger,
          playbackCompleted,
          idleText: firstSpeechText,
          speakingStudent: speakingStudentFlag,
          sessionType: chatSessionType,
        }),
      [
        engineMode,
        lectureSpeech,
        liveSpeech,
        speakingAgentId,
        thinkingState,
        isCueUser,
        isTopicPending,
        chatIsStreaming,
        discussionTrigger,
        playbackCompleted,
        firstSpeechText,
        speakingStudentFlag,
        chatSessionType,
      ],
    );

    const isTopicActive = playbackView.isTopicActive;

    /**
     * Gated scene switch — if a topic is active, show AlertDialog before switching.
     * Returns true if the switch was immediate, false if gated (dialog shown).
     */
    const gatedSceneSwitch = useCallback(
      async (targetSceneId: string): Promise<boolean> => {
        const requestId = ++sceneSwitchRequestRef.current;
        // A user-initiated navigation cancels the delayed auto-start that was
        // armed while the previous scene waited on PENDING_SCENE_ID. Without
        // this reset, selecting the previous/another real scene would start
        // it unexpectedly as soon as its engine mounted.
        autoStartRef.current = false;
        replayStartTargetRef.current = null;
        if (targetSceneId === currentSceneId) {
          setPendingSceneId(null);
          return false;
        }
        if (isTopicActive) {
          setPendingSceneId(targetSceneId);
          return false;
        }
        await chatAreaRef.current?.endActiveSession({ source: 'scene_switch' });
        if (requestId !== sceneSwitchRequestRef.current) return false;
        return switchScene(targetSceneId);
      },
      [currentSceneId, isTopicActive, switchScene],
    );

    /** User confirmed scene switch via AlertDialog */
    const confirmSceneSwitch = useCallback(async () => {
      if (!pendingSceneId) return;
      const targetSceneId = pendingSceneId;
      const requestId = ++sceneSwitchRequestRef.current;
      // Confirming a pending manual navigation is also explicit user intent;
      // do not let a stale generation handoff auto-start this scene.
      autoStartRef.current = false;
      replayStartTargetRef.current = null;
      sceneSwitchConfirmingRef.current = true;
      setPendingSceneId(null);
      try {
        await chatAreaRef.current?.endActiveSession({ source: 'scene_switch' });
        if (requestId !== sceneSwitchRequestRef.current) return;
        doSessionCleanup();
        await switchScene(targetSceneId);
      } finally {
        sceneSwitchConfirmingRef.current = false;
      }
    }, [pendingSceneId, switchScene, doSessionCleanup]);

    /** User cancelled scene switch via AlertDialog */
    const cancelSceneSwitch = useCallback(() => {
      sceneSwitchRequestRef.current += 1;
      setPendingSceneId(null);
    }, []);

    const currentTeachingNodeId = useCallback((): string => {
      const session = liveCourseSessionRef.current;
      if (!session || session.status !== 'ready') {
        throw new Error('LiveCourse session is not ready');
      }
      const nodeId =
        session.currentNodeId ?? (currentScene ? nodeIdForScene(currentScene.id) : null);
      if (!nodeId) throw new Error('Classroom has no active lesson node');
      if (currentScene && nodeIdForScene(currentScene.id) !== nodeId) {
        throw new Error('Classroom node changed before playback control could run');
      }
      return nodeId;
    }, [currentScene]);

    const createTeachingPlaybackPort = useCallback(
      (engine: PlaybackEngine, sessionId: string | null): TeachingPlaybackControlPort => ({
        pauseEngine: () => {
          if (engineRef.current !== engine) throw new Error('Playback engine is no longer current');
          if (engine.getMode() !== 'playing') {
            throw new Error(`Cannot pause playback while engine is ${engine.getMode()}`);
          }
          engine.pause();
          if (engine.getMode() !== 'paused') {
            throw new Error('Playback engine did not enter paused state');
          }
        },
        resumeEngine: () => {
          if (engineRef.current !== engine) throw new Error('Playback engine is no longer current');
          if (engine.getMode() !== 'paused') {
            throw new Error(`Cannot resume playback while engine is ${engine.getMode()}`);
          }
          engine.resume();
          if (engine.getMode() !== 'playing') {
            throw new Error('Playback engine did not resume playing');
          }
        },
        pauseBuffer: () => {
          if (sessionId) chatAreaRef.current?.pauseBuffer(sessionId);
        },
        resumeBuffer: () => {
          if (sessionId) chatAreaRef.current?.resumeBuffer(sessionId);
        },
        isEnginePaused: () =>
          engineRef.current === engine ? engine.getMode() === 'paused' : undefined,
        isBufferPaused: () =>
          sessionId ? (chatAreaRef.current?.getBufferPaused(sessionId) ?? null) : null,
      }),
      [],
    );

    const resolveRealtimePlayback = useCallback((nodeId: string) => {
      const session = liveCourseSessionRef.current;
      if (!session || session.status !== 'ready') {
        throw new Error('LiveCourse session is not ready for a realtime interruption');
      }
      const engine = engineRef.current;
      if (!engine) throw new Error('Playback engine is not ready for a realtime interruption');
      const sceneId = engine.getCurrentSceneId();
      if (!sceneId || nodeIdForScene(sceneId) !== nodeId) {
        throw new Error('Realtime interruption node does not match the current playback scene');
      }
      return { session, engine, sceneId };
    }, []);

    const createRealtimePlaybackPort = useCallback(
      (engine: PlaybackEngine, sessionId: string | null): RealtimePlaybackControlPort => ({
        ...createTeachingPlaybackPort(engine, sessionId),
        assertFrozen: () => {
          if (engineRef.current !== engine || engine.getMode() !== 'paused') {
            throw new Error('Playback engine changed while capturing interruption');
          }
        },
        assertReleased: () => {
          if (engineRef.current !== engine || engine.getMode() !== 'playing') {
            throw new Error('Playback engine changed while resuming realtime interruption');
          }
        },
      }),
      [createTeachingPlaybackPort],
    );

    /** Freeze the independent narrator before Realtime appends lesson.interrupt. */
    const handleRealtimePlaybackInterrupt = useCallback(
      async (nodeId: string): Promise<void> => {
        if (presentationOnly) {
          throw new Error('Realtime interruptions are unavailable in presentation mode');
        }
        const { session, engine, sceneId } = resolveRealtimePlayback(nodeId);
        if (session.classroomState !== 'teaching' && session.classroomState !== 'checking') {
          throw new Error(
            `Cannot interrupt classroom playback while the classroom is ${session.classroomState}`,
          );
        }
        if (realtimeFrozenNodeRef.current !== null) {
          throw new Error('A realtime interruption playback hold is already active');
        }

        saveSceneResumePosition(sceneId, currentPlaybackActionIndexRef.current);
        clearAutoAdvanceTimer();
        const sessionId = lectureSessionIdRef.current;
        if (engine.getMode() === 'idle' || engine.getMode() === 'paused') {
          realtimeFrozenNodeRef.current = nodeId;
          return;
        }
        if (engine.getMode() !== 'playing') {
          throw new Error(`Cannot interrupt playback while engine is ${engine.getMode()}`);
        }
        try {
          await freezeRealtimePlayback(createRealtimePlaybackPort(engine, sessionId));
          realtimeFrozenNodeRef.current = nodeId;
        } catch (cause) {
          // An ordinary freeze failure has completed its local rollback, so a
          // later compensation must not attempt to release already-playing
          // playback.  RealtimePlaybackControlError means at least one
          // inverse failed after a partial mutation; retain the node so the
          // paired resume handler can keep retrying that release boundary.
          realtimeFrozenNodeRef.current = retainRealtimePlaybackHoldAfterFreezeFailure(
            realtimeFrozenNodeRef.current,
            nodeId,
            cause,
          );
          throw cause;
        }
      },
      [
        createRealtimePlaybackPort,
        clearAutoAdvanceTimer,
        presentationOnly,
        resolveRealtimePlayback,
        saveSceneResumePosition,
      ],
    );

    /** Resume the frozen narrator after Realtime commits lesson.resume_interrupted. */
    const handleRealtimePlaybackResume = useCallback(
      async (nodeId: string): Promise<void> => {
        if (presentationOnly) {
          throw new Error('Realtime interruptions are unavailable in presentation mode');
        }
        const { session, engine } = resolveRealtimePlayback(nodeId);
        if (realtimeFrozenNodeRef.current !== nodeId) {
          throw new Error('No matching realtime interruption is held for playback resume');
        }
        // The controller may still expose `interrupted` in the same tick as
        // the W resume, or it may already expose the resumed teaching state.
        // In the latter case the held-node guard prevents an unrelated resume.
        const stateAllowsResume =
          session.classroomState === 'interrupted' ||
          ((session.classroomState === 'teaching' || session.classroomState === 'checking') &&
            realtimeFrozenNodeRef.current === nodeId);
        if (!stateAllowsResume) {
          throw new Error(
            `Cannot resume realtime interruption while the classroom is ${session.classroomState}`,
          );
        }
        if (engine.getMode() === 'idle') {
          realtimeFrozenNodeRef.current = null;
          setClassroomControlError(null);
          if (session.completedNodeIds.includes(nodeId)) {
            autoAdvanceTimerRef.current = setTimeout(() => {
              autoAdvanceTimerRef.current = null;
              const active = liveCourseSessionRef.current;
              if (active?.currentNodeId !== nodeId || active.classroomState !== 'teaching') return;
              void advanceTeachingNode(nodeId).catch((cause) =>
                setPlaybackError(toPlaybackError(cause, 'Could not continue teaching').message),
              );
            }, 0);
          }
          return;
        }
        if (engine.getMode() !== 'paused') {
          throw new Error(`Cannot resume interrupted playback while engine is ${engine.getMode()}`);
        }

        const sessionId = lectureSessionIdRef.current;
        await releaseRealtimePlayback(createRealtimePlaybackPort(engine, sessionId));
        realtimeFrozenNodeRef.current = null;
        setClassroomControlError(null);
      },
      [advanceTeachingNode, createRealtimePlaybackPort, presentationOnly, resolveRealtimePlayback],
    );

    const startInClassRelisten = useCallback(
      async (targetNodeId: string) => {
        const session = liveCourseSessionRef.current;
        const engine = engineRef.current;
        if (!session?.currentNodeId || !currentScene || !engine || checkpointFeedbackBusy) {
          throw new Error('Finish the current feedback before relistening');
        }
        const existing = relistenRef.current;
        if (existing && (existing.targetNodeId !== targetNodeId || existing.endPending)) {
          throw new Error('Recover the existing relistening operation first');
        }
        const epoch = sessionEpochRef.current;
        await connectTeacher();
        const activeSession = liveCourseSessionRef.current;
        if (
          sessionEpochRef.current !== epoch ||
          engineRef.current !== engine ||
          activeSession?.currentNodeId !== session.currentNodeId ||
          activeSceneIdRef.current !== currentScene.id
        ) {
          throw new Error('Teaching moved while connecting; select the relistening passage again');
        }
        const actionIndex = Math.min(
          currentPlaybackActionIndexRef.current ?? 0,
          Math.max(0, (currentScene.actions?.length ?? 1) - 1),
        );
        if (
          !existing &&
          engine.getMode() !== 'idle' &&
          !canJumpWithinReconstructablePrefix(currentScene.actions ?? [], 0, actionIndex) &&
          (currentScene.actions?.length ?? 0) > 0
        ) {
          throw new Error('Finish the current interactive step before relistening');
        }
        clearAutoAdvanceTimer();
        const operationId = createBrowserUuid();
        const origin = existing ?? {
          originNodeId: session.currentNodeId,
          originSceneId: currentScene.id,
          actionIndex,
          wasPlaying: engine.getMode() === 'playing',
          wasIdle: engine.getMode() === 'idle',
          targetNodeId,
          startKey: `relisten:${operationId}:start`,
          endKey: `relisten:${operationId}:end`,
          startConfirmed: false,
          endPending: false,
        };
        if (!existing) {
          if (origin.wasPlaying) engine.pause();
          saveSceneResumePosition(currentScene.id, actionIndex);
        }
        relistenRef.current = origin;
        autoStartRef.current = true;
        try {
          await session.emitAction({
            type: 'lesson.relisten_start',
            nodeId: targetNodeId,
            idempotencyKey: origin.startKey,
            payload: { targetNodeId },
          });
          origin.startConfirmed = true;
          const targetScene = playbackStore
            .getState()
            .scenes.find((scene) => nodeIdForScene(scene.id) === targetNodeId);
          const targetEngine = engineRef.current;
          if (targetScene && activeSceneIdRef.current === targetScene.id && targetEngine) {
            autoStartRef.current = false;
            targetEngine.stop();
            await startEnginePlayback(targetEngine, targetScene, { restart: true });
          }
          setPlaybackError(null);
        } catch (cause) {
          if (!origin.startConfirmed && !mustReconcileTeachingWrite(cause)) {
            relistenRef.current = null;
            autoStartRef.current = false;
            if (origin.wasPlaying && engine.getMode() === 'paused') engine.resume();
          } else {
            autoStartRef.current = false;
            engineRef.current?.stop();
            setPlaybackError(toPlaybackError(cause, 'Could not enter relistening').message);
          }
          throw cause;
        }
      },
      [
        checkpointFeedbackBusy,
        clearAutoAdvanceTimer,
        connectTeacher,
        currentScene,
        playbackStore,
        startEnginePlayback,
        saveSceneResumePosition,
      ],
    );

    const endInClassRelisten = useCallback(async () => {
      const origin = relistenRef.current;
      const session = liveCourseSessionRef.current;
      if (!origin || !session) throw new Error('There is no active relistening position');
      engineRef.current?.stop();
      autoStartRef.current = false;
      if (!origin.startConfirmed) {
        await session.emitAction({
          type: 'lesson.relisten_start',
          nodeId: origin.targetNodeId,
          idempotencyKey: origin.startKey,
          payload: { targetNodeId: origin.targetNodeId },
        });
        origin.startConfirmed = true;
      }
      origin.endPending = true;
      origin.restoreReady ??= new Promise<void>((resolve) => {
        origin.releaseRestore = resolve;
      });
      relistenRestoreRef.current = {
        sceneId: origin.originSceneId,
        actionIndex: origin.actionIndex,
        wasPlaying: origin.wasPlaying,
        wasIdle: origin.wasIdle,
        ready: origin.restoreReady,
      };
      try {
        await session.emitAction({
          type: 'lesson.relisten_end',
          nodeId: origin.originNodeId,
          idempotencyKey: origin.endKey,
          payload: { targetNodeId: origin.originNodeId },
        });
      } catch (cause) {
        setPlaybackError(toPlaybackError(cause, 'Could not restore the teaching position').message);
        throw cause;
      }
      relistenRef.current = null;
      origin.releaseRestore?.();
      setPlaybackError(null);
      if (origin.targetNodeId === origin.originNodeId && engineRef.current) {
        relistenRestoreRef.current = null;
        resetPlaybackAttempt();
        if (
          !origin.wasIdle &&
          !(await engineRef.current.jumpToAction(origin.actionIndex, {
            autoplay: origin.wasPlaying,
          }))
        ) {
          throw new Error('Could not restore the original teaching position');
        }
      }
      if (!origin.wasPlaying && session.completedNodeIds.includes(origin.originNodeId)) {
        relistenRestoreRef.current = null;
        await advanceTeachingNode(origin.originNodeId);
      }
    }, [advanceTeachingNode, resetPlaybackAttempt]);
    endRelistenRef.current = endInClassRelisten;

    const runTeachingControl = useCallback(
      (kind: TeachingControlKind, engine: PlaybackEngine, session: LiveCourseSessionValue) => {
        const nodeId = currentTeachingNodeId();
        const existing = pendingTeachingControlRef.current;
        const pending =
          existing && existing.kind === kind && existing.nodeId === nodeId
            ? existing
            : (() => {
                const generation = ++teachingControlGenerationRef.current;
                const idempotencyKey = createTeachingControlKey(kind, nodeId, generation);
                const next: PendingTeachingControl = {
                  kind,
                  nodeId,
                  idempotencyKey,
                  compensationKey: createTeachingControlKey('pause', nodeId, generation),
                  compensationPending: false,
                };
                pendingTeachingControlRef.current = next;
                return next;
              })();

        if (teachingControlPromiseRef.current) return teachingControlPromiseRef.current;

        const sessionId = lectureSessionIdRef.current;
        let resumeCommitted = false;
        let compensationCommitted = false;
        const promise = (async () => {
          const playback = createTeachingPlaybackPort(engine, sessionId);
          if (kind === 'pause') {
            await pauseTeachingPlayback(
              {
                pause: () =>
                  session.emitAction({
                    type: 'lesson.pause',
                    nodeId: pending.nodeId,
                    idempotencyKey: pending.idempotencyKey,
                    payload: {},
                  }),
              },
              playback,
              {
                shouldRollbackAfterCommitFailure: (cause) => !mustReconcileTeachingWrite(cause),
              },
            );
          } else {
            await resumeTeachingPlayback(
              {
                resume: async () => {
                  const result = await session.emitAction({
                    type: 'lesson.resume',
                    nodeId: pending.nodeId,
                    idempotencyKey: pending.idempotencyKey,
                    payload: {},
                  });
                  resumeCommitted = true;
                  return result;
                },
                pause: async () => {
                  try {
                    const result = await session.emitAction({
                      type: 'lesson.pause',
                      nodeId: pending.nodeId,
                      idempotencyKey: pending.compensationKey,
                      payload: {},
                    });
                    compensationCommitted = true;
                    pending.compensationPending = false;
                    return result;
                  } catch (cause) {
                    if (mustReconcileTeachingWrite(cause)) {
                      pending.compensationPending = true;
                    }
                    throw cause;
                  }
                },
              },
              playback,
            );
          }
          if (pendingTeachingControlRef.current === pending) {
            pendingTeachingControlRef.current = null;
          }
          setClassroomControlError(null);
        })();
        teachingControlPromiseRef.current = promise;
        void promise.then(
          () => {
            if (teachingControlPromiseRef.current === promise) {
              teachingControlPromiseRef.current = null;
            }
          },
          () => {
            if (teachingControlPromiseRef.current === promise) {
              teachingControlPromiseRef.current = null;
            }
            // A failed local resume may have been fully compensated by a
            // durable pause. The next click is then a new resume operation;
            // retaining the old key would only replay a duplicate action.
            if (
              kind === 'resume' &&
              resumeCommitted &&
              compensationCommitted &&
              pendingTeachingControlRef.current === pending
            ) {
              pendingTeachingControlRef.current = null;
            }
          },
        );
        return promise;
      },
      [createTeachingPlaybackPort, currentTeachingNodeId],
    );

    const handleRetryCurrentNode = useCallback(async () => {
      if (presentationOnly) return;
      const session = liveCourseSessionRef.current;
      const engine = engineRef.current;
      if (!session || session.status !== 'ready' || !engine) {
        throw new Error('Classroom playback is not ready to retry');
      }
      if (relistenRef.current?.endPending) {
        await endInClassRelisten();
        return;
      }
      if (pendingAdvanceRef.current?.epoch === sessionEpochRef.current) {
        await connectTeacher();
        await advanceTeachingNode(pendingAdvanceRef.current.nodeId);
        return;
      }
      const pendingCompletion = pendingCompletionRef.current;
      if (
        pendingCompletion?.epoch === sessionEpochRef.current &&
        pendingCompletion.input.nodeId === session.currentNodeId
      ) {
        const result = await session.completeTeachingNode(pendingCompletion.input);
        pendingCompletionRef.current = null;
        setPlaybackError(null);
        if (result.state === 'teaching') await advanceTeachingNode(pendingCompletion.input.nodeId);
        return;
      }
      if (relistenRef.current) {
        if (!relistenRef.current.startConfirmed) {
          await startInClassRelisten(relistenRef.current.targetNodeId);
          return;
        }
        await connectTeacher();
        engine.stop();
        resetPlaybackAttempt();
        engine.start();
        setPlaybackError(null);
        return;
      }
      if (session.classroomState !== 'teaching' && session.classroomState !== 'checking') {
        throw new Error(
          `Cannot retry the current node while the classroom is ${session.classroomState}`,
        );
      }
      const nodeId = currentTeachingNodeId();
      if (session.completedNodeIds.includes(nodeId)) {
        await connectTeacher();
        await advanceTeachingNode(nodeId);
        return;
      }
      if (pendingTeachingRetryRef.current?.nodeId !== nodeId) {
        const generation = ++teachingControlGenerationRef.current;
        pendingTeachingRetryRef.current = {
          nodeId,
          idempotencyKey: createTeachingControlKey('retry', nodeId, generation),
        };
      }
      if (teachingRetryPromiseRef.current) return teachingRetryPromiseRef.current;
      const pending = pendingTeachingRetryRef.current;
      if (!pending) throw new Error('Retry operation could not be initialized');
      const scene = currentScene;
      if (!scene || nodeIdForScene(scene.id) !== nodeId) {
        throw new Error('Current lesson scene is not ready to retry');
      }

      const promise = (async () => {
        await connectTeacher();
        await session.emitAction({
          type: 'lesson.retry',
          nodeId,
          idempotencyKey: pending.idempotencyKey,
          payload: {},
        });

        // W records the retry intent first. Once it is durable, reset the
        // local attempt and replay this node from its beginning. If startup
        // fails, the same pending key is reused on the next click.
        if (engineRef.current !== engine) throw new Error('Playback engine changed during retry');
        engine.stop();
        const oldLectureSessionId = lectureSessionIdRef.current;
        lectureSessionIdRef.current = null;
        if (oldLectureSessionId) {
          await chatAreaRef.current?.endSession(oldLectureSessionId);
        }
        if (engineRef.current !== engine) throw new Error('Playback scene changed during retry');
        resetPlaybackAttempt();
        setPlaybackCompleted(false);
        lectureActionCounterRef.current = 0;
        const restartedSessionId = await chatAreaRef.current?.startLecture(scene.id);
        if (!restartedSessionId || engineRef.current !== engine) {
          if (restartedSessionId) await chatAreaRef.current?.endSession(restartedSessionId);
          throw new Error('Lecture session is not ready to retry the current node');
        }
        lectureSessionIdRef.current = restartedSessionId;
        try {
          engine.start();
          if (engine.getMode() !== 'playing') {
            throw new Error('Playback engine did not start the current node');
          }
        } catch (cause) {
          if (lectureSessionIdRef.current === restartedSessionId) {
            lectureSessionIdRef.current = null;
            await chatAreaRef.current?.endSession(restartedSessionId);
          }
          if (engineRef.current === engine && engine.getMode() !== 'idle') engine.stop();
          throw cause;
        }
        pendingTeachingRetryRef.current = null;
        playbackRetryRequiredRef.current = false;
        setPlaybackError(null);
        setClassroomControlError(null);
      })();
      teachingRetryPromiseRef.current = promise;
      void promise.then(
        () => {
          if (teachingRetryPromiseRef.current === promise) teachingRetryPromiseRef.current = null;
        },
        (error) => {
          if (teachingRetryPromiseRef.current === promise) teachingRetryPromiseRef.current = null;
          const message = error instanceof Error ? error.message : String(error);
          setPlaybackError(message);
          playbackRetryRequiredRef.current = true;
        },
      );
      return promise;
    }, [
      advanceTeachingNode,
      connectTeacher,
      currentScene,
      currentTeachingNodeId,
      endInClassRelisten,
      presentationOnly,
      resetPlaybackAttempt,
      startInClassRelisten,
    ]);

    const requestRetryCurrentNode = useCallback(() => {
      void handleRetryCurrentNode().catch((error) => {
        console.error('[LiveCourse] Failed to retry current lesson node', error);
        setPlaybackError(error instanceof Error ? error.message : 'Classroom retry failed');
        playbackRetryRequiredRef.current = true;
      });
    }, [handleRetryCurrentNode]);

    // play/pause toggle
    const handlePlayPause = useCallback(async () => {
      const engine = engineRef.current;
      if (!engine) return;

      const teachingSession = liveCourseSessionRef.current;
      if (teachingSession?.status === 'ready' && !presentationOnly) {
        if (startingTeachingRef.current) return;
        if (engine.getMode() === 'idle') {
          startingTeachingRef.current = true;
          setStartingTeaching(true);
          try {
            await connectTeacher();
            if (engineRef.current !== engine) return;
            if (
              teachingSession.currentNodeId &&
              teachingSession.completedNodeIds.includes(teachingSession.currentNodeId)
            ) {
              await advanceTeachingNode(teachingSession.currentNodeId);
              return;
            }
          } catch (cause) {
            setPlaybackError(toPlaybackError(cause, 'Could not connect the teacher').message);
            return;
          } finally {
            startingTeachingRef.current = false;
            setStartingTeaching(false);
          }
        }
        const classroomState = teachingSession.classroomState;
        try {
          // A second click must join the in-flight W/local transaction rather
          // than minting a competing key or overwriting its pending recovery
          // metadata. Once the promise settles, the next click can reconcile
          // any retained uncertainty explicitly.
          const pendingControl = teachingControlPromiseRef.current;
          if (pendingControl) {
            await pendingControl;
            return;
          }
          const pending = pendingTeachingControlRef.current;
          const nodeId = currentTeachingNodeId();
          if (pending?.nodeId === nodeId && engine.getMode() === 'paused') {
            if (pending.kind === 'pause') {
              await teachingSession.emitAction({
                type: 'lesson.pause',
                nodeId: pending.nodeId,
                idempotencyKey: pending.idempotencyKey,
                payload: {},
              });
              if (pendingTeachingControlRef.current === pending) {
                pendingTeachingControlRef.current = null;
              }
              setClassroomControlError(null);
              return;
            }
            if (pending.compensationPending) {
              await teachingSession.emitAction({
                type: 'lesson.pause',
                nodeId: pending.nodeId,
                idempotencyKey: pending.compensationKey,
                payload: {},
              });
              if (pendingTeachingControlRef.current === pending) {
                pendingTeachingControlRef.current = null;
              }
              setClassroomControlError(
                'Classroom playback was restored to paused. Continue again to resume.',
              );
              return;
            }
          }
          if (
            pending &&
            pending.nodeId === nodeId &&
            ((pending.kind === 'pause' && engine.getMode() === 'playing') ||
              (pending.kind === 'resume' && engine.getMode() === 'paused'))
          ) {
            await runTeachingControl(pending.kind, engine, teachingSession);
            return;
          }
          if (classroomState === 'paused') {
            if (engine.getMode() !== 'paused') {
              throw new Error(
                `Cannot resume classroom while playback engine is ${engine.getMode()}`,
              );
            }
            await runTeachingControl('resume', engine, teachingSession);
            return;
          }
          if (classroomState === 'teaching' || classroomState === 'checking') {
            if (engine.getMode() === 'playing') {
              saveSceneResumePosition(currentScene?.id, currentPlaybackActionIndexRef.current);
              await runTeachingControl('pause', engine, teachingSession);
              return;
            }
            if (engine.getMode() === 'paused' || engine.getMode() === 'live') {
              throw new Error(
                `Cannot pause classroom while playback engine is ${engine.getMode()}`,
              );
            }
            // An idle engine has not started a teaching attempt yet. Start it
            // below without writing a misleading lesson.pause command.
          } else if (classroomState === 'interrupted' || classroomState === 'replaying') {
            throw new Error(`Classroom playback is ${classroomState}; finish that flow first`);
          }
          if (playbackError) return;
        } catch (error) {
          console.error('[LiveCourse] Classroom pause/resume failed', error);
          setClassroomControlError(
            error instanceof Error ? error.message : 'Classroom control failed',
          );
          return;
        }
      }

      // Replay has a second authoritative state machine (replay W). Never
      // mutate the local engine directly from a replay toolbar click: the Host
      // transaction first coordinates the controller command and compensates
      // the engine when that command fails.
      if (presentationOnly && replayBridge) {
        const mode = engine.getMode();
        const operation =
          mode === 'playing'
            ? replayBridge.pauseReplay
            : mode === 'paused'
              ? replayBridge.resumeReplay
              : replayBridge.startReplay;
        if (!operation) {
          setPlaybackError('Replay controls are not ready; please retry.');
          return;
        }
        try {
          await operation();
        } catch (error) {
          console.error('[LiveCourse] Replay playback control failed', error);
          setPlaybackError(error instanceof Error ? error.message : 'Replay playback failed');
        }
        return;
      }

      const mode = engine.getMode();
      if (mode === 'playing' || mode === 'live') {
        saveSceneResumePosition(currentScene?.id, currentPlaybackActionIndexRef.current);
        engine.pause();
        // Pause lecture buffer so text stops immediately
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.pauseBuffer(lectureSessionIdRef.current);
        }
      } else if (mode === 'paused') {
        engine.resume();
        // Resume lecture buffer
        if (lectureSessionIdRef.current) {
          chatAreaRef.current?.resumeBuffer(lectureSessionIdRef.current);
        }
      } else {
        const shouldRestart = playbackCompleted || playbackRetryRequiredRef.current;
        setPlaybackCompleted(false);
        if (shouldRestart) {
          resetPlaybackAttempt();
          lectureActionCounterRef.current = 0;
        }
        // Starting playback - create/reuse lecture session
        if (currentScene && chatAreaRef.current) {
          const sessionId = await chatAreaRef.current.startLecture(currentScene.id);
          if (engineRef.current !== engine) {
            await chatAreaRef.current.endSession(sessionId);
            return;
          }
          lectureSessionIdRef.current = sessionId;
        }
        if (shouldRestart) {
          // Completion failures retain the recovery point, but the engine has
          // already exhausted its internal cursor. Re-run the node so every
          // teaching boundary is emitted again under a fresh generation.
          engine.start();
        } else {
          // Continue from current position (e.g. after discussion end)
          engine.continuePlayback();
        }
      }
    }, [
      advanceTeachingNode,
      connectTeacher,
      currentScene,
      playbackCompleted,
      presentationOnly,
      replayBridge,
      resetPlaybackAttempt,
      saveSceneResumePosition,
      currentTeachingNodeId,
      playbackError,
      runTeachingControl,
    ]);

    // get scene information
    const isPendingScene = currentSceneId === PENDING_SCENE_ID;
    const hasNextPending = generatingOutlines.length > 0;
    // True when every outline has materialized into a scene and nothing is
    // currently generating — signals the classroom has finished and the user
    // can see a completion page. Comparing scenes.length === outlines.length
    // (rather than just `scenes.length > 0`) means a partial generation with
    // some failed outlines does not falsely trigger completion. The persisted
    // generationComplete flag also marks completion directly, so an edited
    // finished deck (e.g. a deleted slide, leaving outlines.length > scenes)
    // still reads as complete.
    const isCourseComplete =
      generationComplete ||
      (outlines.length > 0 && scenes.length === outlines.length && generatingOutlines.length === 0);
    // A replay is bounded by the persisted replay W range. The generation
    // placeholder / course-complete slot is a teaching-only affordance; making
    // it visible in replay would let keyboard/sidebar navigation request the
    // synthetic PENDING_SCENE_ID and escape that range.
    const canAdvanceToPendingSlot = !presentationOnly && (hasNextPending || isCourseComplete);

    // previous scene (gated)
    const handlePreviousScene = useCallback(() => {
      if (isPendingScene) {
        // From pending page → go to last real scene
        if (scenes.length > 0) {
          void gatedSceneSwitch(scenes[scenes.length - 1].id);
        }
        return;
      }
      const currentIndex = scenes.findIndex((s) => s.id === currentSceneId);
      if (currentIndex > 0) {
        void gatedSceneSwitch(scenes[currentIndex - 1].id);
      }
    }, [currentSceneId, gatedSceneSwitch, isPendingScene, scenes]);

    // next scene (gated)
    const handleNextScene = useCallback(() => {
      if (isPendingScene) return; // Already on pending, nowhere to go
      const currentIndex = scenes.findIndex((s) => s.id === currentSceneId);
      if (currentIndex < scenes.length - 1) {
        void gatedSceneSwitch(scenes[currentIndex + 1].id);
      } else if (canAdvanceToPendingSlot) {
        // On last real scene → advance to pending slot (generating or completion page)
        void gatedSceneSwitch(PENDING_SCENE_ID);
      }
    }, [currentSceneId, gatedSceneSwitch, canAdvanceToPendingSlot, isPendingScene, scenes]);

    const currentSceneIndex = isPendingScene
      ? scenes.length
      : scenes.findIndex((s) => s.id === currentSceneId);
    const totalScenesCount = scenes.length + (canAdvanceToPendingSlot ? 1 : 0);

    // get action information
    const totalActions = currentScene?.actions?.length || 0;
    const canJumpToAction = useCallback(
      (sceneId: string, actionIndex: number): boolean => {
        if (sceneId !== currentSceneId) return false;
        return canJumpWithinReconstructablePrefix(
          currentScene?.actions ?? [],
          currentPlaybackActionIndex,
          actionIndex,
        );
      },
      [currentPlaybackActionIndex, currentScene?.actions, currentSceneId],
    );

    const handleJumpToAction = useCallback(
      async (sceneId: string, actionIndex: number) => {
        const engine = engineRef.current;
        if (!engine || sceneId !== currentSceneId || !currentScene) return;
        const autoplay = engine.getMode() === 'playing';
        const jumped = await engine.jumpToAction(actionIndex, { autoplay });
        if (!jumped) return;
        setPlaybackCompleted(false);
        updateCurrentPlaybackActionIndex(actionIndex);
        const action = currentScene.actions?.[actionIndex];
        if (action?.type === 'speech') {
          setLectureSpeech(action.text);
        }
      },
      [currentScene, currentSceneId, updateCurrentPlaybackActionIndex],
    );

    // whiteboard toggle
    const handleWhiteboardToggle = () => {
      if (presentationOnly) {
        engineRef.current?.setWhiteboardOpen?.(!whiteboardOpen);
        return;
      }
      setWhiteboardOpen(!whiteboardOpen);
    };

    const isPresentationShortcutTarget = useCallback((target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;

      if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
        return true;
      }

      return (
        target.closest(
          [
            'input',
            'textarea',
            'select',
            'button',
            'a[href]',
            'summary',
            '[role="button"]',
            '[role="slider"]',
            '[role="checkbox"]',
            '[role="radio"]',
            '[role="switch"]',
            '[role="tab"]',
            '[role^="menuitem"]',
            '[role="combobox"]',
            '[role="listbox"]',
            '[role="option"]',
            '[role="dialog"]',
          ].join(', '),
        ) !== null
      );
    }, []);

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.repeat) return;
        // Modal overlays own keyboard input even when their first frame has not focused a control.
        if (document.querySelector('[role="dialog"][data-state="open"]')) return;
        // Let modifier-key combos (Ctrl+C, Ctrl+S, etc.) pass through to the browser
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          isPresentationShortcutTarget(event.target) ||
          isPresentationShortcutTarget(document.activeElement)
        ) {
          return;
        }

        switch (event.key) {
          case ' ':
          case 'Spacebar':
            event.preventDefault();
            void handlePlayPause();
            break;
          default:
            break;
        }
      };

      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [handlePlayPause, isPresentationShortcutTarget]);

    // Map engine mode to the CanvasArea's expected engine state
    const canvasEngineState = (() => {
      switch (engineMode) {
        case 'playing':
        case 'live':
          return 'playing';
        case 'paused':
          return 'paused';
        default:
          return 'idle';
      }
    })();

    return (
      <div
        ref={stageRef}
        data-testid="classroom-shell"
        className="relative flex min-h-0 flex-1 overflow-hidden bg-[var(--lc-classroom-surface)]"
      >
        <div
          className="lc-classroom-workbench relative min-h-0 min-w-0 flex-1 overflow-hidden"
          suppressHydrationWarning
        >
          <div className="lc-classroom-board-slot relative flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1">
              <CanvasArea
                classroomChrome
                currentScene={currentScene}
                currentSceneIndex={currentSceneIndex}
                scenesCount={totalScenesCount}
                mode={mode}
                engineState={canvasEngineState}
                isLiveSession={
                  chatIsStreaming ||
                  chatIsSoftClosing ||
                  isTopicPending ||
                  engineMode === 'live' ||
                  !!chatSessionType
                }
                isSoftClosing={chatIsSoftClosing}
                softCloseDeadline={softCloseDeadline}
                whiteboardOpen={whiteboardOpen}
                sidebarCollapsed={effectiveSidebarCollapsed}
                chatCollapsed={liveCourseSession ? !isLiveCourseRecordOpen : chatAreaCollapsed}
                onToggleSidebar={toggleSidebar}
                onToggleChat={() => {
                  if (liveCourseSession) setIsLiveCourseRecordOpen((open) => !open);
                  else setChatAreaCollapsed(!chatAreaCollapsed);
                }}
                onPrevSlide={handlePreviousScene}
                onNextSlide={handleNextScene}
                onPlayPause={handlePlayPause}
                onWhiteboardClose={handleWhiteboardToggle}
                isPresenting={isPresenting}
                onTogglePresentation={togglePresentation}
                showStopDiscussion={
                  !presentationOnly &&
                  (engineMode === 'live' ||
                    ((chatIsStreaming || chatIsSoftClosing) &&
                      (chatSessionType === 'qa' || chatSessionType === 'discussion')))
                }
                onStopDiscussion={presentationOnly ? undefined : handleStopDiscussion}
                onContinueDiscussion={presentationOnly ? undefined : handleContinueDiscussion}
                hideToolbar={mode === 'playback' || (isPresenting && !controlsVisible)}
                // Replay has no synthetic pending/completion slot; these
                // teaching-only overlays must stay unreachable even if a
                // stale canonical cursor briefly contains PENDING_SCENE_ID.
                isPendingScene={presentationOnly ? false : isPendingScene}
                isCourseComplete={presentationOnly ? false : isCourseComplete}
                isGenerationFailed={
                  !presentationOnly &&
                  isPendingScene &&
                  failedOutlines.some((f) => f.id === generatingOutlines[0]?.id)
                }
                onRetryGeneration={
                  !presentationOnly && onRetryOutline && generatingOutlines[0]
                    ? () => onRetryOutline(generatingOutlines[0].id)
                    : undefined
                }
                presentationOnly={presentationOnly}
                presentationStore={playbackStore}
              />
            </div>
            {/* Reserve space for captions instead of covering slide text or answers. */}
            {liveCourseSession || presentationOnly ? <LiveCaptionOverlay /> : null}
          </div>
          {liveCourseSession ? (
            <TeacherAvatarHost
              docked
              presence
              isPresenting={false}
              onPlaybackInterrupt={handleRealtimePlaybackInterrupt}
              onPlaybackResume={handleRealtimePlaybackResume}
              onTeacherChange={handleTeacherChange}
            />
          ) : null}

          {liveCourseSession ? (
            <ClassroomSessionBar
              onPlayPause={() => void handlePlayPause()}
              onRetryCurrentNode={requestRetryCurrentNode}
              playbackError={playbackError}
              controlError={classroomControlError}
              playbackIdle={engineMode === 'idle'}
              starting={startingTeaching}
              feedbackBusy={checkpointFeedbackBusy}
              onPrepareLeave={async () => {
                clearAutoAdvanceTimer();
                const session = liveCourseSessionRef.current;
                const engine = engineRef.current;
                if (
                  engine?.getMode() === 'playing' &&
                  session &&
                  (session.classroomState === 'teaching' || session.classroomState === 'checking')
                ) {
                  saveSceneResumePosition(currentScene?.id, currentPlaybackActionIndexRef.current);
                  await runTeachingControl('pause', engine, session);
                }
              }}
              onStartRelisten={startInClassRelisten}
              onEndRelisten={endInClassRelisten}
            />
          ) : null}
        </div>

        {/* ChatArea stays mounted for lecture buffers; the classroom shell does not show a chat rail. */}
        <div className="hidden" aria-hidden>
          {liveCourseSession ? (
            <ChatArea
              ref={chatAreaRef}
              embedded
              presentationOnly={presentationOnly}
              presentationStore={playbackStore}
              activeBubbleId={activeBubbleId}
              onActiveBubble={(id) => setActiveBubbleId(id)}
              currentSceneId={currentSceneId}
              currentActionIndex={currentPlaybackActionIndex}
              canJumpToAction={canJumpToAction}
              onJumpToAction={(sceneId, actionIndex) => {
                void handleJumpToAction(sceneId, actionIndex);
              }}
              onLiveSpeech={
                presentationOnly
                  ? undefined
                  : (text, agentId) => {
                      // Capture epoch at call time — discard if scene has changed since
                      const epoch = sceneEpochRef.current;
                      // Use queueMicrotask to let any pending scene-switch reset settle first
                      queueMicrotask(() => {
                        if (sceneEpochRef.current !== epoch) return; // stale — scene changed
                        setLiveSpeech(text);
                        if (agentId !== undefined) {
                          setSpeakingAgentId(agentId);
                        }
                        if (text !== null || agentId) {
                          setChatIsStreaming(true);
                          setChatSessionType(chatAreaRef.current?.getActiveSessionType?.() ?? null);
                          setIsTopicPending(false);
                        } else if (text === null && agentId === null) {
                          setChatIsStreaming(false);
                          // Don't clear chatSessionType here — it's needed by the stop
                          // button when director cues user (cue_user → done → liveSpeech null).
                          // It gets properly cleared in doSessionCleanup and scene change.
                        }
                      });
                    }
              }
              onSpeechProgress={
                presentationOnly
                  ? undefined
                  : (ratio) => {
                      const epoch = sceneEpochRef.current;
                      queueMicrotask(() => {
                        if (sceneEpochRef.current !== epoch) return;
                        setSpeechProgress(ratio);
                      });
                    }
              }
              onThinking={
                presentationOnly
                  ? undefined
                  : (state) => {
                      const epoch = sceneEpochRef.current;
                      queueMicrotask(() => {
                        if (sceneEpochRef.current !== epoch) return;
                        setThinkingState(state);
                      });
                    }
              }
              onCueUser={
                presentationOnly
                  ? undefined
                  : () => {
                      setIsCueUser(true);
                    }
              }
              onLiveSessionError={presentationOnly ? undefined : handleLiveSessionError}
              onSoftCloseSession={
                presentationOnly
                  ? undefined
                  : () => {
                      setThinkingState(null);
                      setSpeechProgress(null);
                      setIsCueUser(false);
                      setActiveBubbleId(null);
                    }
              }
              onSoftClosingChange={
                presentationOnly
                  ? undefined
                  : (softClosing, deadline) => {
                      setChatIsSoftClosing(softClosing);
                      setSoftCloseDeadline(deadline);
                    }
              }
              onStopSession={presentationOnly ? undefined : handleSessionStop}
              onSegmentSealed={presentationOnly ? undefined : discussionTTS.handleSegmentSealed}
              shouldHoldAfterReveal={presentationOnly ? undefined : discussionTTS.shouldHold}
            />
          ) : (
            <ChatArea
              ref={chatAreaRef}
              presentationOnly={presentationOnly}
              presentationStore={playbackStore}
              width={chatAreaWidth}
              onWidthChange={setChatAreaWidth}
              collapsed={chatAreaCollapsed}
              onCollapseChange={setChatAreaCollapsed}
              activeBubbleId={activeBubbleId}
              onActiveBubble={(id) => setActiveBubbleId(id)}
              currentSceneId={currentSceneId}
              currentActionIndex={currentPlaybackActionIndex}
              canJumpToAction={canJumpToAction}
              onJumpToAction={(sceneId, actionIndex) => {
                void handleJumpToAction(sceneId, actionIndex);
              }}
              onLiveSpeech={
                presentationOnly
                  ? undefined
                  : (text, agentId) => {
                      // Capture epoch at call time — discard if scene has changed since
                      const epoch = sceneEpochRef.current;
                      // Use queueMicrotask to let any pending scene-switch reset settle first
                      queueMicrotask(() => {
                        if (sceneEpochRef.current !== epoch) return; // stale — scene changed
                        setLiveSpeech(text);
                        if (agentId !== undefined) {
                          setSpeakingAgentId(agentId);
                        }
                        if (text !== null || agentId) {
                          setChatIsStreaming(true);
                          setChatSessionType(chatAreaRef.current?.getActiveSessionType?.() ?? null);
                          setIsTopicPending(false);
                        } else if (text === null && agentId === null) {
                          setChatIsStreaming(false);
                          // Don't clear chatSessionType here — it's needed by the stop
                          // button when director cues user (cue_user → done → liveSpeech null).
                          // It gets properly cleared in doSessionCleanup and scene change.
                        }
                      });
                    }
              }
              onSpeechProgress={
                presentationOnly
                  ? undefined
                  : (ratio) => {
                      const epoch = sceneEpochRef.current;
                      queueMicrotask(() => {
                        if (sceneEpochRef.current !== epoch) return;
                        setSpeechProgress(ratio);
                      });
                    }
              }
              onThinking={
                presentationOnly
                  ? undefined
                  : (state) => {
                      const epoch = sceneEpochRef.current;
                      queueMicrotask(() => {
                        if (sceneEpochRef.current !== epoch) return;
                        setThinkingState(state);
                      });
                    }
              }
              onCueUser={
                presentationOnly
                  ? undefined
                  : (_fromAgentId, _prompt) => {
                      setIsCueUser(true);
                    }
              }
              onLiveSessionError={presentationOnly ? undefined : handleLiveSessionError}
              onSoftCloseSession={
                presentationOnly
                  ? undefined
                  : () => {
                      setThinkingState(null);
                      setSpeechProgress(null);
                      setIsCueUser(false);
                      setActiveBubbleId(null);
                    }
              }
              onSoftClosingChange={
                presentationOnly
                  ? undefined
                  : (softClosing, deadline) => {
                      setChatIsSoftClosing(softClosing);
                      setSoftCloseDeadline(deadline);
                    }
              }
              onStopSession={presentationOnly ? undefined : handleSessionStop}
              onSegmentSealed={presentationOnly ? undefined : discussionTTS.handleSegmentSealed}
              shouldHoldAfterReveal={presentationOnly ? undefined : discussionTTS.shouldHold}
            />
          )}
        </div>

        {/* Scene switch confirmation dialog */}
        <AlertDialog
          open={!!pendingSceneId}
          onOpenChange={(open) => {
            if (!open && !sceneSwitchConfirmingRef.current) cancelSceneSwitch();
          }}
        >
          <AlertDialogContent
            container={isPresenting ? stageRef.current : undefined}
            className="max-w-sm rounded-2xl p-0 overflow-hidden border-0 shadow-[0_25px_60px_-12px_rgba(0,0,0,0.15)] dark:shadow-[0_25px_60px_-12px_rgba(0,0,0,0.5)]"
          >
            <VisuallyHidden.Root>
              <AlertDialogTitle>{t('stage.confirmSwitchTitle')}</AlertDialogTitle>
            </VisuallyHidden.Root>
            {/* Top accent bar */}
            <div className="h-1 bg-gradient-to-r from-amber-400 via-orange-400 to-red-400" />

            <div className="px-6 pt-5 pb-2 flex flex-col items-center text-center">
              {/* Icon */}
              <div className="w-12 h-12 rounded-full bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center mb-4 ring-1 ring-amber-200/50 dark:ring-amber-700/30">
                <AlertTriangle className="w-6 h-6 text-amber-500 dark:text-amber-400" />
              </div>
              {/* Title */}
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 mb-1.5">
                {t('stage.confirmSwitchTitle')}
              </h3>
              {/* Description */}
              <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
                {t('stage.confirmSwitchMessage')}
              </p>
            </div>

            <AlertDialogFooter className="px-6 pb-5 pt-3 flex-row gap-3">
              <AlertDialogCancel onClick={cancelSceneSwitch} className="flex-1 rounded-xl">
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmSceneSwitch}
                className="flex-1 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white border-0 shadow-md shadow-amber-200/50 dark:shadow-amber-900/30"
              >
                {t('common.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  },
);
