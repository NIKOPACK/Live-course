import type { TeacherSpeechPort } from '@/lib/livecourse/realtime/client/teacher-speech';
import type { RealtimeTeacherEvent } from '@/lib/livecourse/realtime/client/session';
import { VolcRealtimeBrowserSession } from '@/lib/livecourse/realtime/volc/client';

function speechAbortError(): Error {
  return new DOMException('Realtime speech was cancelled', 'AbortError');
}

export interface VolcTeacherSpeechSessionOptions {
  getInstructions: () => string;
  onEvent?: (event: RealtimeTeacherEvent) => void;
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

  constructor(options: VolcTeacherSpeechSessionOptions) {
    this.#options = options;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.#emit({ type: 'status', status: 'connecting' });
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: true,
      onEvent: (event) => {
        if (event.type === 'status') {
          this.#emit({ type: 'status', status: event.status === 'idle' ? 'idle' : event.status });
          return;
        }
        if (event.type === 'error') {
          this.#emit({ type: 'error', error: event.error });
          return;
        }
        if (event.type === 'speaking') {
          this.#emit({ type: event.speaking ? 'audio_start' : 'audio_stopped' });
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

  async speak(text: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const session = this.#requireSession();
    if (!text.trim()) throw new Error('Realtime speech text cannot be empty');
    if (options.signal?.aborted) throw speechAbortError();

    const abort = () => {
      void session.close();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    this.#emit({ type: 'transcript', speaker: 'teacher', text });
    try {
      await session.speakText(text);
      if (options.signal?.aborted) throw speechAbortError();
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async ask(text: string): Promise<void> {
    if (!text.trim()) throw new Error('A classroom question cannot be empty');
    this.#emit({ type: 'transcript', speaker: 'student', text });
    await this.speak(
      `学生提问：${text}。请先确认收到，再简短回答，最后明确说明回到原来的教学节点。`,
    );
  }

  mute(muted: boolean): void {
    if (!this.connected) throw new Error('Realtime teacher is not connected');
    this.#muted = muted;
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

  #requireSession(): VolcRealtimeBrowserSession {
    if (!this.#session || !this.connected) throw new Error('Realtime teacher is not connected');
    return this.#session;
  }

  #emit(event: RealtimeTeacherEvent): void {
    this.#options.onEvent?.(event);
  }
}
