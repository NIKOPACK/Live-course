import type { TeacherSpeechPort } from '@/lib/livecourse/realtime/client/teacher-speech';
import {
  RealtimeInterruptionUncertaintyError,
  RealtimeSessionClosingError,
  type RealtimeClassroomLocation,
  type RealtimeTeacherEvent,
} from '@/lib/livecourse/realtime/client/session';
import { withRealtimeSpeechRetry } from '@/lib/livecourse/realtime/client/speech-retry';
import { VolcRealtimeBrowserSession } from '@/lib/livecourse/realtime/volc/client';
import { isVolcAudioInputTimeout } from '@/lib/livecourse/realtime/volc/protocol';
import type { GenerationRetryOptions } from '@/lib/generation/generation-retry';
import { OralQuestionSession, type OralQuestionOptions } from './oral-question';
import type { OralQuestion } from '@/lib/livecourse/domain/schemas';
import { buildRealtimeTeacherInstructions } from '@/lib/livecourse/realtime/teacher-instructions';

function speechAbortError(): Error {
  return new DOMException('Realtime speech was cancelled', 'AbortError');
}

export interface VolcTeacherSpeechSessionOptions {
  getInstructions: () => string;
  readOnly?: boolean;
  onEvent?: (event: RealtimeTeacherEvent) => void;
  getLocation?: () => RealtimeClassroomLocation | null;
  canInterrupt?: () => boolean;
  interruptNode?: (nodeId: string) => Promise<void>;
  resumeNode?: (nodeId: string) => Promise<void>;
  speechRetry?: Pick<
    GenerationRetryOptions<void>,
    'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'sleep' | 'random' | 'onRetry'
  >;
}

/**
 * Classroom TeacherSpeechPort backed by the existing Volc Seeduplex relay.
 * Used when the operator configured VOLCENGINE_REALTIME_API_KEY and the LLM
 * OpenAI-compatible gateway is not official OpenAI Realtime.
 */
export class VolcTeacherSpeechSession implements TeacherSpeechPort {
  readonly #options: VolcTeacherSpeechSessionOptions;
  #session: VolcRealtimeBrowserSession | null = null;
  connected = false;
  #muted = false;
  #heldNodeId: string | null = null;
  #holdSource: 'ask' | 'barge' | null = null;
  #holdPending: Promise<void> | null = null;
  #resumeQueue: Promise<void> = Promise.resolve();
  #responseGeneration = 0;
  #instructions: string | null = null;
  #oralQuestion: OralQuestionSession | null = null;
  #oralReleased: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | null = null;
  #connectionGeneration = 0;
  #connectPromise: Promise<void> | null = null;

  constructor(options: VolcTeacherSpeechSessionOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    const generation = this.#connectionGeneration;
    this.#assertConnectionCurrent(generation);
    if (this.connected) return;
    await withRealtimeSpeechRetry(
      () => {
        this.#assertConnectionCurrent(generation);
        return this.#connectOnce();
      },
      {
        label: 'volc.connect',
        ...this.#options.speechRetry,
      },
    );
  }

