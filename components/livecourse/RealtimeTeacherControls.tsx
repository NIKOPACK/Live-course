'use client';

import { useCallback, useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import {
  CircleStop,
  LoaderCircle,
  Mic,
  MicOff,
  MoreHorizontal,
  Power,
  Quote,
  Radio,
  Send,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/hooks/use-i18n';
import { nodeIdForScene, teachingActionSchema } from '@/lib/livecourse/domain';
import {
  RealtimeAudioBridge,
  registerRealtimeAudioBridge,
} from '@/lib/livecourse/realtime/client/audio-bridge';
import {
  LiveCourseRealtimeSession,
  RealtimeInterruptionUncertaintyError,
  type RealtimeClassroomLocation,
  type RealtimeTeacherEvent,
  type RealtimeTeacherStatus,
} from '@/lib/livecourse/realtime/client/session';
import { VolcTeacherSpeechSession } from '@/lib/livecourse/realtime/client/volc-teacher-speech';
import { selectClassroomRealtimeTransport } from '@/lib/livecourse/realtime/client/select-transport';
import { RealtimePlaybackControlError } from '@/lib/livecourse/session/realtime-playback-control';
import type { RealtimeTeachingCommand } from '@/lib/livecourse/realtime/contracts';
import {
  useLiveCourseSessionOptional,
  type TeachingActionInput,
} from '@/lib/livecourse/session/context';
import { readClassroomActionAuthority } from '@/lib/livecourse/session/controller';
import { resolveRealtimeClientApiKey } from '@/lib/livecourse/realtime/providers';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { useLiveCaptionStore } from '@/lib/store/live-caption';
import type { SpeechAction } from '@/lib/types/action';
import type { TeacherSpeechPort } from '@/lib/livecourse/realtime/client/teacher-speech';
import { cn } from '@/lib/utils';
import { createBrowserUuid } from '@/lib/utils/random-id';
import { useHtmlQuestionContext } from '@/lib/livecourse/html/question-context';
import { hasHtmlTeacherBridge } from '@/lib/livecourse/html/teacher-bridge';
import type { OralQuestionState } from '@/lib/livecourse/realtime/client/oral-question';
import { formatTeacherResumeContext } from '@/lib/livecourse/realtime/teacher-instructions';
import type { PlaybackSpeechContext } from '@/lib/playback/types';

const MAX_QUESTION_LENGTH = 2000;

export type RealtimePlaybackHandler = (nodeId: string) => void | Promise<void>;

type InterruptionTransactionPhase =
  | 'idle'
  | 'interrupt-commit-pending'
  | 'held'
  | 'playback-release-only'
  | 'resume-compensation-pending';

function createInterruptionKey(): string {
  return `realtime:interrupt:${createBrowserUuid()}`;
}

function commandToActionInput(command: RealtimeTeachingCommand): TeachingActionInput {
  const validated = teachingActionSchema.parse({
    schemaVersion: 1,
    id: 'realtime-command-validation',
    courseId: 'realtime-command-validation',
    lessonId: 'realtime-command-validation',
    nodeId: command.nodeId,
    sequence: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    idempotencyKey: command.idempotencyKey,
    type: command.type,
    payload: command.payload,
  });
  return {
    type: validated.type,
    payload: validated.payload,
    nodeId: validated.nodeId,
    idempotencyKey: validated.idempotencyKey,
  } as TeachingActionInput;
}

function statusLabelKey(
  status: RealtimeTeacherStatus,
  speaking: boolean,
  activeTool: string | null,
): string {
  if (status === 'connecting') return 'livecourse.voiceConnecting';
  if (status === 'unconfigured') return 'livecourse.voiceUnconfigured';
  if (status === 'error') return 'livecourse.voiceFailed';
  if (status !== 'connected') return 'livecourse.voiceDisconnected';
  if (activeTool) return 'livecourse.voiceActing';
  return speaking ? 'livecourse.teacherSpeaking' : 'livecourse.voiceConnected';
}

function IconButton({ label, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          title={label}
          size="icon"
          variant="ghost"
          className="size-11 shrink-0"
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export interface RealtimeTeacherControlsProps {
  tone?: 'default' | 'lectern';
  /** Freeze the independent lesson PlaybackEngine at the interruption point. */
  onPlaybackInterrupt?: RealtimePlaybackHandler;
  /** Release the frozen PlaybackEngine position after the teacher resumes. */
  onPlaybackResume?: RealtimePlaybackHandler;
  getPlaybackSpeechContext?: () => PlaybackSpeechContext | null;
  onTeacherChange?: (teacher: TeacherSpeechPort | null) => void;
}

export function RealtimeTeacherControls({
  tone = 'default',
  onPlaybackInterrupt,
  onPlaybackResume,
  getPlaybackSpeechContext,
  onTeacherChange,
}: RealtimeTeacherControlsProps) {
  const { t } = useI18n();
  const translateRef = useRef(t);
  translateRef.current = t;
  const lectern = tone === 'lectern';
  const livecourse = useLiveCourseSessionOptional();
  const currentScene = useStageStore((state) => state.getCurrentScene());
  const audioRef = useRef<HTMLAudioElement>(null);
  const realtimeRef = useRef<LiveCourseRealtimeSession | VolcTeacherSpeechSession | null>(null);
  const audioBridgeRef = useRef<RealtimeAudioBridge | null>(null);
  const unregisterAudioBridgeRef = useRef<(() => void) | null>(null);
  const emitActionRef = useRef(livecourse?.emitAction);
  const playbackInterruptRef = useRef(onPlaybackInterrupt);
  const playbackResumeRef = useRef(onPlaybackResume);
  const playbackSpeechContextRef = useRef(getPlaybackSpeechContext);
  playbackSpeechContextRef.current = getPlaybackSpeechContext;
  const classroomStateRef = useRef(livecourse?.classroomState);
  const interruptionKeyRef = useRef<string | null>(null);
  const interruptionResumeAttemptRef = useRef(0);
  const interruptionPhaseRef = useRef<InterruptionTransactionPhase>('idle');
  const locationRef = useRef<RealtimeClassroomLocation | null>(null);
  const teachingContextRef = useRef('');
  const [status, setStatus] = useState<RealtimeTeacherStatus>('idle');
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [oralQuestion, setOralQuestion] = useState<OralQuestionState | null>(null);
  const oralQuestionRef = useRef<OralQuestionState | null>(null);
  const oralEpochRef = useRef(0);
  const [oralAnswer, setOralAnswer] = useState('');
  const questionInputRef = useRef<HTMLTextAreaElement>(null);
  const questionInputId = useId();
  const questionHintId = useId();
  const [sendingQuestion, setSendingQuestion] = useState(false);
  const sendingQuestionRef = useRef(false);
  /** J3.2：冻结中的 resumeNode；识别失败提示重说时据此判断。 */
  const [pendingInterruption, setPendingInterruption] = useState<string | null>(null);
  const pendingInterruptionRef = useRef<string | null>(null);
  pendingInterruptionRef.current = pendingInterruption;
  const [audioElementGeneration, setAudioElementGeneration] = useState(0);

  const currentNodeId = livecourse?.currentNodeId ?? null;
  const currentSceneId = currentScene?.id ?? null;
  const quote = useHtmlQuestionContext((state) =>
    state.quote?.sceneId === currentSceneId ? state.quote : null,
  );
  const supportsSelection =
    currentScene?.content.type === 'interactive' &&
    hasHtmlTeacherBridge(currentScene.content.html ?? '');

  const currentNode = livecourse?.lessonPlan?.nodes.find((node) => node.id === currentNodeId);
  const currentGoal = livecourse?.lessonPlan?.goals.find((goal) =>
    currentNode?.goalIds.includes(goal.id),
  );
  // A1：持久化教案节点带讲授设计；预设提问仅作准备，学生没问不主动念。
  const nodeDesign = currentNode?.design;
  const nodeDesignContext = nodeDesign
    ? [
        `Lesson design for this node:`,
        `Teaching points: ${nodeDesign.teachingPoints.join(' / ')}`,
        `Explanation plan: ${nodeDesign.explanationPlan}`,
        nodeDesign.anticipatedQuestions?.length
          ? `Anticipated student questions (background only — never recite the Q/A pair; answer the actual learner directly):\n${nodeDesign.anticipatedQuestions.map((qa) => `- Q: ${qa.question}\n  A: ${qa.response}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const sceneSpeech =
    currentScene?.actions
      ?.filter((action): action is SpeechAction => action.type === 'speech')
      .map((action) => action.text)
      .join('\n')
      .slice(0, 4_000) ?? '';
  // A6: the provider exposes one bounded, scope-filtered projection.  Keep
  // the immediate node/scene facts first; memory is advisory context and is
  // never assembled from raw C/L records in this component.
  const memoryTeacherContext = livecourse?.teacherContext?.text.trim() ?? '';
  const teachingContext = [
    currentNode ? `Current lesson node: ${currentNode.id} (${currentNode.type}).` : '',
    currentScene ? `Current scene: ${currentScene.title || currentScene.id}.` : '',
    currentGoal ? `Current learning goal: ${currentGoal.title}. ${currentGoal.description}` : '',
    currentNode?.type === 'checkpoint'
      ? 'This is a checkpoint. After answering an interruption, stay with this same question and wait for the learner submission.'
      : '',
    nodeDesignContext,
    sceneSpeech ? `Prepared teaching content:\n${sceneSpeech}` : '',
    memoryTeacherContext
      ? `Bounded learning memory (current classroom facts above take precedence):\n${memoryTeacherContext}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  useEffect(() => {
    emitActionRef.current = livecourse?.emitAction;
    playbackInterruptRef.current = onPlaybackInterrupt;
    playbackResumeRef.current = onPlaybackResume;
    classroomStateRef.current = livecourse?.classroomState;
    locationRef.current = currentSceneId
      ? {
          nodeId: currentNodeId ?? nodeIdForScene(currentSceneId),
          sceneId: currentSceneId,
        }
      : null;
    teachingContextRef.current = teachingContext;
  }, [
    currentNodeId,
    currentSceneId,
    livecourse?.classroomState,
    livecourse?.emitAction,
    onPlaybackInterrupt,
    onPlaybackResume,
    teachingContext,
  ]);

  const emitAvatarAction = useCallback(
    (input: TeachingActionInput) => {
      const state = classroomStateRef.current;
      if (!['teaching', 'checking', 'interrupted'].includes(state ?? '')) return;
      // The classroom engine owns authored speech boundaries; only learner
      // answers need a separate avatar action from the transport.
      if (onTeacherChange && state !== 'interrupted' && !oralQuestionRef.current) return;
      void emitActionRef.current?.(input).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [onTeacherChange],
  );

  const handleEvent = useCallback(
    (event: RealtimeTeacherEvent) => {
      switch (event.type) {
        case 'oral_question':
          if (Boolean(event.state) !== Boolean(oralQuestionRef.current)) oralEpochRef.current += 1;
          oralQuestionRef.current = event.state;
          setOralQuestion(event.state);
          if (!event.state) setOralAnswer('');
          break;
        case 'status':
          setStatus(event.status);
          if (event.status === 'closed' || event.status === 'error') {
            useLiveCaptionStore.getState().clearCaption();
          }
          break;
        case 'transcript':
          // J3.1/J3.2 实时字幕：只读投影，不进课堂状态机（docs/spec/02 课堂）。
          useLiveCaptionStore.getState().setCaption({ speaker: event.speaker, text: event.text });
          break;
        case 'audio_start':
          setSpeaking(true);
          // A successful retry produces a new response; the old recognition
          // error is no longer actionable once the teacher starts answering.
          if (pendingInterruptionRef.current) setError(null);
          emitAvatarAction({
            type: 'avatar.speech_start',
            payload: { text: 'Realtime voice response' },
          });
          break;
        case 'audio_stopped':
        case 'audio_interrupted':
          setSpeaking(false);
          emitAvatarAction({ type: 'avatar.speech_end', payload: {} });
          break;
        case 'tool_start':
          setActiveTool(event.name);
          break;
        case 'tool_end':
          setActiveTool((current) => (current === event.name ? null : current));
          break;
        case 'muted':
          setMuted(event.muted);
          break;
        case 'interrupted':
          // The session owns the ordered playback/W transaction. This event is
          // the read-side signal used to expose the held resume point in UI.
          pendingInterruptionRef.current = event.nodeId;
          setPendingInterruption(event.nodeId);
          break;
        case 'node_resumed':
          pendingInterruptionRef.current = null;
          setPendingInterruption(null);
          interruptionKeyRef.current = null;
          interruptionResumeAttemptRef.current = 0;
          interruptionPhaseRef.current = 'idle';
          setError(null);
          break;
        case 'recognition_failed':
          setError(event.nodeId ? t('livecourse.realtimeRecognitionFailed') : event.error.message);
          break;
        case 'interruption_failed':
          pendingInterruptionRef.current = null;
          setPendingInterruption(null);
          interruptionKeyRef.current = null;
          interruptionResumeAttemptRef.current = 0;
          interruptionPhaseRef.current = 'idle';
          setError(event.error.message);
          break;
        case 'interruption_uncertain':
          pendingInterruptionRef.current = event.nodeId;
          setPendingInterruption(event.nodeId);
          setError(t('livecourse.realtimeInterruptionPending'));
          break;
        case 'error':
          setError(event.error.message);
          break;
      }
    },
    [emitAvatarAction, t],
  );

  const start = useCallback(async () => {
    if (!livecourse?.learnerId || !audioRef.current || !locationRef.current) {
      throw new Error('Classroom voice is not ready');
    }
    setError(null);
    // Do not await the network on the user-gesture path if Volc is already known.
    // Firefox drops the gesture after the first await, then AudioContext.resume hangs.
    let transport = selectClassroomRealtimeTransport(useSettingsStore.getState());
    if (!transport) {
      await useSettingsStore.getState().fetchServerProviders();
      transport = selectClassroomRealtimeTransport(useSettingsStore.getState());
    }
    if (!transport) {
      throw new Error(t('livecourse.voiceRequired'));
    }

    let realtime = realtimeRef.current;
    let audioBridge = audioBridgeRef.current;
    if (realtime && transport === 'volc' && !(realtime instanceof VolcTeacherSpeechSession)) {
      await realtime.close().catch(() => undefined);
      realtimeRef.current = null;
      audioBridgeRef.current = null;
      unregisterAudioBridgeRef.current?.();
      unregisterAudioBridgeRef.current = null;
      realtime = null;
      audioBridge = null;
    }
    const preferVolc = transport === 'volc';
    const getLocation = () => locationRef.current;
    const getTeachingContext = () => {
      const playback = playbackSpeechContextRef.current?.();
      const resumeContext = formatTeacherResumeContext(
        playback?.sceneId === locationRef.current?.sceneId ? (playback ?? null) : null,
      );
      return [resumeContext, teachingContextRef.current].filter(Boolean).join('\n');
    };
    const canInterrupt = () => {
      const state = classroomStateRef.current;
      return state === 'teaching' || state === 'checking' || state === 'interrupted';
    };
    const interruptNode = async (nodeId: string) => {
      const interruptPlayback = playbackInterruptRef.current;
      const resumePlayback = playbackResumeRef.current;
      if (Boolean(interruptPlayback) !== Boolean(resumePlayback)) {
        throw new Error('Realtime playback interrupt and resume handlers must be paired');
      }
      if (interruptionPhaseRef.current !== 'idle') {
        throw new Error('A realtime interruption transaction is already active');
      }
      const interruptionKey = createInterruptionKey();
      interruptionKeyRef.current = interruptionKey;
      interruptionResumeAttemptRef.current = 0;
      let playbackTransitionStarted = false;
      try {
        if (interruptPlayback) {
          try {
            await interruptPlayback(nodeId);
            playbackTransitionStarted = true;
          } catch (cause) {
            // freezeRealtimePlayback normally restores the local sides
            // before surfacing an ordinary operation failure. A
            // RealtimePlaybackControlError means that at least one
            // inverse failed after a partial mutation, so the release
            // compensation below must still be attempted.
            playbackTransitionStarted = cause instanceof RealtimePlaybackControlError;
            throw cause;
          }
        }
        interruptionPhaseRef.current = 'interrupt-commit-pending';
        const emitAction = emitActionRef.current;
        if (!emitAction) throw new Error('LiveCourse session is not ready');
        await emitAction({
          type: 'lesson.interrupt',
          nodeId,
          idempotencyKey: interruptionKey,
          payload: {},
        });
        interruptionPhaseRef.current = 'held';
      } catch (cause) {
        const authority = readClassroomActionAuthority(cause);
        if (authority === 'uncertain' || authority === 'committed') {
          interruptionPhaseRef.current = 'interrupt-commit-pending';
          throw new RealtimeInterruptionUncertaintyError(nodeId, cause);
        }
        if (playbackTransitionStarted && resumePlayback) {
          try {
            await resumePlayback(nodeId);
          } catch (compensationCause) {
            interruptionPhaseRef.current = 'playback-release-only';
            throw new RealtimeInterruptionUncertaintyError(
              nodeId,
              new AggregateError(
                [cause, compensationCause],
                'Classroom interruption failed and playback could not be restored',
              ),
            );
          }
        }
        interruptionKeyRef.current = null;
        interruptionResumeAttemptRef.current = 0;
        interruptionPhaseRef.current = 'idle';
        throw cause;
      }
    };
    const resumeNode = async (nodeId: string) => {
      const emitAction = emitActionRef.current;
      if (!emitAction) throw new Error('LiveCourse session is not ready');
      const interruptionKey = interruptionKeyRef.current;
      if (!interruptionKey || interruptionPhaseRef.current === 'idle') {
        throw new Error('No realtime interruption transaction is available to resume');
      }

      if (interruptionPhaseRef.current === 'playback-release-only') {
        await playbackResumeRef.current?.(nodeId);
        interruptionKeyRef.current = null;
        interruptionResumeAttemptRef.current = 0;
        interruptionPhaseRef.current = 'idle';
        return;
      }

      if (interruptionPhaseRef.current === 'interrupt-commit-pending') {
        try {
          await emitAction({
            type: 'lesson.interrupt',
            nodeId,
            idempotencyKey: interruptionKey,
            payload: {},
          });
          interruptionPhaseRef.current = 'held';
        } catch (cause) {
          const authority = readClassroomActionAuthority(cause);
          if (authority === 'uncertain' || authority === 'committed') {
            throw new RealtimeInterruptionUncertaintyError(nodeId, cause);
          }
          throw cause;
        }
      }

      if (interruptionPhaseRef.current === 'resume-compensation-pending') {
        // Retry exactly the compensation action whose outcome was lost.
        // Only a confirmed append advances the attempt number.
        await emitAction({
          type: 'lesson.interrupt',
          nodeId,
          idempotencyKey: `${interruptionKey}:compensate:${interruptionResumeAttemptRef.current}`,
          payload: {},
        });
        interruptionPhaseRef.current = 'held';
        interruptionResumeAttemptRef.current += 1;
        throw new Error('Interruption restored; retry the learner response to resume');
      }

      const resumeKey = `${interruptionKey}:resume:${interruptionResumeAttemptRef.current}`;
      // J3.2：回答结束后唯一回到被冻结 resumeNode 的显式恢复命令。
      await emitAction({
        type: 'lesson.resume_interrupted',
        nodeId,
        idempotencyKey: resumeKey,
        payload: { targetNodeId: nodeId },
      });
      try {
        await playbackResumeRef.current?.(nodeId);
      } catch (cause) {
        try {
          await emitAction({
            type: 'lesson.interrupt',
            nodeId,
            idempotencyKey: `${interruptionKey}:compensate:${interruptionResumeAttemptRef.current}`,
            payload: {},
          });
          interruptionPhaseRef.current = 'held';
          interruptionResumeAttemptRef.current += 1;
        } catch (compensationCause) {
          interruptionPhaseRef.current = 'resume-compensation-pending';
          throw new AggregateError(
            [cause, compensationCause],
            'Classroom resume failed and the interruption could not be restored',
          );
        }
        throw cause;
      }
      interruptionKeyRef.current = null;
      interruptionResumeAttemptRef.current = 0;
      interruptionPhaseRef.current = 'idle';
    };
    if (!realtime && preferVolc) {
      realtime = new VolcTeacherSpeechSession({
        getInstructions: getTeachingContext,
        onEvent: handleEvent,
        getLocation,
        canInterrupt,
        interruptNode,
        resumeNode,
      });
      realtimeRef.current = realtime;
    }
    if (!realtime) {
      audioBridge = new RealtimeAudioBridge(audioRef.current);
      realtime = new LiveCourseRealtimeSession({
        courseId: livecourse.courseId,
        lessonId: livecourse.lessonId,
        learnerId: livecourse.learnerId,
        getClientSecretApiKey: () =>
          resolveRealtimeClientApiKey('openai', useSettingsStore.getState()),
        audioBridge,
        getLocation,
        getTeachingContext,
        dispatchCommand: async (command) => {
          const emitAction = emitActionRef.current;
          if (!emitAction) throw new Error('LiveCourse session is not ready');
          await emitAction(commandToActionInput(command));
        },
        canInterrupt,
        interruptNode,
        resumeNode,
        onEvent: handleEvent,
      });
      realtimeRef.current = realtime;
      audioBridgeRef.current = audioBridge;
    }

    await realtime.connect();
    if (realtimeRef.current !== realtime) {
      await realtime.close();
      throw new Error('Classroom voice connection changed');
    }
    if (realtime instanceof LiveCourseRealtimeSession) {
      if (!audioBridge) {
        throw new Error('Realtime audio bridge is unavailable');
      }
      if (audioBridgeRef.current !== audioBridge) {
        await realtime.close();
        throw new Error('Classroom voice connection changed');
      }
      unregisterAudioBridgeRef.current ??= registerRealtimeAudioBridge(audioBridge);
    }
  }, [handleEvent, livecourse]);

  const startRef = useRef(start);
  startRef.current = start;
  const stopRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    const teacher: TeacherSpeechPort = {
      question: async (question, options) => {
        const realtime = realtimeRef.current;
        if (!realtime?.connected) throw new Error(translateRef.current('livecourse.voiceRequired'));
        await realtime.question(question, options);
      },
      connect: () => startRef.current(),
      close: () => stopRef.current(),
      speak: (text, options) => {
        const realtime = realtimeRef.current;
        if (!realtime?.connected)
          return Promise.reject(new Error(translateRef.current('livecourse.voiceRequired')));
        const captions = useLiveCaptionStore.getState();
        captions.holdCaption();
        return realtime.speak(text, options).finally(() => {
          captions.releaseCaption();
        });
      },
      ask: async (text) => {
        const captions = useLiveCaptionStore.getState();
        captions.holdCaption();
        try {
          await startRef.current();
          const realtime = realtimeRef.current;
          if (!realtime?.connected)
            throw new Error(translateRef.current('livecourse.voiceRequired'));
          await realtime.ask(text);
        } finally {
          captions.releaseCaption();
        }
      },
    };
    onTeacherChange?.(teacher);
    return () => onTeacherChange?.(null);
  }, [onTeacherChange]);

  const sendQuestion = async () => {
    const text = (oralQuestion ? oralAnswer : question).trim();
    if (!canAsk || !text || sendingQuestionRef.current) return;
    const location = locationRef.current;
    const oralEpoch = oralEpochRef.current;
    const message =
      quote && !oralQuestion
        ? t('livecourse.quotedQuestion', { quote: quote.text, question: text })
        : text;
    sendingQuestionRef.current = true;
    setSendingQuestion(true);
    setError(null);
    try {
      await start();
      const current = locationRef.current;
      if (
        !location ||
        current?.nodeId !== location.nodeId ||
        current.sceneId !== location.sceneId ||
        oralEpoch !== oralEpochRef.current ||
        !['teaching', 'checking', 'interrupted'].includes(classroomStateRef.current ?? '')
      ) {
        throw new Error(t('livecourse.questionContextChanged'));
      }
      const realtime = realtimeRef.current;
      if (!realtime) throw new Error(t('livecourse.voiceRequired'));
      await realtime.ask(message);
      if (oralQuestion) setOralAnswer((current) => (current.trim() === text ? '' : current));
      else {
        setQuestion((current) => (current.trim() === text ? '' : current));
        if (quote) useHtmlQuestionContext.getState().clearQuote(quote);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sendingQuestionRef.current = false;
      setSendingQuestion(false);
    }
  };

  const runOralControl = async (
    operation: 'hintOralQuestion' | 'retryOralQuestion' | 'endOralQuestion',
  ) => {
    if (sendingQuestionRef.current || !canUseOral) return;
    sendingQuestionRef.current = true;
    setSendingQuestion(true);
    setError(null);
    try {
      const realtime = realtimeRef.current;
      if (!realtime) throw new Error(t('livecourse.voiceRequired'));
      await realtime[operation]();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sendingQuestionRef.current = false;
      setSendingQuestion(false);
    }
  };

  const stop = useCallback(async () => {
    const realtime = realtimeRef.current;
    const audioBridge = audioBridgeRef.current;
    const unregisterAudioBridge = unregisterAudioBridgeRef.current;
    unregisterAudioBridgeRef.current = null;
    unregisterAudioBridge?.();
    try {
      if (realtime) await realtime.close();
    } catch (cause) {
      if (realtimeRef.current === realtime && audioBridge) {
        unregisterAudioBridgeRef.current ??= registerRealtimeAudioBridge(audioBridge);
      }
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setError(error.message);
      throw error;
    }
    if (realtimeRef.current !== realtime) return;
    realtimeRef.current = null;
    audioBridgeRef.current = null;
    setAudioElementGeneration((generation) => generation + 1);
    setStatus('idle');
    setMuted(false);
    setSpeaking(false);
    setActiveTool(null);
    pendingInterruptionRef.current = null;
    setPendingInterruption(null);
    interruptionKeyRef.current = null;
    interruptionResumeAttemptRef.current = 0;
    interruptionPhaseRef.current = 'idle';
    setError(null);
  }, []);
  stopRef.current = stop;

  useEffect(
    () => () => {
      const realtime = realtimeRef.current;
      realtimeRef.current = null;
      audioBridgeRef.current = null;
      const unregisterAudioBridge = unregisterAudioBridgeRef.current;
      unregisterAudioBridgeRef.current = null;
      unregisterAudioBridge?.();
      useLiveCaptionStore.getState().clearCaption();
      void realtime?.close().catch((cause) => {
        console.warn('[LiveCourse] Failed to close classroom voice', cause);
      });
    },
    [],
  );

  const connected = status === 'connected';
  const canStart = livecourse?.status === 'ready' && Boolean(currentSceneId);
  const canUseOral = canStart && livecourse?.classroomState === 'teaching';
  const canAsk =
    canStart &&
    (!oralQuestion || oralQuestion.phase === 'waiting') &&
    (livecourse?.classroomState === 'teaching' ||
      livecourse?.classroomState === 'checking' ||
      livecourse?.classroomState === 'interrupted');
  const label = t(statusLabelKey(status, speaking, activeTool));
  const draft = oralQuestion ? oralAnswer : question;
  const questionHint =
    !canAsk && livecourse?.classroomState === 'paused'
      ? t('livecourse.questionPausedHint')
      : oralQuestion
        ? t('livecourse.oralInputHint')
        : supportsSelection
          ? t('livecourse.questionSelectionHint')
          : t('livecourse.questionDraftHint');
  const toggleMicrophone = () => {
    try {
      realtimeRef.current?.mute(!muted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const interruptTeacher = () => {
    try {
      realtimeRef.current?.interrupt();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const quickQuestions = [
    { label: t('livecourse.questionRephrase'), prompt: t('livecourse.questionRephrasePrompt') },
    { label: t('livecourse.questionExample'), prompt: t('livecourse.questionExamplePrompt') },
    { label: t('livecourse.questionHint'), prompt: t('livecourse.questionHintPrompt') },
  ];

  useEffect(() => {
    const input = questionInputRef.current;
    if (!lectern || !input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(144, Math.max(72, input.scrollHeight))}px`;
  }, [draft, lectern]);

  return (
    <div className={cn(lectern ? 'lc-teacher-controls' : 'px-0 py-2')}>
      <audio key={audioElementGeneration} ref={audioRef} className="hidden" autoPlay playsInline />
      <div className={cn('flex min-h-11 items-center gap-2', !lectern && 'flex-wrap')}>
        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full',
            status === 'connected'
              ? 'bg-primary'
              : status === 'connecting'
                ? 'bg-amber-500'
                : status === 'error' || status === 'unconfigured'
                  ? 'bg-destructive'
                  : 'bg-muted-foreground',
          )}
        />
        <span
          role="status"
          className={cn(
            'min-w-0 flex-1 text-xs font-medium leading-5 [overflow-wrap:anywhere]',
            status === 'error' || status === 'unconfigured'
              ? 'text-destructive'
              : lectern
                ? 'text-[var(--lc-classroom-ink-dim)]'
                : 'text-muted-foreground',
          )}
          title={error ?? label}
        >
          {label}
        </span>

        {status === 'connecting' ? (
          <LoaderCircle
            className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : connected && lectern ? (
          <>
            <Button
              type="button"
              variant="ghost"
              className="h-11 gap-1.5 rounded-lg px-2 text-xs"
              aria-label={t(muted ? 'livecourse.voiceUnmute' : 'livecourse.voiceMute')}
              aria-pressed={muted}
              onClick={toggleMicrophone}
            >
              {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
              {t(muted ? 'livecourse.microphoneOff' : 'livecourse.microphoneOn')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-11 rounded-lg"
                  aria-label={t('livecourse.voiceMore')}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="min-w-48 rounded-xl p-1.5">
                <DropdownMenuItem
                  className="min-h-11 rounded-lg"
                  disabled={!speaking}
                  onSelect={interruptTeacher}
                >
                  <CircleStop aria-hidden="true" />
                  {t('livecourse.voiceInterrupt')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11 rounded-lg"
                  onSelect={() => void stop().catch(() => undefined)}
                >
                  <Power aria-hidden="true" />
                  {t('livecourse.voiceDisconnect')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : connected ? (
          <>
            <IconButton
              label={t(muted ? 'livecourse.voiceUnmute' : 'livecourse.voiceMute')}
              aria-pressed={muted}
              onClick={toggleMicrophone}
            >
              {muted ? <MicOff /> : <Mic />}
            </IconButton>
            <IconButton
              label={t('livecourse.voiceInterrupt')}
              disabled={!speaking}
              onClick={interruptTeacher}
            >
              <CircleStop />
            </IconButton>
            <IconButton
              label={t('livecourse.voiceDisconnect')}
              onClick={() => void stop().catch(() => undefined)}
            >
              <Power />
            </IconButton>
          </>
        ) : lectern ? (
          <Button
            type="button"
            variant="secondary"
            className="h-11 gap-2 rounded-lg px-3 text-xs"
            aria-label={t('livecourse.voiceConnect')}
            disabled={!canStart}
            onClick={() =>
              void start().catch((cause) =>
                setError(cause instanceof Error ? cause.message : String(cause)),
              )
            }
          >
            <Radio aria-hidden="true" />
            {t(
              status === 'error' || status === 'unconfigured'
                ? 'livecourse.voiceReconnect'
                : 'livecourse.voiceConnectShort',
            )}
          </Button>
        ) : (
          <IconButton
            label={t('livecourse.voiceConnect')}
            disabled={!canStart}
            onClick={() =>
              void start().catch((cause) =>
                setError(cause instanceof Error ? cause.message : String(cause)),
              )
            }
          >
            <Radio />
          </IconButton>
        )}
      </div>
      {lectern && (
        <label
          htmlFor={questionInputId}
          className="mb-2 mt-4 block text-sm font-medium tracking-tight"
        >
          {t(oralQuestion ? 'livecourse.oralTitle' : 'livecourse.questionTitle')}
        </label>
      )}
      {oralQuestion ? (
        <div
          data-testid="classroom-oral-question"
          className="mt-2 rounded-md border border-primary/30 bg-muted/30 p-3"
        >
          {!lectern && (
            <p className="text-xs font-medium text-primary">{t('livecourse.oralTitle')}</p>
          )}
          <p className="mt-1 text-sm leading-6">{oralQuestion.question}</p>
          {oralQuestion.teacherText && oralQuestion.teacherText !== oralQuestion.question ? (
            <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-sm leading-6">
              {oralQuestion.teacherText}
            </p>
          ) : null}
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {t(`livecourse.oralPhase_${oralQuestion.phase}`)}
          </p>
          {oralQuestion.answer ? (
            <p className="mt-1 break-words text-xs">
              {t('livecourse.oralYourAnswer', { answer: oralQuestion.answer })}
            </p>
          ) : null}
          {oralQuestion.error ? (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {oralQuestion.error}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {oralQuestion.phase === 'failed' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={sendingQuestion || !canUseOral}
                onClick={() => void runOralControl('retryOralQuestion')}
              >
                {t('livecourse.oralRetry')}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={sendingQuestion || !canUseOral || oralQuestion.phase !== 'waiting'}
                onClick={() => void runOralControl('hintOralQuestion')}
              >
                {t('livecourse.questionHint')}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                sendingQuestion ||
                !canUseOral ||
                !['waiting', 'failed'].includes(oralQuestion.phase)
              }
              onClick={() => void runOralControl('endOralQuestion')}
            >
              {t('livecourse.oralContinue')}
            </Button>
          </div>
        </div>
      ) : (
        <div
          role="group"
          aria-label={t('livecourse.quickQuestions')}
          className={cn(lectern ? 'lc-teacher-quick-questions' : 'mt-2 flex flex-wrap gap-1.5')}
        >
          {quickQuestions.map(({ label, prompt }) => {
            const nextQuestion = question.split('\n').includes(prompt)
              ? question
              : question.trim()
                ? `${question.trimEnd()}\n${prompt}`
                : prompt;
            return (
              <Button
                key={label}
                type="button"
                variant={lectern ? 'secondary' : 'outline'}
                size="sm"
                className={cn(
                  lectern
                    ? 'min-h-11 min-w-0 rounded-lg px-2 py-2 text-xs whitespace-normal'
                    : 'min-h-9 rounded-full px-3 text-xs',
                )}
                disabled={!canAsk || sendingQuestion || nextQuestion.length > MAX_QUESTION_LENGTH}
                onClick={() => {
                  setQuestion(nextQuestion);
                  questionInputRef.current?.focus();
                }}
              >
                {label}
              </Button>
            );
          })}
        </div>
      )}
      {quote && !oralQuestion ? (
        <div
          data-testid="classroom-question-quote"
          className="mt-2 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/40 py-2 pl-3 pr-1"
        >
          <Quote aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1" role="status">
            <p className="text-xs font-medium">{t('livecourse.questionQuote')}</p>
            <blockquote className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
              {quote.text}
            </blockquote>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0"
            aria-label={t('livecourse.removeQuestionQuote')}
            disabled={sendingQuestion}
            onClick={() => useHtmlQuestionContext.getState().clearQuote(quote)}
          >
            <X aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <form
        className={cn(lectern ? 'lc-teacher-composer mt-3' : 'mt-2 flex items-end gap-2')}
        onSubmit={(event) => {
          event.preventDefault();
          void sendQuestion();
        }}
      >
        <textarea
          id={questionInputId}
          ref={questionInputRef}
          data-testid="classroom-question-input"
          aria-label={t(oralQuestion ? 'livecourse.oralAnswer' : 'livecourse.askTeacher')}
          aria-describedby={questionHintId}
          placeholder={t(oralQuestion ? 'livecourse.oralAnswer' : 'livecourse.askTeacher')}
          value={draft}
          onChange={(event) => (oralQuestion ? setOralAnswer : setQuestion)(event.target.value)}
          rows={2}
          maxLength={MAX_QUESTION_LENGTH}
          disabled={!canAsk || sendingQuestion}
          className={cn(
            'min-w-0 resize-none text-sm leading-6 disabled:opacity-50',
            lectern
              ? 'block w-full border-0 bg-transparent px-3 pb-1 pt-3 outline-none'
              : 'flex-1 rounded-md border border-input bg-background px-3 py-2',
          )}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canAsk) void sendQuestion();
            }
          }}
        />
        <div className={cn(lectern && 'flex items-center justify-between gap-2 px-2 pb-2')}>
          {lectern && (
            <span className="pl-1 text-[11px] leading-4 text-muted-foreground">
              {t('livecourse.questionKeyboardHint')}
            </span>
          )}
          <Button
            type="submit"
            size="icon"
            variant={lectern ? 'default' : 'outline'}
            aria-label={t('livecourse.sendQuestion')}
            aria-busy={sendingQuestion}
            disabled={!canAsk || !draft.trim() || sendingQuestion}
            className={cn('size-11 shrink-0', lectern && 'rounded-lg')}
          >
            {sendingQuestion ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Send aria-hidden="true" className="size-4" />
            )}
          </Button>
        </div>
      </form>
      <p id={questionHintId} className="mt-1.5 text-xs leading-5 text-muted-foreground">
        {questionHint}
      </p>
      {error ? (
        <p
          role="alert"
          className={cn(
            'mt-2 break-words text-xs leading-5 text-destructive',
            lectern && 'rounded-lg bg-destructive/5 px-3 py-2',
          )}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
