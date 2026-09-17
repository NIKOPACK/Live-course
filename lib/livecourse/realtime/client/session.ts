import {
  OpenAIRealtimeWebRTC,
  RealtimeAgent,
  RealtimeSession,
  type RealtimeSessionConfig,
  tool,
} from '@openai/agents/realtime';
import { z } from 'zod';

import {
  realtimeClientSecretResponseSchema,
  realtimeToolRequestSchema,
  realtimeToolResponseSchema,
  type RealtimeTeachingCommand,
  type RealtimeToolRequest,
} from '@/lib/livecourse/realtime/contracts';
import type { AssistantTask } from '@/lib/livecourse/domain';

import { RealtimeAudioBridge } from './audio-bridge';
import type { TeacherSpeechPort } from './teacher-speech';
import {
  OralQuestionSession,
  type OralQuestionOptions,
  type OralQuestionState,
} from './oral-question';
import type { OralQuestion } from '@/lib/livecourse/domain/schemas';

export type RealtimeTeacherStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'unconfigured'
  | 'error'
  | 'closed';

export type RealtimeTeacherEvent =
  | { type: 'oral_question'; state: OralQuestionState | null }
  | { type: 'status'; status: RealtimeTeacherStatus }
  | { type: 'audio_start' }
  | { type: 'audio_stopped' }
  | { type: 'audio_interrupted' }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string }
  | { type: 'assistant_task'; task: AssistantTask }
  // J3.2：插话冻结 resumeNode 的瞬间（识别失败时该事件后没有
  // audio_start，UI 据此提示重说且恢复点仍被保留）。
  | { type: 'interrupted'; nodeId: string }
  | { type: 'node_resumed'; nodeId: string }
  /** The learner's utterance could not be transcribed. The interrupted
   * resume point remains held until a later successful answer/resume cycle. */
  | { type: 'recognition_failed'; error: Error; nodeId: string | null }
  | { type: 'interruption_failed'; error: Error; nodeId: string }
  /** W may or may not contain lesson.interrupt. Local playback remains frozen
   * and the same transaction must be reconciled before it can resume. */
  | { type: 'interruption_uncertain'; error: Error; nodeId: string }
  | { type: 'muted'; muted: boolean }
  /** Read-only projection of transport text for live captions
   * (docs/spec/02-product-manual.md 课堂): teacher speech text accumulated
   * per response, or the learner's recognized utterance. Purely presentational —
   * never persisted and never an input to the action/evidence pipeline. */
  | { type: 'transcript'; speaker: 'teacher' | 'student'; text: string }
  | { type: 'error'; error: Error };

/** Pull a text fragment out of a raw realtime transport event (delta / done /
 * transcription payloads across OpenAI-compatible gateways). */