  async speak(text: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const generation = this.#connectionGeneration;
    this.#assertConnectionCurrent(generation);
    if (this.#oralQuestion?.closed) await this.#oralReleased;
    this.#assertConnectionCurrent(generation);
    if (!text.trim()) throw new Error('Realtime speech text cannot be empty');
    if (options.signal?.aborted) throw speechAbortError();
    this.#emit({ type: 'transcript', speaker: 'teacher', text });
    await withRealtimeSpeechRetry(
      () => {
        this.#assertConnectionCurrent(generation);
        return this.#speakOnce(text, options.signal);
      },
      {
        label: 'volc.speak',
        signal: options.signal,
        ...this.#options.speechRetry,
      },
    );
  }

  async ask(text: string): Promise<void> {
    if (this.#closing) throw new RealtimeSessionClosingError();
    if (this.#options.readOnly) throw new Error('Replay does not accept learner questions');
    if (this.#oralQuestion) return this.#oralQuestion.answer(text);
    if (!text.trim()) throw new Error('A classroom question cannot be empty');
    const generation = ++this.#responseGeneration;
    this.#emit({ type: 'transcript', speaker: 'student', text });
    await this.#holdPlayback('ask');
    this.#session?.setInputEnabled(false);
    try {
      await withRealtimeSpeechRetry(
        async () => {
          if (generation !== this.#responseGeneration) throw speechAbortError();
          if (!this.connected) await this.#connectOnce();
          const session = this.#requireSession();
          try {
            session.setInputEnabled(false);
            await session.cancelNarration();
            await this.#syncInstructions(session);
            if (generation !== this.#responseGeneration) throw speechAbortError();
            await session.askQuestion(text, { requireAudio: true });
          } catch (error) {
            if (isSessionLostError(error)) this.connected = false;
            throw error;
          }
        },
        {
          label: 'volc.ask',
          ...this.#options.speechRetry,
        },
      );
      if (generation !== this.#responseGeneration) throw speechAbortError();
      await this.#queueReleasePlayback(generation);
    } finally {
      if (this.connected && this.#session && !this.#closing && !this.#options.readOnly) {
        this.#session.setInputEnabled(true);
      }
    }
  }

  async question(question: OralQuestion, options: OralQuestionOptions): Promise<void> {
    if (this.#options.readOnly) throw new Error('Replay does not start oral questions');
    if (this.#oralQuestion) throw new Error('An oral question is already active');
    const session = this.#requireSession();
    const oral = new OralQuestionSession(
      question,
      {
        speak: (text, signal) => this.speak(text, { signal }),
        respond: async (text, signal) => {
          if (signal.aborted) throw speechAbortError();
          const cancel = () => {
            void session.cancelNarration().catch(() => {
              /* The browser session reports cancellation failures and closes. */
            });
          };
          signal.addEventListener('abort', cancel, { once: true });
          try {
            if (signal.aborted) throw speechAbortError();
            await session.askQuestion(text, { requireAudio: true });
            if (signal.aborted) throw speechAbortError();
          } finally {
            signal.removeEventListener('abort', cancel);
          }
        },
        updateInstructions: (instructions) => session.updateInstructions(instructions),
        setListening: (enabled) => session.setInputEnabled(enabled),
        cancel: () => session.cancelNarration(),
        manualMicrophoneResponse: false,
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
      try {
        if (this.connected && this.#session === session && !this.#closing) {
          await session.cancelNarration();
          await session.updateInstructions(this.#currentInstructions());
        }
      } finally {
        this.#oralQuestion = null;
        if (this.connected && this.#session === session && !this.#closing) {
          session.setInputEnabled(true);
        }
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

  mute(muted: boolean): void {
    if (!this.connected) throw new Error('Realtime teacher is not connected');
    this.#muted = muted;
    this.#session?.mute(muted);
    this.#emit({ type: 'muted', muted });
  }

  interrupt(): void {
    this.#responseGeneration += 1;
    void this.#session?.cancelNarration().catch(() => {
      /* The browser session reports cancellation failures and closes. */
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const operation = this.#close();
    this.#closePromise = operation;
    const finish = () => {
      if (this.#closePromise === operation) {
        this.#closePromise = null;
        this.#closing = false;
      }
    };
    void operation.then(finish, finish);
    return operation;
  }

  async #close(): Promise<void> {
    this.#closing = true;
    this.#connectionGeneration += 1;
    this.#connectPromise = null;
    this.#responseGeneration += 1;
    this.#oralQuestion?.cancel(new Error('Realtime teacher connection was closed'));
    // Let a pending resume settle before releasing any remaining frozen node.
    await this.#resumeQueue;
    await this.#queueReleasePlayback(this.#responseGeneration);
    const session = this.#session;
    if (session) await session.close();
    this.#session = null;
    this.#instructions = null;
    this.connected = false;
    this.#muted = false;
    this.#emit({ type: 'status', status: 'closed' });
  }

  async #connectOnce(): Promise<void> {
    if (this.#closing) throw new RealtimeSessionClosingError();
    if (this.connected) return;
    if (this.#connectPromise) return this.#connectPromise;
    const generation = this.#connectionGeneration;
    const operation = Promise.resolve().then(() => {
      this.#assertConnectionCurrent(generation);
      return this.#openConnection();
    });
    this.#connectPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#connectPromise === operation) this.#connectPromise = null;
    }
  }

  async #openConnection(): Promise<void> {
    if (this.#closing) throw new RealtimeSessionClosingError();
    if (this.connected) return;
    const generation = this.#connectionGeneration;
    this.#emit({ type: 'status', status: 'connecting' });
    await this.#session?.close();
    this.#assertConnectionCurrent(generation);
    const session = new VolcRealtimeBrowserSession({
      // HTTPS can barge in. HTTP / missing getUserMedia must still start lecture.
      captureMicrophone: !this.#options.readOnly && shouldCaptureRealtimeMicrophone(),
      onEvent: (event) => {
        if (this.#session !== session || this.#closing) return;
        if (event.type === 'status') {
          if (event.status === 'error' || event.status === 'closed') {
            this.connected = false;
            this.#oralQuestion?.cancel(new Error('Realtime teacher connection was closed'));
          }
          this.#emit({ type: 'status', status: event.status === 'idle' ? 'idle' : event.status });
          return;
        }
        if (event.type === 'error') {
          this.connected = false;
          this.#oralQuestion?.cancel(event.error);
          this.#emit({ type: 'error', error: event.error });
          return;
        }
        if (event.type === 'learner_turn_started') {
          if (this.#oralQuestion) {
            this.#oralQuestion.nativeStarted();
            return;
          }
          this.#responseGeneration += 1;
          // The transaction reports its failure before rejecting.
          void this.#holdPlayback('barge').catch(() => undefined);
          return;
        }
        if (event.type === 'speaking') {
          this.#emit({ type: event.speaking ? 'audio_start' : 'audio_stopped' });
          return;
        }
        if (event.type === 'audio_completed') {
          if (this.#oralQuestion) {
            if (event.hasAudio) this.#oralQuestion.nativeCompleted();
            else
              this.#oralQuestion.nativeFailed(
                new Error('Teacher response completed without audio'),
              );
          } else if (this.#holdSource === 'barge') {
            if (!event.hasAudio) {
              this.#emit({
                type: 'error',
                error: new Error('Teacher response completed without audio'),
              });
            } else {
              void this.#queueReleasePlayback(this.#responseGeneration).catch((cause) => {
                this.#emit({
                  type: 'error',
                  error: cause instanceof Error ? cause : new Error(String(cause)),
                });
              });
            }
          }
          return;
        }
        if (event.type === 'learner_answer') {
          this.#oralQuestion?.nativeTranscript(event.text);
          return;
        }
        if (event.type === 'recognition_failed') {
          if (this.#oralQuestion) this.#oralQuestion.nativeFailed(event.error);
          else
            this.#emit({
              type: 'recognition_failed',
              error: event.error,
              nodeId: this.#heldNodeId,
            });
          return;
        }
        this.#emit({ type: 'transcript', speaker: event.speaker, text: event.text });
      },
    });
    this.#session = session;
    if (this.#muted) session.mute(true);
    if (this.#options.readOnly) session.setInputEnabled(false);
    try {
      await session.preparePlayback();
      if (this.#session !== session || this.#closing) throw speechAbortError();
      const instructions = this.#currentInstructions();
      await session.connect(instructions);
      if (this.#session !== session || this.#closing) {
        await session.close();
        throw speechAbortError();
      }
      this.#instructions = instructions;
      this.connected = true;
    } catch (error) {
      if (this.#session === session && !this.#closing) {
        this.connected = false;
        this.#session = null;
        this.#emit({ type: 'status', status: 'error' });
      }
      throw error;
    }
  }

  async #speakOnce(text: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw speechAbortError();
    if (!this.connected) await this.#connectOnce();
    const session = this.#requireSession();
    const generation = this.#responseGeneration;
    const abort = () => {
      // A native learner turn already cancelled the old narration. Do not
      // cancel the new answer while freezing that narration's playback.
      if (generation !== this.#responseGeneration) return;
      void session.cancelNarration().catch(() => {
        /* The browser session reports cancellation failures and closes. */
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (!this.#oralQuestion) await this.#syncInstructions(session);
      if (signal?.aborted || generation !== this.#responseGeneration) throw speechAbortError();
      await session.speakText(text, { requireAudio: true });
      if (signal?.aborted) throw speechAbortError();
    } catch (error) {
      if (isSessionLostError(error)) this.connected = false;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async #holdPlayback(source: 'ask' | 'barge'): Promise<void> {
    if (this.#heldNodeId) {
      this.#holdSource = source;
      return this.#holdPending ?? undefined;
    }
    const nodeId = this.#options.getLocation?.()?.nodeId;
    const interruptNode = this.#options.interruptNode;
    if (
      this.#options.readOnly ||
      !nodeId ||
      !interruptNode ||
      this.#options.canInterrupt?.() === false
    ) {
      if (source === 'ask') await this.#session?.cancelNarration();
      return;
    }
    this.#heldNodeId = nodeId;
    this.#holdSource = source;
    this.#emit({ type: 'interrupted', nodeId });
    return this.#startHold(nodeId);
  }

  #startHold(nodeId: string): Promise<void> {
    const pending = Promise.resolve()
      .then(async () => {
        if (!this.#options.interruptNode)
          throw new Error('Classroom interruption is not configured');
        await this.#options.interruptNode(nodeId);
      })
      .catch((cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (this.#holdPending === pending) {
          this.#holdPending = null;
          if (cause instanceof RealtimeInterruptionUncertaintyError) {
            this.#emit({ type: 'interruption_uncertain', nodeId, error });
          } else {
            this.#heldNodeId = null;
            this.#holdSource = null;
            this.#emit({ type: 'interruption_failed', nodeId, error });
          }
        }
        throw error;
      });
    this.#holdPending = pending;
    return pending;
  }

  #queueReleasePlayback(generation: number): Promise<void> {
    const operation = this.#resumeQueue.then(() => this.#releasePlayback(generation));
    this.#resumeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #releasePlayback(generation: number): Promise<void> {
    const nodeId = this.#heldNodeId;
    if (!nodeId) return;
    try {
      await this.#holdPending;
    } catch (cause) {
      if (this.#heldNodeId !== nodeId) return;
      if (!(cause instanceof RealtimeInterruptionUncertaintyError)) throw cause;
    }
    if (this.#heldNodeId !== nodeId || generation !== this.#responseGeneration) return;
    if (!this.#options.resumeNode) throw new Error('Classroom resume is not configured');
    await this.#options.resumeNode(nodeId);
    if (this.#heldNodeId !== nodeId) return;
    if (generation !== this.#responseGeneration && !this.#closing) {
      await this.#startHold(nodeId);
      return;
    }
    this.#heldNodeId = null;
    this.#holdSource = null;
    this.#holdPending = null;
    this.#emit({ type: 'node_resumed', nodeId });
  }

  #currentInstructions(): string {
    return buildRealtimeTeacherInstructions(this.#options.getInstructions().trim());
  }

  async #syncInstructions(session: VolcRealtimeBrowserSession): Promise<void> {
    if (this.#session !== session || !this.connected) throw speechAbortError();
    const instructions = this.#currentInstructions();
    if (instructions === this.#instructions) return;
    await session.updateInstructions(instructions);
    if (this.#session !== session || !this.connected) throw speechAbortError();
    this.#instructions = instructions;
  }

  #requireSession(): VolcRealtimeBrowserSession {
    if (this.#closing) throw new RealtimeSessionClosingError();
    if (!this.#session || !this.connected) throw new Error('Realtime teacher is not connected');
    return this.#session;
  }

  #assertConnectionCurrent(generation: number): void {
    if (this.#closing || generation !== this.#connectionGeneration) {
      throw new RealtimeSessionClosingError();
    }
  }

  #emit(event: RealtimeTeacherEvent): void {
    if (event.type === 'transcript' && event.speaker === 'teacher') {
      this.#oralQuestion?.teacherTranscript(event.text);
    }
    this.#options.onEvent?.(event);
  }
}

export function shouldCaptureRealtimeMicrophone(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function isSessionLostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    /not connected|disconnected|session not found|session closed/i.test(message) ||
    isVolcAudioInputTimeout(error)
  );
}
