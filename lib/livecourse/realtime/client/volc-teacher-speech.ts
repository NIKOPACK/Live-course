import type { TeacherSpeechPort } from '@/lib/livecourse/realtime/client/teacher-speech';
import type {
  RealtimeClassroomLocation,
  RealtimeTeacherEvent,
} from '@/lib/livecourse/realtime/client/session';
import { withRealtimeSpeechRetry } from '@/lib/livecourse/realtime/client/speech-retry';
import { VolcRealtimeBrowserSession } from '@/lib/livecourse/realtime/volc/client';
import type { GenerationRetryOptions } from '@/lib/generation/generation-retry';

function speechAbortError(): Error {
  return new DOMException('Realtime speech was cancelled', 'AbortError');
}

export interface VolcTeacherSpeechSessionOptions {
  getInstructions: () => string;
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

  constructor(options: VolcTeacherSpeechSessionOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await withRealtimeSpeechRetry(() => this.#connectOnce(), {
      label: 'volc.connect',
      ...this.#options.speechRetry,
    });
  }

  async speak(text: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!text.trim()) throw new Error('Realtime speech text cannot be empty');
    if (options.signal?.aborted) throw speechAbortError();
    this.#emit({ type: 'transcript', speaker: 'teacher', text });
    await withRealtimeSpeechRetry(() => this.#speakOnce(text, options.signal), {
      label: 'volc.speak',
      signal: options.signal,
      ...this.#options.speechRetry,
    });
  }

  async ask(text: string): Promise<void> {
    if (!text.trim()) throw new Error('A classroom question cannot be empty');
    this.#emit({ type: 'transcript', speaker: 'student', text });
    await this.#holdPlayback('ask');
    try {
      if (!this.connected) await this.#connectOnce();
      const session = this.#requireSession();
      await session.cancelNarration();
      await withRealtimeSpeechRetry(() => session.askQuestion(text), {
        label: 'volc.ask',
        ...this.#options.speechRetry,
      });
    } finally {
      if (this.#holdSource === 'ask') await this.#releasePlayback();
    }
  }

  mute(muted: boolean): void {
    if (!this.connected) throw new Error('Realtime teacher is not connected');
    this.#muted = muted;
    this.#session?.mute(muted);
    this.#emit({ type: 'muted', muted });
  }

  interrupt(): void {
    void this.#session?.cancelNarration();
  }

  async close(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    this.connected = false;
    this.#muted = false;
    if (session) await session.close();
    this.#emit({ type: 'status', status: 'closed' });
  }

  async #connectOnce(): Promise<void> {
    if (this.connected) return;
    this.#emit({ type: 'status', status: 'connecting' });
    await this.#session?.close().catch(() => {});
    const session = new VolcRealtimeBrowserSession({
      // HTTPS can barge in. HTTP / missing getUserMedia must still start lecture.
      captureMicrophone: shouldCaptureRealtimeMicrophone(),
      onEvent: (event) => {
        if (event.type === 'status') {
          if (event.status === 'error' || event.status === 'closed') {
            this.connected = false;
          }
          this.#emit({ type: 'status', status: event.status === 'idle' ? 'idle' : event.status });
          return;
        }
        if (event.type === 'error') {
          this.connected = false;
          this.#emit({ type: 'error', error: event.error });
          return;
        }
        if (event.type === 'learner_turn_started') {
          void this.#holdPlayback('barge');
          return;
        }
        if (event.type === 'speaking') {
          this.#emit({ type: event.speaking ? 'audio_start' : 'audio_stopped' });
          if (!event.speaking && this.#holdSource === 'barge') {
            void this.#releasePlayback();
          }
          return;
        }
        this.#emit({ type: 'transcript', speaker: event.speaker, text: event.text });
      },
    });
    this.#session = session;
    try {
      await session.preparePlayback();
      const instructions =
        this.#options.getInstructions().trim() ||
        'You are the live teacher for a single learner. Match the learner language and keep spoken turns concise.';
      await session.connect(instructions);
      this.connected = true;
    } catch (error) {
      this.connected = false;
      this.#session = null;
      this.#emit({ type: 'status', status: 'error' });
      throw error;
    }
  }

  async #speakOnce(text: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw speechAbortError();
    if (!this.connected) await this.#connectOnce();
    const session = this.#requireSession();
    const abort = () => {
      void session.cancelNarration();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await session.speakText(text);
      if (signal?.aborted) throw speechAbortError();
    } catch (error) {
      if (isSessionLostError(error)) this.connected = false;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async #holdPlayback(source: 'ask' | 'barge'): Promise<void> {
    if (this.#heldNodeId) return;
    const nodeId = this.#options.getLocation?.()?.nodeId;
    const interruptNode = this.#options.interruptNode;
    if (!nodeId || !interruptNode || this.#options.canInterrupt?.() === false) {
      if (source === 'ask') await this.#session?.cancelNarration();
      return;
    }
    this.#heldNodeId = nodeId;
    this.#holdSource = source;
    this.#emit({ type: 'interrupted', nodeId });
    try {
      await interruptNode(nodeId);
    } catch (error) {
      this.#heldNodeId = null;
      this.#holdSource = null;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#emit({ type: 'interruption_failed', nodeId, error: failure });
      throw failure;
    }
  }

  async #releasePlayback(): Promise<void> {
    const nodeId = this.#heldNodeId;
    if (!nodeId) return;
    try {
      await this.#options.resumeNode?.(nodeId);
      this.#emit({ type: 'node_resumed', nodeId });
    } finally {
      this.#heldNodeId = null;
      this.#holdSource = null;
    }
  }

  #requireSession(): VolcRealtimeBrowserSession {
    if (!this.#session || !this.connected) throw new Error('Realtime teacher is not connected');
    return this.#session;
  }

  #emit(event: RealtimeTeacherEvent): void {
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
  return /not connected|disconnected|session not found|session closed/i.test(message);
}