function extractTransportEventText(event: Record<string, unknown>): string {
  for (const key of ['delta', 'text', 'transcript', 'content'] as const) {
    const value = event[key];
    if (typeof value === 'string') return value;
  }
  const item = event.item;
  if (item && typeof item === 'object') {
    const text = (item as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

export interface RealtimeClassroomLocation {
  nodeId: string;
  sceneId: string;
}

export interface LiveCourseRealtimeSessionOptions {
  courseId: string;
  lessonId: string;
  learnerId: string;
  /** Optional teacher identity for a trusted server-side route binding. */
  teacherId?: string;
  /** Receive-only narration for independent replay: no microphone or classroom tools. */
  readOnly?: boolean;
  audioBridge: RealtimeAudioBridge;
  getLocation: () => RealtimeClassroomLocation | null;
  getTeachingContext: () => string;
  dispatchCommand: (command: RealtimeTeachingCommand) => Promise<void>;
  /** Return whether the classroom is in a state where an interruption may be captured. */
  canInterrupt?: () => boolean;
  /** Freeze local playback and commit lesson.interrupt as one coordinated boundary. */
  interruptNode: (nodeId: string) => Promise<void>;
  /** Reconcile any retained interruption write, then release W and playback. */
  resumeNode: (nodeId: string) => Promise<void>;
  /** Explicitly cancels queued/running delegated tasks on lifecycle changes. */
  cancelAssistantTasks?: (
    reason: string,
    location: RealtimeClassroomLocation | null,
  ) => void | Promise<void>;
  onEvent?: (event: RealtimeTeacherEvent) => void;
  fetchImpl?: typeof fetch;
  /**
   * Optional learner-saved OpenAI key used only to mint the short-lived
   * client secret. Never sent when empty; the server env key still wins.
   */
  getClientSecretApiKey?: () => string | undefined;
}

export class RealtimeHttpError extends Error {
  override readonly name = 'RealtimeHttpError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A connection attempt was invalidated by a concurrent close/reconnect. */
export class RealtimeSessionClosingError extends Error {
  override readonly name = 'RealtimeSessionClosingError';

  constructor() {
    super('Realtime teacher connection was closed before it finished connecting');
  }
}

/**
 * The local narrator is frozen, but the authoritative interruption append
 * could not be confirmed. Callers must retain the resume point and reconcile
 * the same idempotency key instead of compensating or starting a second path.
 */
export class RealtimeInterruptionUncertaintyError extends Error {
  override readonly name = 'RealtimeInterruptionUncertaintyError';

  constructor(
    readonly nodeId: string,
    readonly operationCause: unknown,
  ) {
    super('Classroom interruption confirmation is pending; playback remains paused');
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  const details = z
    .object({
      message: z.string().optional(),
      error: z.object({ message: z.string().optional() }).optional(),
    })
    .safeParse(error);
  return new Error(
    details.success
      ? (details.data.error?.message ?? details.data.message ?? String(error))
      : String(error),
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Realtime endpoint returned non-JSON status ${response.status}`);
  }
}

function errorFromResponse(response: Response, payload: unknown): RealtimeHttpError {
  const parsed = z
    .object({
      error: z
        .object({
          code: z.string().optional(),
          message: z.string().optional(),
        })
        .optional(),
    })
    .safeParse(payload);
  return new RealtimeHttpError(
    response.status,
    parsed.success
      ? (parsed.data.error?.code ?? 'REALTIME_REQUEST_FAILED')
      : 'REALTIME_REQUEST_FAILED',
    parsed.success
      ? (parsed.data.error?.message ?? `Realtime request failed with status ${response.status}`)
      : `Realtime request failed with status ${response.status}`,
  );
}

function requireToolCallId(details: unknown): string {
  const toolCall = (details as { toolCall?: { callId?: unknown } } | undefined)?.toolCall;
  if (typeof toolCall?.callId !== 'string' || !toolCall.callId.trim()) {
    throw new Error('Realtime tool call is missing a call id');
  }
  return toolCall.callId;
}

function buildAgentInstructions(teachingContext: string): string {
  return [
    'You are the live teacher inside an active classroom.',
    'Keep spoken responses concise and match the learner language.',
    'Use classroom tools for navigation, highlighting, pointer, whiteboard, sources, and avatar state. Do not delegate work to another speaker or assistant.',
    'Do not infer mastery from conversation. Quiz and homework evidence is recorded by the application.',
    'If the learner interrupts, first confirm the question, answer it briefly, then explicitly say you are returning to the original lesson node. The application restores that node; do not navigate away.',
    teachingContext,
  ]
    .filter(Boolean)
    .join('\n');
}

function createRealtimeTools(
  invoke: (toolValue: RealtimeToolRequest['tool'], callId: string) => Promise<string>,
) {
  return [
    tool({
      name: 'goto_node',
      description:
        'Move the classroom to a specific lesson node when the teaching flow requires it.',
      parameters: z.object({ targetNodeId: z.string().trim().min(1).max(240) }).strict(),
      execute: (args, _context, details) =>
        invoke({ name: 'goto_node', arguments: args }, requireToolCallId(details)),
    }),
    tool({
      name: 'highlight',
      description: 'Highlight one known element on the current slide.',
      parameters: z
        .object({
          elementId: z.string().trim().min(1).max(240),
          durationMs: z.number().int().positive().max(60_000).optional(),
          color: z.string().trim().min(1).max(64).optional(),
          style: z.enum(['outline', 'fill', 'shadow']).optional(),
        })
        .strict(),
      execute: (args, _context, details) =>
        invoke({ name: 'highlight', arguments: args }, requireToolCallId(details)),
    }),
    tool({
      name: 'pointer',
      description: 'Point at one known element on the current slide.',
      parameters: z
        .object({
          elementId: z.string().trim().min(1).max(240),
          x: z.number().min(0).max(1).optional(),
          y: z.number().min(0).max(1).optional(),
          durationMs: z.number().int().positive().max(60_000).optional(),
        })
        .strict(),
      execute: (args, _context, details) =>
        invoke({ name: 'pointer', arguments: args }, requireToolCallId(details)),
    }),
    tool({
      name: 'board_text',
      description: 'Add a short text note to the classroom whiteboard.',
      parameters: z
        .object({
          content: z.string().trim().min(1).max(2_000),
          x: z.number().min(0).max(1_000),
          y: z.number().min(0).max(1_000),
          width: z.number().positive().max(1_000).optional(),
          height: z.number().positive().max(1_000).optional(),
          color: z.string().trim().min(1).max(64).optional(),
        })
        .strict(),
      execute: (args, _context, details) =>
        invoke({ name: 'board_text', arguments: args }, requireToolCallId(details)),
    }),
    tool({
      name: 'board_clear',
      description: 'Clear the current classroom whiteboard.',
      parameters: z.object({}).strict(),
      execute: (args, _context, details) =>
        invoke({ name: 'board_clear', arguments: args }, requireToolCallId(details)),
    }),
    tool({
      name: 'set_expression',
      description: 'Set the teacher avatar expression to match the current teaching moment.',
      parameters: z
        .object({
          expression: z.enum(['neutral', 'relaxed', 'think', 'happy', 'surprised']),
          intensity: z.number().min(0).max(1).optional(),
        })
        .strict(),
      execute: (args, _context, details) =>
        invoke({ name: 'set_expression', arguments: args }, requireToolCallId(details)),
    }),
    tool({
      name: 'look_at',
      description: 'Direct the teacher avatar gaze toward the learner, slides, board, or camera.',
      parameters: z
        .object({ target: z.enum(['student', 'slides', 'whiteboard', 'camera']) })
        .strict(),
      execute: (args, _context, details) =>
        invoke({ name: 'look_at', arguments: args }, requireToolCallId(details)),
    }),
    tool({
      name: 'show_source',
      description: 'Show a cited course source and optional page to the learner.',
      parameters: z
        .object({
          sourceId: z.string().trim().min(1).max(240),
          page: z.number().int().positive().optional(),
        })
        .strict(),
      execute: (args, _context, details) =>
        invoke({ name: 'show_source', arguments: args }, requireToolCallId(details)),
    }),
  ];
}

interface SpeechTurn {
  token: string;
  kind: 'narration' | 'answer' | 'oral-answer';
  generation: number;
  responseId: string | null;
  audioStarted: boolean;
  playbackReady: boolean;
  audioDrained: boolean;
  completed: boolean;
  finishing: boolean;
  dispatched: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
  removeAbortListener?: () => void;
}

function speechAbortError(): Error {
  return new DOMException('Realtime speech was cancelled', 'AbortError');
}

export class LiveCourseRealtimeSession implements TeacherSpeechPort {
  readonly #options: LiveCourseRealtimeSessionOptions;
  #session: RealtimeSession | null = null;
  #sessionConfig: Partial<RealtimeSessionConfig> | null = null;
  /** Transport created before its handshake settles; closed on lifecycle invalidation. */
  #connectingSession: { generation: number; session: RealtimeSession } | null = null;
  /** Prevent a close race from invoking the same SDK transport twice. */
  readonly #closedSessions = new WeakSet<RealtimeSession>();
  #connectPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #closing = false;
  #connectionGeneration = 0;
  #speaking = false;
  #resumeNodeId: string | null = null;
  #interruptionPromise: Promise<void> | null = null;
  #responseGeneration = 0;
  #answerGeneration: number | null = null;
  #resumeQueue: Promise<void> = Promise.resolve();
  readonly #queuedResumeGenerations = new Set<number>();
  #lastLocation: RealtimeClassroomLocation | null = null;
  #turnSequence = 0;
  #pendingTurn: SpeechTurn | null = null;
  readonly #turns = new Map<string, SpeechTurn>();
  readonly #cancelledTokens = new Set<string>();
  readonly #cancelledResponseIds = new Set<string>();
  #microphoneItemId: string | null = null;
  #oralQuestion: OralQuestionSession | null = null;
  #oralReleased: Promise<void> = Promise.resolve();
  #learnerMuted = false;
  #inputEnabled = true;
  #removeAudioErrorListener: (() => void) | null = null;
  #responseBoundary: {
    token: string;
    responseId: string | null;
    ready: Promise<void>;
    release: () => void;
  } | null = null;

  constructor(options: LiveCourseRealtimeSessionOptions) {
    this.#options = options;
  }

  get connected(): boolean {
    return this.#session !== null;
  }

  get muted(): boolean {
    return this.#options.readOnly === true || this.#learnerMuted;
  }

  connect(): Promise<void> {
    if (this.#closing) return Promise.reject(new RealtimeSessionClosingError());
    if (this.#session) return Promise.resolve();
    if (this.#connectPromise) return this.#connectPromise;
    const generation = ++this.#connectionGeneration;
    const connectPromise = this.#connect(generation);
    // #connect emits its `connecting` status before its first await.  An
    // observer is allowed to synchronously call close() from that callback,
    // invalidating this generation before control returns here.  Do not
    // publish the now-stale promise as the next connection's identity.
    if (!this.#isConnectionCurrent(generation)) return connectPromise;
    this.#connectPromise = connectPromise;
    // Failed attempts may be retried. Guard the identity so a late failure
    // from an invalidated attempt cannot clear a newer connection promise.
    void connectPromise.catch(() => {
      if (this.#connectPromise === connectPromise) this.#connectPromise = null;
    });
    return connectPromise;
  }

  async #connect(generation: number): Promise<void> {
    this.#emit({ type: 'status', status: 'connecting' });
    let session: RealtimeSession | null = null;
    let replayInput: MediaStream | null = null;
    try {
      await this.#options.audioBridge.activate();
      this.#assertConnectionCurrent(generation);
      const secret = await this.#requestClientSecret();
      this.#assertConnectionCurrent(generation);
      if (this.#options.readOnly) {
        const context = this.#options.audioBridge.context;
        if (!context) throw new Error('Replay audio context is not active');
        // The SDK requires addTrack(stream.getAudioTracks()[0]). A disabled
        // synthetic track satisfies that contract without opening a microphone.
        replayInput = context.createMediaStreamDestination().stream;
        for (const track of replayInput.getAudioTracks()) track.enabled = false;
      }
      const transport = new OpenAIRealtimeWebRTC({
        audioElement: this.#options.audioBridge.audioElement,
        ...(replayInput
          ? {
              mediaStream: replayInput,
              changePeerConnection: (connection: RTCPeerConnection) => {
                for (const transceiver of connection.getTransceivers()) {
                  if (transceiver.sender.track?.kind === 'audio')
                    transceiver.direction = 'recvonly';
                }
                return connection;
              },
            }
          : {}),
      });
      const agent = new RealtimeAgent({
        name: 'LiveCourse Teacher',
        voice: secret.voice,
        instructions: buildAgentInstructions(this.#options.getTeachingContext()),
        tools: this.#options.readOnly
          ? []
          : createRealtimeTools((toolValue, callId) =>
              this.#invokeGatewayTool(generation, toolValue, callId),
            ),
      });
      const config: Partial<RealtimeSessionConfig> = {
        outputModalities: ['audio'],
        reasoning: { effort: 'low' },
        audio: {
          input: {
            transcription: this.#options.readOnly ? null : { model: 'gpt-4o-mini-transcribe' },
            turnDetection: this.#options.readOnly
              ? null
              : {
                  type: 'semantic_vad',
                  eagerness: 'auto',
                  // VAD detects turns, but the application owns interruption
                  // eligibility, context refresh and response creation.
                  createResponse: false,
                  interruptResponse: false,
                },
          },
          output: { voice: secret.voice },
        },
      };
      session = new RealtimeSession(agent, {
        model: secret.model,
        transport,
        config,
        workflowName: 'livecourse-realtime-teacher',
        groupId: `${this.#options.courseId}:${this.#options.lessonId}`,
      });
      this.#wireSession(session);
      this.#connectingSession = { generation, session };
      this.#assertConnectionCurrent(generation);
      await session.connect({ apiKey: secret.value, model: secret.model });
      if (!this.#isConnectionCurrent(generation)) {
        // The close may have completed while the transport handshake was in
        // flight. Never publish or retain a session after that boundary.
        this.#closeRealtimeSession(session);
        if (
          this.#connectingSession?.generation === generation &&
          this.#connectingSession.session === session
        ) {
          this.#connectingSession = null;
        }
        throw new RealtimeSessionClosingError();
      }
      if (
        this.#connectingSession?.generation === generation &&
        this.#connectingSession.session === session
      ) {
        this.#connectingSession = null;
      }
      if (this.#options.readOnly) session.mute(true);
      this.#session = session;
      this.#sessionConfig = config;
      const connectedSession = session;
      const audio = this.#options.audioBridge.audioElement;
      const onAudioError = () => {
        if (this.#session !== connectedSession) return;
        const error = new Error(audio.error?.message || 'Realtime audio playback failed');
        if (!this.#turns.size) this.#emit({ type: 'error', error });
        for (const turn of this.#turns.values()) this.#failTurn(turn, error);
      };
      this.#removeAudioErrorListener?.();
      audio.addEventListener('error', onAudioError);
      this.#removeAudioErrorListener = () => audio.removeEventListener('error', onAudioError);
      this.#emit({ type: 'status', status: 'connected' });
    } catch (error) {
      if (!session && replayInput) {
        for (const track of replayInput.getAudioTracks()) track.stop();
      }
      if (this.#connectingSession?.generation === generation) {
        // close() normally clears this reference after closing the transport;
        // retain the guard for a close that raced before the assignment above.
        const connecting = this.#connectingSession;
        if (this.#connectingSession === connecting) this.#connectingSession = null;
      }
      let surfacedError: unknown = error;
      // RealtimeSession.connect() does not close its transport when the
      // handshake rejects. Close the exact local generation here; a newer
      // connection (if any) is never reachable through this local variable.
      if (session && this.#session !== session) {
        try {
          this.#closeRealtimeSession(session);
        } catch (cleanupCause) {
          surfacedError = new AggregateError(
            [error, cleanupCause],
            'Realtime connection failed and transport cleanup also failed',
          );
        }
      }
      const normalized = toError(surfacedError);
      if (this.#isConnectionCurrent(generation)) {
        this.#emit({
          type: 'status',
          status:
            surfacedError instanceof RealtimeHttpError &&
            surfacedError.code === 'REALTIME_NOT_CONFIGURED'
              ? 'unconfigured'
              : 'error',
        });
        this.#emit({ type: 'error', error: normalized });
      }
      throw normalized;
    }
  }

  #isConnectionCurrent(generation: number): boolean {
    return !this.#closing && this.#connectionGeneration === generation;
  }

  #assertConnectionCurrent(generation: number): void {
    if (!this.#isConnectionCurrent(generation)) throw new RealtimeSessionClosingError();
  }

  #closeRealtimeSession(session: RealtimeSession): void {
    if (this.#closedSessions.has(session)) return;
    try {
      session.close();
      this.#closedSessions.add(session);
    } catch (error) {
      // Leave the identity unmarked so a later lifecycle retry can try the
      // same transport again after a transient SDK close failure.
      throw error;
    }
  }

  mute(muted: boolean): void {
    if (this.#options.readOnly && !muted) throw new Error('Replay microphone cannot be enabled');
    const session = this.#session;
    if (!session) throw new Error('Realtime teacher is not connected');
    this.#learnerMuted = muted;
    session.mute(muted || !this.#inputEnabled);
    this.#emit({ type: 'muted', muted });
  }

  async speak(text: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#oralQuestion?.closed) await this.#oralReleased;
    return this.#requestSpeech('narration', text, options.signal);
  }

  async ask(text: string): Promise<void> {
    if (this.#oralQuestion) return this.#oralQuestion.answer(text);
    if (!text.trim()) throw new Error('A classroom question cannot be empty');
    this.#requireSession();
    if (!this.#beginLearnerTurn()) throw new Error('Classroom questions are not available now');
    const generation = this.#responseGeneration;
    this.#emit({ type: 'transcript', speaker: 'student', text });
    await this.#waitForInterruption();
    if (generation !== this.#responseGeneration) throw speechAbortError();
    await this.#requestSpeech('answer', text);
  }

  async question(question: OralQuestion, options: OralQuestionOptions): Promise<void> {
    if (this.#options.readOnly || this.#oralQuestion)
      throw new Error('Oral question is unavailable');
    const session = this.#requireSession();
    const oral = new OralQuestionSession(
      question,
      {
        speak: (text, signal) => this.speak(text, { signal }),
        respond: (text, signal, native) => this.#requestSpeech('oral-answer', text, signal, native),
        updateInstructions: async () => {
          this.#requireSession();
        },
        setListening: (enabled) => {
          this.#inputEnabled = enabled;
          this.#session?.mute(this.#learnerMuted || !enabled);
        },
        cancel: async () => {
          for (const turn of this.#turns.values()) this.#failTurn(turn, speechAbortError());
        },
        manualMicrophoneResponse: true,
        onState: (state) => this.#emit({ type: 'oral_question', state }),
      },
      options,
    );
    let release!: () => void;
    this.#oralReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#oralQuestion = oral;
    try {
      await oral.run();
    } finally {
      this.#microphoneItemId = null;
      this.#inputEnabled = true;
      try {
        if (this.#session === session && !this.#closing) {
          session.mute(this.#learnerMuted);
          session.transport.updateSessionConfig({
            ...this.#sessionConfig,
            instructions: buildAgentInstructions(this.#options.getTeachingContext()),
          });
        }
      } finally {
        this.#oralQuestion = null;
        this.#emit({ type: 'oral_question', state: null });
        release();
      }
    }
  }

  hintOralQuestion(): Promise<void> {
    return this.#requireOralQuestion().hint();
  }
  retryOralQuestion(): Promise<void> {
    return this.#requireOralQuestion().retry();
  }
  endOralQuestion(): Promise<void> {
    return this.#requireOralQuestion().end();
  }

  #requireOralQuestion(): OralQuestionSession {
    if (!this.#oralQuestion) throw new Error('No oral question is active');
    return this.#oralQuestion;
  }

  #requireSession(): RealtimeSession {
    if (!this.#session || this.#closing) throw new Error('Realtime teacher is not connected');
    return this.#session;
  }

  #requestSpeech(
    kind: SpeechTurn['kind'],
    text: string,
    signal?: AbortSignal,
    inputRecorded = false,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let session: RealtimeSession;
      try {
        session = this.#requireSession();
        if (!text.trim()) throw new Error('Realtime speech text cannot be empty');
        if (signal?.aborted) throw speechAbortError();
        if (this.#pendingTurn) throw new Error('Realtime teacher already has an active response');
      } catch (error) {
        reject(toError(error));
        return;
      }
      const token = `${this.#connectionGeneration}:${++this.#turnSequence}`;
      const turn: SpeechTurn = {
        token,
        kind,
        generation: this.#responseGeneration,
        responseId: null,
        audioStarted: false,
        playbackReady: false,
        audioDrained: false,
        completed: false,
        finishing: false,
        dispatched: false,
        timer: setTimeout(() => {
          this.#failTurn(turn, new Error('Realtime response did not start within 30 seconds'));
        }, 30_000),
        resolve,
        reject,
      };
      this.#turns.set(token, turn);
      this.#pendingTurn = turn;
      if (kind === 'narration') {
        this.#emit({ type: 'transcript', speaker: 'teacher', text });
      }
      if (kind === 'answer') this.#answerGeneration = turn.generation;
      if (signal) {
        const abort = () => this.#failTurn(turn, speechAbortError());
        signal.addEventListener('abort', abort, { once: true });
        turn.removeAbortListener = () => signal.removeEventListener('abort', abort);
      }
      void this.#dispatchSpeech(session, turn, text, inputRecorded);
    });
  }

  async #dispatchSpeech(
    session: RealtimeSession,
    turn: SpeechTurn,
    text: string,
    inputRecorded: boolean,
  ): Promise<void> {
    const previous = this.#responseBoundary;
    if (previous) await previous.ready;
    if (!this.#turns.has(turn.token)) return;
    const { kind, token } = turn;
    try {
      if (kind === 'answer' && this.#options.canInterrupt?.() === false) {
        throw new Error('Classroom questions are not available now');
      }
      const oralInstructions =
        kind === 'oral-answer' ? this.#requireOralQuestion().instructions : null;
      const context =
        oralInstructions ?? buildAgentInstructions(this.#options.getTeachingContext());
      // The SDK merges updates with its defaults, not the live session.
      // Retain voice/transcription/manual VAD on every context refresh.
      session.transport.updateSessionConfig({ ...this.#sessionConfig, instructions: context });
      const instructions =
        kind === 'narration'
          ? [
              context,
              'Read the supplied lesson script faithfully, in its current language. Do not summarize, add commentary, answer it as a question, call tools, or navigate.',
              `Lesson script:\n${text}`,
            ].join('\n')
          : kind === 'oral-answer'
            ? (oralInstructions ?? this.#requireOralQuestion().instructions)
            : [
                context,
                `Confirm the learner's question, answer it, then explicitly return to the original node ${this.#resumeNodeId}. Do not advance the lesson.`,
              ].join('\n');
      if ((kind === 'answer' || kind === 'oral-answer') && !inputRecorded) {
        session.transport.sendMessage(text, {}, { triggerResponse: false });
      }
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.#responseBoundary = { token, responseId: null, ready, release };
      turn.dispatched = true;
      session.transport.sendEvent({
        type: 'response.create',
        event_id: `lc-response-${token}`,
        response: {
          instructions,
          output_modalities: ['audio'],
          metadata: { livecourse_request: token },
          // Scripted speech is out of band: it must not masquerade as a
          // learner message or let previous conversation rewrite the script.
          ...(kind === 'narration'
            ? {
                conversation: 'none',
                input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
              }
            : {}),
          // Classroom actions are executed by the playback/controller lane,
          // not a second autonomous navigation lane during a spoken turn.
          tools: [],
          tool_choice: 'none',
        },
      });
    } catch (error) {
      if (this.#responseBoundary?.token === turn.token) this.#releaseResponseBoundary();
      this.#failTurn(turn, toError(error));
    }
  }

  #releaseResponseBoundary(): void {
    const boundary = this.#responseBoundary;
    this.#responseBoundary = null;
    boundary?.release();
  }

  #forgetTurn(turn: SpeechTurn): void {
    clearTimeout(turn.timer);
    turn.removeAbortListener?.();
    this.#turns.delete(turn.token);
    if (this.#pendingTurn === turn) this.#pendingTurn = null;
  }

  #failTurn(turn: SpeechTurn, error: Error, cancelTransport = true): void {
    if (!this.#turns.has(turn.token)) return;
    const wasPending = this.#pendingTurn === turn;
    this.#forgetTurn(turn);
    if (turn.kind === 'answer' && turn.generation === this.#responseGeneration) {
      this.#invalidateAnswer();
    }
    if (turn.responseId) this.#cancelledResponseIds.add(turn.responseId);
    else if (turn.dispatched) this.#cancelledTokens.add(turn.token);
    if (wasPending) {
      this.#setSpeaking(false, 'audio_interrupted');
      if (cancelTransport && this.#session) {
        try {
          if (turn.responseId && !turn.completed) {
            this.#session.transport.sendEvent({
              type: 'response.cancel',
              response_id: turn.responseId,
            });
          }
          if (turn.audioStarted && !turn.audioDrained) {
            this.#session.transport.sendEvent({ type: 'output_audio_buffer.clear' });
          }
        } catch (cause) {
          error = new AggregateError([error, cause], 'Realtime speech cancellation failed');
        }
      }
    }
    turn.reject(error);
    if (error.name !== 'AbortError') this.#emit({ type: 'error', error });
  }

  #finishTurn(turn: SpeechTurn): void {
    if (
      !turn.completed ||
      !turn.audioStarted ||
      !turn.playbackReady ||
      !turn.audioDrained ||
      turn.finishing
    )
      return;
    turn.finishing = true;
    if (this.#pendingTurn === turn) this.#pendingTurn = null;
    this.#setSpeaking(false, 'audio_stopped');
    const finish =
      turn.kind === 'answer' ? this.#queueResumeAfterAnswer(turn.generation) : Promise.resolve();
    void finish.then(
      () => {
        if (!this.#turns.has(turn.token)) return;
        this.#forgetTurn(turn);
        turn.resolve();
      },
      (error: unknown) => this.#failTurn(turn, toError(error), false),
    );
  }

  #beginLearnerTurn(itemId: string | null = null): boolean {
    if (this.#oralQuestion) {
      const accepted = !this.#learnerMuted && this.#oralQuestion.nativeStarted();
      if (accepted) this.#microphoneItemId = itemId;
      return accepted;
    }
    if (this.#options.readOnly || this.#options.canInterrupt?.() === false) {
      this.#microphoneItemId = null;
      return false;
    }
    if (!this.#options.getLocation()) return false;
    this.#microphoneItemId = itemId;
    this.#invalidateAnswer();
    for (const turn of this.#turns.values()) this.#failTurn(turn, speechAbortError());
    this.#captureResumeNode();
    return this.#resumeNodeId !== null;
  }

  async #waitForInterruption(): Promise<void> {
    try {
      await this.#interruptionPromise;
    } catch (error) {
      if (!(error instanceof RealtimeInterruptionUncertaintyError)) throw error;
    }
    if (!this.#resumeNodeId) throw new Error('Classroom interruption has no resume node');
  }

  interrupt(): void {
    const session = this.#session;
    if (!session) throw new Error('Realtime teacher is not connected');
    this.#beginLearnerTurn();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const closePromise = this.#close();
    this.#closePromise = closePromise;
    void closePromise.then(
      () => {
        // A successful close leaves this instance reusable (the UI normally
        // creates a fresh instance, but keeping the contract explicit avoids a
        // permanently-closing session if a caller reconnects in place).
        if (this.#closePromise === closePromise) {
          this.#closePromise = null;
          this.#closing = false;
        }
      },
      () => {
        if (this.#closePromise === closePromise) this.#closePromise = null;
        this.#closing = false;
      },
    );
    return closePromise;
  }

  async #close(): Promise<void> {
    this.#closing = true;
    this.#oralQuestion?.cancel(new Error('Realtime teacher connection was closed'));
    // Invalidate any in-flight handshake. Its late continuation is required
    // to close its own transport instead of attaching it to this instance.
    this.#connectionGeneration += 1;
    for (const turn of this.#turns.values()) {
      this.#failTurn(turn, new Error('Realtime teacher connection was closed'));
    }
    this.#releaseResponseBoundary();
    this.#microphoneItemId = null;
    const connectingSession = this.#connectingSession;
    if (connectingSession) {
      this.#closeRealtimeSession(connectingSession.session);
      if (this.#connectingSession === connectingSession) this.#connectingSession = null;
    }
    this.#invalidateAnswer();
    if (this.#speaking) this.#session?.interrupt();

    // A queued audio_stopped may already be waiting for the interrupt append.
    // Invalidate it above, then wait until it has observed that token before
    // running the explicit close-time release transaction.
    await this.#resumeQueue;
    await this.#releaseInterruptionBeforeClose();

    if (this.#session) this.#closeRealtimeSession(this.#session);
    this.#session = null;
    this.#sessionConfig = null;
    this.#connectPromise = null;
    this.#setSpeaking(false, 'audio_stopped');
    this.#resumeNodeId = null;
    this.#interruptionPromise = null;
    this.#answerGeneration = null;
    this.#queuedResumeGenerations.clear();
    this.#cancelledTokens.clear();
    this.#cancelledResponseIds.clear();
    this.#removeAudioErrorListener?.();
    this.#removeAudioErrorListener = null;
    if (!this.#options.readOnly) {
      await this.#options.cancelAssistantTasks?.('realtime session closed', this.#lastLocation);
    }
    this.#lastLocation = null;
    await this.#options.audioBridge.close();
    this.#emit({ type: 'status', status: 'closed' });
  }

  async #requestClientSecret() {
    const apiKey = this.#options.getClientSecretApiKey?.()?.trim();
    const response = await (this.#options.fetchImpl ?? fetch)(
      '/api/livecourse/realtime/client-secret',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-learner-key': this.#options.learnerId,
          ...(this.#options.teacherId ? { 'x-teacher-key': this.#options.teacherId } : {}),
        },
        body: JSON.stringify({
          courseId: this.#options.courseId,
          lessonId: this.#options.lessonId,
          ...(apiKey ? { apiKey } : {}),
        }),
        cache: 'no-store',
      },
    );
    const payload = await readJson(response);
    if (!response.ok) throw errorFromResponse(response, payload);
    return realtimeClientSecretResponseSchema.parse(payload);
  }

  async #invokeGatewayTool(
    generation: number,
    toolValue: RealtimeToolRequest['tool'],
    callId: string,
  ): Promise<string> {
    this.#assertConnectionCurrent(generation);
    if (this.#options.readOnly) throw new Error('Classroom tools are unavailable in replay');
    if (this.#pendingTurn?.kind === 'narration') {
      throw new Error('Classroom tools are unavailable during scripted speech');
    }
    const location = this.#options.getLocation();
    if (!location) throw new Error('Realtime classroom tool requires an active lesson node');
    if (
      this.#lastLocation &&
      (this.#lastLocation.nodeId !== location.nodeId ||
        this.#lastLocation.sceneId !== location.sceneId)
    ) {
      await this.#options.cancelAssistantTasks?.('classroom node changed', this.#lastLocation);
      this.#assertConnectionCurrent(generation);
    }
    this.#lastLocation = location;
    const request = realtimeToolRequestSchema.parse({
      courseId: this.#options.courseId,
      lessonId: this.#options.lessonId,
      nodeId: location.nodeId,
      sceneId: location.sceneId,
      callId,
      tool: toolValue,
    });
    const response = await (this.#options.fetchImpl ?? fetch)('/api/livecourse/realtime/tools', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-learner-key': this.#options.learnerId,
        ...(this.#options.teacherId ? { 'x-teacher-key': this.#options.teacherId } : {}),
      },
      body: JSON.stringify(request),
      cache: 'no-store',
    });
    const payload = await readJson(response);
    this.#assertConnectionCurrent(generation);
    if (!response.ok) throw errorFromResponse(response, payload);
    const result = realtimeToolResponseSchema.parse(payload);
    if ('task' in result) {
      // A queued task is deliberately not a teaching command. It can only
      // affect the classroom after a separate teacher confirmation path.
      this.#assertConnectionCurrent(generation);
      this.#emit({ type: 'assistant_task', task: result.task });
      return result.message;
    }
    // Check immediately before dispatch: after this synchronous boundary the
    // caller owns the command promise, and a close/reconnect cannot interleave
    // until dispatchCommand yields back to the event loop.
    this.#assertConnectionCurrent(generation);
    await this.#options.dispatchCommand(result.command);
    return result.message;
  }

  #captionResponseId = '';
  #captionText = '';
  #studentCaptionItemId = '';
  #studentCaptionText = '';

  /** Live captions read transport text deltas straight off the wire. The text
   * mirrors the audio the teacher is already producing; it is emitted as a
   * read-only `transcript` event and never feeds back into teaching state. */
  #handleCaptionEvent(event: unknown): boolean {
    const e = event as { type?: string; response_id?: unknown } & Record<string, unknown>;
    if (typeof e.response_id === 'string' && this.#cancelledResponseIds.has(e.response_id)) {
      return true;
    }
    if (
      e.type === 'response.output_text.delta' ||
      e.type === 'response.output_text.done' ||
      e.type === 'response.output_audio_transcript.delta' ||
      e.type === 'response.output_audio_transcript.done' ||
      e.type === 'response.audio_transcript.delta' ||
      e.type === 'response.audio_transcript.done'
    ) {
      const responseId = typeof e.response_id === 'string' ? e.response_id : '';
      if (responseId && responseId !== this.#captionResponseId) {
        this.#captionResponseId = responseId;
        this.#captionText = '';
      }
      // Scripted narration already projected the lesson script as the caption.
      // Incremental audio-transcript prefixes must not shrink that line.
      if (this.#pendingTurn?.kind === 'narration') {
        return true;
      }
      if (e.type.endsWith('.delta')) {
        this.#captionText += extractTransportEventText(e);
        if (this.#captionText) {
          this.#emit({ type: 'transcript', speaker: 'teacher', text: this.#captionText });
        }
      } else {
        const text = extractTransportEventText(e) || this.#captionText;
        this.#captionText = '';
        if (text) this.#emit({ type: 'transcript', speaker: 'teacher', text });
      }
      return true;
    }
    if (
      e.type === 'conversation.item.input_audio_transcription.delta' ||
      e.type === 'conversation.item.input_audio_transcription.completed'
    ) {
      if (this.#options.readOnly) return true;
      const itemId = typeof e.item_id === 'string' ? e.item_id : '';
      if (itemId && itemId !== this.#studentCaptionItemId) {
        this.#studentCaptionItemId = itemId;
        this.#studentCaptionText = '';
      }
      if (e.type === 'conversation.item.input_audio_transcription.delta') {
        this.#studentCaptionText += extractTransportEventText(e);
        if (this.#studentCaptionText) {
          this.#emit({ type: 'transcript', speaker: 'student', text: this.#studentCaptionText });
        }
      } else {
        const text = extractTransportEventText(e) || this.#studentCaptionText;
        this.#studentCaptionText = '';
        if (text) this.#emit({ type: 'transcript', speaker: 'student', text });
      }
      return true;
    }
    return false;
  }

  #wireSession(session: RealtimeSession): void {
    session.on('transport_event', (event) => {
      if (this.#session !== session || this.#closing) return;
      this.#handleCaptionEvent(event);
      this.#handleResponseEvent(event);
      if (event.type === 'conversation.item.input_audio_transcription.failed') {
        if (
          this.#microphoneItemId === null ||
          (this.#microphoneItemId && event.item_id !== this.#microphoneItemId)
        )
          return;
        const details = event as {
          error?: { message?: unknown };
        };
        const message =
          typeof details.error?.message === 'string' && details.error.message.trim().length > 0
            ? details.error.message
            : 'Realtime speech recognition failed';
        if (this.#oralQuestion) {
          this.#oralQuestion.nativeFailed(new Error(message));
          this.#microphoneItemId = null;
          return;
        }
        this.#emit({
          type: 'recognition_failed',
          error: new Error(message),
          nodeId: this.#resumeNodeId,
        });
        this.#microphoneItemId = null;
        return;
      }
      if (event.type === 'input_audio_buffer.speech_started') {
        this.#beginLearnerTurn(typeof event.item_id === 'string' ? event.item_id : '');
      }
      if (
        event.type === 'conversation.item.input_audio_transcription.completed' &&
        this.#microphoneItemId !== null &&
        (this.#microphoneItemId === '' || event.item_id === this.#microphoneItemId)
      ) {
        this.#microphoneItemId = null;
        const text = extractTransportEventText(event);
        if (this.#oralQuestion) {
          this.#oralQuestion.nativeTranscript(text);
          return;
        }
        if (!text.trim()) {
          this.#emit({
            type: 'recognition_failed',
            error: new Error('Realtime speech recognition returned no text'),
            nodeId: this.#resumeNodeId,
          });
          return;
        }
        const generation = this.#responseGeneration;
        void this.#waitForInterruption().then(
          () => {
            if (
              this.#session !== session ||
              this.#closing ||
              generation !== this.#responseGeneration ||
              this.#options.canInterrupt?.() === false
            ) {
              return;
            }
            // The microphone item is already in the conversation. Do not add
            // a duplicate text turn for its asynchronously delivered transcript.
            void this.#requestSpeech('answer', text, undefined, true).catch(() => undefined);
          },
          (error: unknown) => this.#emit({ type: 'error', error: toError(error) }),
        );
      }
    });
    // SDK audio_stopped is emitted at response.done, not WebRTC playback
    // drain. Its audio_interrupted echo is likewise not a learner input.
    // Only response-scoped transport buffer events may settle a spoken turn.
    session.on('agent_tool_start', (_context, _agent, realtimeTool) => {
      if (this.#session !== session || this.#closing) return;
      this.#emit({ type: 'tool_start', name: realtimeTool.name });
    });
    session.on('agent_tool_end', (_context, _agent, realtimeTool) => {
      if (this.#session !== session || this.#closing) return;
      this.#emit({ type: 'tool_end', name: realtimeTool.name });
    });
    session.on('error', ({ error }) => {
      if (this.#session !== session || this.#closing) return;
      const normalized = toError(error);
      const provider = z
        .object({
          error: z.object({ event_id: z.string().optional() }).optional(),
        })
        .safeParse(error);
      const boundary = this.#responseBoundary;
      if (
        boundary &&
        !boundary.responseId &&
        provider.success &&
        provider.data.error?.event_id === `lc-response-${boundary.token}`
      ) {
        // A rejected response.create has no response.done. The SDK releases
        // its sequencer on this same correlated error event.
        this.#releaseResponseBoundary();
        this.#cancelledTokens.delete(boundary.token);
        const turn = this.#turns.get(boundary.token);
        if (turn) {
          turn.dispatched = false;
          this.#failTurn(turn, normalized, false);
        }
        return;
      }
      if (this.#turns.size === 0) this.#emit({ type: 'error', error: normalized });
      for (const turn of this.#turns.values()) this.#failTurn(turn, normalized);
    });
    session.transport.on('connection_change', (state) => {
      if (this.#session !== session || this.#closing || state !== 'disconnected') return;
      for (const turn of this.#turns.values()) {
        this.#failTurn(turn, new Error('Realtime teacher transport disconnected'), false);
      }
      this.#invalidateAnswer();
      this.#releaseResponseBoundary();
      this.#connectionGeneration += 1;
      this.#oralQuestion?.cancel(new Error('Realtime teacher transport disconnected'));
      this.#session = null;
      this.#sessionConfig = null;
      this.#connectPromise = null;
      this.#setSpeaking(false, 'audio_interrupted');
      this.#emit({ type: 'status', status: 'closed' });
    });
  }

  #handleResponseEvent(event: Record<string, unknown>): void {
    const response =
      event.response && typeof event.response === 'object'
        ? (event.response as Record<string, unknown>)
        : undefined;
    if (event.type === 'response.created' && response) {
      const metadata =
        response.metadata && typeof response.metadata === 'object'
          ? (response.metadata as Record<string, unknown>)
          : undefined;
      const token = metadata?.livecourse_request;
      if (typeof token !== 'string' || typeof response.id !== 'string') return;
      if (this.#responseBoundary?.token === token) {
        this.#responseBoundary.responseId = response.id;
      }
      if (this.#cancelledTokens.delete(token)) {
        this.#cancelledResponseIds.add(response.id);
        try {
          this.#session?.transport.sendEvent({ type: 'response.cancel', response_id: response.id });
        } catch (error) {
          this.#emit({ type: 'error', error: toError(error) });
        }
        return;
      }
      const turn = this.#turns.get(token);
      if (!turn || turn !== this.#pendingTurn) return;
      turn.responseId = response.id;
      clearTimeout(turn.timer);
      turn.timer = setTimeout(() => {
        this.#failTurn(turn, new Error('Realtime response or audio playback timed out'));
      }, 180_000);
      return;
    }
    const id = response?.id ?? event.response_id;
    if (
      event.type === 'response.done' &&
      typeof id === 'string' &&
      id === this.#responseBoundary?.responseId
    ) {
      // Promise continuations run after the SDK finishes processing this raw
      // event and marks its response-create sequencer ready.
      this.#releaseResponseBoundary();
    }
    const turn = this.#pendingTurn;
    if (!turn || !turn.responseId || turn.responseId !== id) return;
    if (event.type === 'output_audio_buffer.started') {
      turn.audioStarted = true;
      this.#setSpeaking(true, 'audio_start');
      try {
        void this.#options.audioBridge.audioElement.play().then(
          () => {
            if (!this.#turns.has(turn.token)) return;
            turn.playbackReady = true;
            this.#finishTurn(turn);
          },
          (error: unknown) => this.#failTurn(turn, toError(error)),
        );
      } catch (error) {
        this.#failTurn(turn, toError(error));
      }
    } else if (event.type === 'output_audio_buffer.stopped') {
      turn.audioDrained = true;
    } else if (event.type === 'output_audio_buffer.cleared') {
      this.#failTurn(turn, new Error('Realtime audio playback was interrupted'), false);
      return;
    } else if (event.type === 'response.done' && response) {
      turn.completed = true;
      if (response.status !== 'completed') {
        this.#failTurn(turn, new Error(`Realtime response ${String(response.status ?? 'failed')}`));
        return;
      }
      const output = response.output;
      const hasAudio =
        Array.isArray(output) &&
        output.some((item: unknown) => {
          if (!item || typeof item !== 'object' || !('content' in item)) return false;
          return (
            Array.isArray(item.content) &&
            item.content.some(
              (content: unknown) =>
                content &&
                typeof content === 'object' &&
                'type' in content &&
                (content.type === 'audio' || content.type === 'output_audio'),
            )
          );
        });
      if (!hasAudio) {
        this.#failTurn(turn, new Error('Realtime response completed without audio'));
        return;
      }
    }
    this.#finishTurn(turn);
  }

  #captureResumeNode(): void {
    if (this.#closing || this.#resumeNodeId || this.#options.canInterrupt?.() === false) return;
    const nodeId = this.#options.getLocation()?.nodeId ?? null;
    if (!nodeId) return;
    this.#resumeNodeId = nodeId;
    this.#answerGeneration = null;
    this.#emit({ type: 'interrupted', nodeId });

    this.#startInterruptionTransaction(nodeId);
  }

  /**
   * Start the ordered local-playback/W interruption boundary and retain the
   * exact promise that represents it.  Keeping this in one helper is
   * important: a response can become stale while `resumeNode` is in flight,
   * in which case the same boundary must be started again before the newer
   * answer is allowed to resume the narrator.
   */
  #startInterruptionTransaction(nodeId: string): void {
    let commit: Promise<void>;
    try {
      commit = this.#options.interruptNode(nodeId);
    } catch (error) {
      commit = Promise.reject(error);
    }
    const interruptionPromise = Promise.resolve(commit).catch((error) => {
      const normalized = toError(error);
      if (this.#interruptionPromise === interruptionPromise) {
        this.#interruptionPromise = null;
        if (error instanceof RealtimeInterruptionUncertaintyError) {
          this.#emit({ type: 'interruption_uncertain', nodeId, error: normalized });
        } else {
          this.#resumeNodeId = null;
          this.#answerGeneration = null;
          this.#emit({ type: 'interruption_failed', nodeId, error: normalized });
        }
      }
      throw normalized;
    });
    this.#interruptionPromise = interruptionPromise;
    // The answer/resume path awaits this same promise. Keep an observer here
    // for recognition failures or disconnects where no answer ever arrives.
    void interruptionPromise.catch(() => undefined);
  }

  #queueResumeAfterAnswer(generation: number): Promise<void> {
    if (this.#closing) return Promise.reject(new RealtimeSessionClosingError());
    if (this.#queuedResumeGenerations.has(generation)) return this.#resumeQueue;
    this.#queuedResumeGenerations.add(generation);
    const operation = this.#resumeQueue.then(() => this.#resumeAfterAnswer(generation));
    this.#resumeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation.then(
      () => this.#queuedResumeGenerations.delete(generation),
      () => this.#queuedResumeGenerations.delete(generation),
    );
    return operation;
  }

  async #resumeAfterAnswer(generation: number): Promise<void> {
    const nodeId = this.#resumeNodeId;
    if (
      !nodeId ||
      this.#closing ||
      this.#answerGeneration !== generation ||
      this.#responseGeneration !== generation
    ) {
      throw speechAbortError();
    }
    const interruptionPromise = this.#interruptionPromise;
    if (interruptionPromise) {
      try {
        await interruptionPromise;
      } catch {
        // A typed uncertainty deliberately retains the node. `resumeNode`
        // reconciles the original interrupt key before attempting the resume.
        if (this.#resumeNodeId !== nodeId) return;
      }
    }
    if (
      this.#resumeNodeId !== nodeId ||
      this.#closing ||
      this.#answerGeneration !== generation ||
      this.#responseGeneration !== generation
    ) {
      return;
    }
    this.#answerGeneration = null;
    try {
      await this.#options.resumeNode(nodeId);

      // The resume operation may span several asynchronous boundaries (W
      // append, then local playback).  A newer response can begin during that
      // window.  Its audio_start invalidates this generation, so do not clear
      // the held node or announce node_resumed.  Re-enter the same
      // interruption seam after the stale resume has settled; the next
      // generation will await the newly retained interruption promise.
      if (this.#resumeNodeId !== nodeId) return;
      if (this.#closing) {
        // close() waits for this queue before attempting its own release. The
        // resume just completed successfully, so clear the held point now;
        // otherwise close would call the UI's already-settled resume handler a
        // second time and can fail with "no interruption transaction".
        this.#completeNodeResume(nodeId);
        return;
      }
      if (this.#responseGeneration !== generation) {
        this.#startInterruptionTransaction(nodeId);
        return;
      }

      // Only release the frozen point after the controller has committed the
      // explicit resume command. A failed command must leave the same point
      // available for a retry, as required by J3.2.
      this.#completeNodeResume(nodeId);
    } catch (error) {
      // A newer answer may have superseded this resume while the W/local
      // boundary was in flight. Do not surface the old rejection over the
      // newer response; its later audio_stopped event will retry the same
      // held node under the current generation.
      if (
        this.#resumeNodeId === nodeId &&
        !this.#closing &&
        this.#responseGeneration === generation
      ) {
        throw error;
      }
    }
  }

  async #releaseInterruptionBeforeClose(): Promise<void> {
    const nodeId = this.#resumeNodeId;
    if (!nodeId) return;

    const interruptionPromise = this.#interruptionPromise;
    if (interruptionPromise) {
      try {
        await interruptionPromise;
      } catch (error) {
        if (this.#resumeNodeId !== nodeId) return;
        if (!(error instanceof RealtimeInterruptionUncertaintyError)) throw error;
      }
    }
    if (this.#resumeNodeId !== nodeId) return;

    try {
      await this.#options.resumeNode(nodeId);
      this.#completeNodeResume(nodeId);
    } catch (error) {
      const normalized = toError(error);
      this.#emit({ type: 'error', error: normalized });
      throw normalized;
    }
  }

  #completeNodeResume(nodeId: string): void {
    if (this.#resumeNodeId !== nodeId) return;
    this.#resumeNodeId = null;
    this.#interruptionPromise = null;
    this.#answerGeneration = null;
    this.#emit({ type: 'node_resumed', nodeId });
  }

  #invalidateAnswer(): void {
    this.#responseGeneration += 1;
    this.#answerGeneration = null;
  }

  #setSpeaking(
    speaking: boolean,
    eventType: 'audio_start' | 'audio_stopped' | 'audio_interrupted',
  ): void {
    if (this.#speaking === speaking && eventType !== 'audio_interrupted') return;
    this.#speaking = speaking;
    this.#emit({ type: eventType });
  }

  #emit(event: RealtimeTeacherEvent): void {
    if (event.type === 'transcript' && event.speaker === 'teacher') {
      this.#oralQuestion?.teacherTranscript(event.text);
    }
    this.#options.onEvent?.(event);
  }
}
