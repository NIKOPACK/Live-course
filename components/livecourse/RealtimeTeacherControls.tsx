'use client';

import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { CircleStop, LoaderCircle, Mic, MicOff, Power, Radio, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
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

function statusLabel(
  status: RealtimeTeacherStatus,
  speaking: boolean,
  activeTool: string | null,
): string {
  if (status === 'connecting') return '连接中';
  if (status === 'unconfigured') return 'Realtime 未配置';
  if (status === 'error') return '连接失败';
  if (status !== 'connected') return '实时语音';
  if (activeTool) return `执行 ${activeTool}`;
  return speaking ? '实时讲解中' : '实时语音已连接';
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
  onTeacherChange?: (teacher: TeacherSpeechPort | null) => void;
}

export function RealtimeTeacherControls({
  tone = 'default',
  onPlaybackInterrupt,
  onPlaybackResume,
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
  const [sendingQuestion, setSendingQuestion] = useState(false);
  const sendingQuestionRef = useRef(false);
  /** J3.2：冻结中的 resumeNode；识别失败提示重说时据此判断。 */
  const [pendingInterruption, setPendingInterruption] = useState<string | null>(null);
  const pendingInterruptionRef = useRef<string | null>(null);
  pendingInterruptionRef.current = pendingInterruption;
  const [audioElementGeneration, setAudioElementGeneration] = useState(0);

  const currentNodeId = livecourse?.currentNodeId ?? null;
  const currentSceneId = currentScene?.id ?? null;

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
          ? `Anticipated student questions (preparation only — do NOT recite unless the learner asks):\n${nodeDesign.anticipatedQuestions.map((qa) => `- Q: ${qa.question}\n  A: ${qa.response}`).join('\n')}`
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
      if (onTeacherChange && state !== 'interrupted') return;
      void emitActionRef.current?.(input).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [onTeacherChange],
  );

  const handleEvent = useCallback(
    (event: RealtimeTeacherEvent) => {
      switch (event.type) {
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

    let realtime = realtimeRef.current;
    let audioBridge = audioBridgeRef.current;
    const preferVolc = Boolean(
      useSettingsStore.getState().realtimeProvidersConfig?.volc?.isServerConfigured,
    );
    const getLocation = () => locationRef.current;
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
        getInstructions: () => teachingContextRef.current,
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
        getTeachingContext: () => teachingContextRef.current,
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
  useEffect(() => {
    const teacher: TeacherSpeechPort = {
      connect: () => startRef.current(),
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
    const text = question.trim();
    if (!text || sendingQuestionRef.current) return;
    sendingQuestionRef.current = true;
    setSendingQuestion(true);
    setError(null);
    try {
      await start();
      const realtime = realtimeRef.current;
      if (!realtime) throw new Error(t('livecourse.voiceRequired'));
      await realtime.ask(text);
      useLiveCaptionStore.getState().setCaption({ speaker: 'student', text });
      setQuestion((current) => (current.trim() === text ? '' : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sendingQuestionRef.current = false;
      setSendingQuestion(false);
    }
  };

  const stop = useCallback(async () => {
    const realtime = realtimeRef.current;
    try {
      if (realtime) await realtime.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (realtimeRef.current !== realtime) return;
    realtimeRef.current = null;
    audioBridgeRef.current = null;
    const unregisterAudioBridge = unregisterAudioBridgeRef.current;
    unregisterAudioBridgeRef.current = null;
    unregisterAudioBridge?.();
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
  const canAsk =
    canStart &&
    (livecourse?.classroomState === 'teaching' ||
      livecourse?.classroomState === 'checking' ||
      livecourse?.classroomState === 'interrupted');
  const label = statusLabel(status, speaking, activeTool);

  return (
    <div className={cn(lectern ? 'pt-1' : 'px-0 py-2', lectern && 'text-[var(--lc-classroom-ink)]')}>
      <audio key={audioElementGeneration} ref={audioRef} className="hidden" autoPlay playsInline />
      <div className="flex min-h-11 flex-wrap items-center gap-1.5">
        <span
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
          className={cn(
            'min-w-20 flex-1 text-xs font-medium leading-5 [overflow-wrap:anywhere]',
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
        ) : connected ? (
          <>
            <IconButton
              label={muted ? '打开麦克风' : '静音麦克风'}
              aria-pressed={muted}
              onClick={() => {
                try {
                  realtimeRef.current?.mute(!muted);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : String(cause));
                }
              }}
            >
              {muted ? <MicOff /> : <Mic />}
            </IconButton>
            <IconButton
              label="打断教师"
              disabled={!speaking}
              onClick={() => realtimeRef.current?.interrupt()}
            >
              <CircleStop />
            </IconButton>
            <IconButton label="断开实时语音" onClick={() => void stop()}>
              <Power />
            </IconButton>
          </>
        ) : (
          <IconButton
            label="连接实时语音"
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
      <form
        className={cn('mt-2 flex gap-2', lectern ? 'items-center' : 'items-end')}
        onSubmit={(event) => {
          event.preventDefault();
          void sendQuestion();
        }}
      >
        <textarea
          data-testid="classroom-question-input"
          aria-label={t('livecourse.askTeacher')}
          placeholder={t('livecourse.askTeacher')}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={lectern ? 1 : 2}
          maxLength={2000}
          disabled={!canAsk || sendingQuestion}
          className={cn(
            'min-w-0 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50',
            lectern && 'min-h-11',
          )}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canAsk) void sendQuestion();
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          variant="outline"
          aria-label={t('livecourse.sendQuestion')}
          aria-busy={sendingQuestion}
          disabled={!canAsk || !question.trim() || sendingQuestion}
          className="size-11 shrink-0"
        >
          {sendingQuestion ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </form>
      {error ? (
        <p role="alert" className={cn('mt-1 break-words text-xs leading-5 text-destructive')}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
