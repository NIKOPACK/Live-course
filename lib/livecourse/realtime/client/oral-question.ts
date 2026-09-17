import { oralQuestionSchema, type OralQuestion } from '@/lib/livecourse/domain/schemas';

export interface OralQuestionState {
  phase: 'asking' | 'waiting' | 'listening' | 'responding' | 'failed' | 'ending';
  question: string;
  teacherText: string;
  answer: string;
  answeredRounds: number;
  error: string | null;
}

export interface OralQuestionOptions {
  signal?: AbortSignal;
  hintText: string;
  resumeText: string;
}

interface OralQuestionTransport {
  speak(text: string, signal: AbortSignal): Promise<void>;
  respond(text: string, signal: AbortSignal, native: boolean): Promise<void>;
  updateInstructions(instructions: string): Promise<void>;
  setListening(listening: boolean): void;
  cancel(): Promise<void>;
  manualMicrophoneResponse: boolean;
  onState(state: OralQuestionState): void;
}

const MAX_ANSWERS = 3;
const RESPONSE_TIMEOUT_MS = 90_000;
const abortError = () => new DOMException('Oral question cancelled', 'AbortError');

/** One optional, formative conversation owned by one cancellable playback sentence. */
export class OralQuestionSession {
  readonly #question: OralQuestion;
  readonly #port: OralQuestionTransport;
  readonly #options: OralQuestionOptions;
  readonly #controller = new AbortController();
  #state: OralQuestionState;
  #resolve!: () => void;
  #reject!: (error: Error) => void;
  #closed = false;
  #started = false;
  #retry: (() => Promise<void>) | null = null;
  #native = false;
  #nativeAudioCompleted = false;
  #nativeFinal = false;
  #nativeTimer: ReturnType<typeof setTimeout> | null = null;
  #instructions = '';
  #prompt: string;
  #operation: Promise<void> = Promise.resolve();

  constructor(question: OralQuestion, port: OralQuestionTransport, options: OralQuestionOptions) {
    this.#question = oralQuestionSchema.parse(question);
    this.#prompt = question.question;
    this.#port = port;
    this.#options = options;
    this.#state = {
      phase: 'asking',
      question: question.question,
      teacherText: question.question,
      answer: '',
      answeredRounds: 0,
      error: null,
    };
  }

  get instructions(): string {
    return this.#instructions;
  }
  get state(): OralQuestionState {
    return this.#state;
  }
  get closed(): boolean {
    return this.#closed;
  }

  async run(): Promise<void> {
    if (this.#started) throw new Error('Oral question already started');
    this.#started = true;
    const completion = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    const cancel = () => this.cancel();
    this.#options.signal?.addEventListener('abort', cancel, { once: true });
    if (this.#options.signal?.aborted) this.cancel();
    else {
      this.#publish({ phase: 'asking' });
      void this.#attempt(async () => {
        await this.#configure(false);
        await this.#port.speak(this.#question.question, this.#controller.signal);
        this.#retry = () => this.#wait();
        await this.#wait();
      }).catch(() => {
        /* The failed operation is exposed by the retryable state. */
      });
    }
    try {
      await completion;
    } finally {
      this.#options.signal?.removeEventListener('abort', cancel);
      this.#clearNative();
      // Restore provider instructions only after in-flight context writes settle.
      await this.#operation.catch(() => undefined);
    }
  }

  async answer(text: string): Promise<void> {
    if (this.#state.phase !== 'waiting' || this.#closed)
      throw new Error('Oral question is not waiting for an answer');
    const answer = text.trim();
    if (!answer) throw new Error('An oral answer cannot be empty');
    this.#publish({ phase: 'responding', answer, teacherText: '', error: null });
    await this.#attempt(() => this.#respond(answer, false, false));
  }

  async hint(): Promise<void> {
    if (this.#state.phase !== 'waiting' || this.#closed)
      throw new Error('Oral hints are not available now');
    this.#publish({ phase: 'responding', teacherText: '', error: null });
    await this.#attempt(() => this.#respond(this.#options.hintText, false, true));
  }

  async retry(): Promise<void> {
    if (this.#state.phase !== 'failed' || !this.#retry || this.#closed)
      throw new Error('No oral question operation to retry');
    this.#publish({ phase: 'responding', error: null });
    await this.#attempt(this.#retry);
  }

  async end(): Promise<void> {
    if (!['waiting', 'failed'].includes(this.#state.phase) || this.#closed)
      throw new Error('Wait for the teacher before continuing');
    this.#clearNative();
    this.#publish({ phase: 'ending', error: null });
    await this.#attempt(async () => {
      await this.#port.cancel();
      await this.#port.speak(this.#options.resumeText, this.#controller.signal);
      this.#finish();
    });
  }

  nativeStarted(): boolean {
    if (this.#state.phase !== 'waiting' || this.#closed) return false;
    this.#native = true;
    this.#nativeFinal = false;
    this.#nativeAudioCompleted = false;
    this.#publish({ phase: 'listening', answer: '', teacherText: '', error: null });
    this.#nativeTimer = setTimeout(
      () => this.nativeFailed(new Error('Oral response timed out')),
      RESPONSE_TIMEOUT_MS,
    );
    return true;
  }

  nativeTranscript(text: string): void {
    if (!this.#native || this.#nativeFinal || this.#closed) return;
    if (!text.trim()) {
      this.nativeFailed(new Error('Speech recognition returned no text'));
      return;
    }
    this.#nativeFinal = true;
    this.#publish({ answer: text.trim(), phase: 'responding' });
    // Learner-turn hang detection ends when a transcript is accepted; teacher
    // duplex audio is not part of this budget (J3.2a).
    this.#clearNativeTimer();
    if (this.#port.manualMicrophoneResponse) {
      this.#native = false;
      void this.#attempt(() => this.#respond(text.trim(), true, false)).catch(() => {
        /* The same answer remains available for retry. */
      });
    } else this.#finishNativeIfReady();
  }

  nativeCompleted(): void {
    if (!this.#native || this.#closed || this.#port.manualMicrophoneResponse) return;
    this.#nativeAudioCompleted = true;
    this.#finishNativeIfReady();
  }

  nativeFailed(error: Error): void {
    if (!this.#native || this.#closed) return;
    const answer = this.#state.answer;
    this.#clearNative();
    const retryAnswer = () => (answer ? this.#respond(answer, false, false) : this.#wait());
    this.#publish({ phase: 'responding', error: error.message });
    void this.#attempt(
      async () => {
        await this.#port.cancel();
        this.#retry = retryAnswer;
        this.#publish({ phase: 'failed', error: error.message });
      },
      async () => {
        await this.#port.cancel();
        await retryAnswer();
      },
    ).catch(() => {
      /* Cancellation failures keep input closed and expose the same retry. */
    });
  }

  teacherTranscript(text: string): void {
    if (
      !this.#closed &&
      ['asking', 'responding', 'listening', 'ending'].includes(this.#state.phase)
    ) {
      this.#publish({ teacherText: text });
    }
  }

  cancel(error: Error = abortError()): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearNative();
    this.#controller.abort();
    this.#port.setListening(false);
    this.#reject?.(error);
  }

  async #respond(text: string, native: boolean, hint: boolean): Promise<void> {
    await this.#configure(hint);
    await this.#port.respond(text, this.#controller.signal, native);
    this.#retry = () => this.#advance(hint);
    await this.#advance(hint);
  }

  async #advance(hint: boolean): Promise<void> {
    if (this.#closed) return;
    const rounds = this.#state.answeredRounds + (hint ? 0 : 1);
    if (rounds >= MAX_ANSWERS) {
      this.#publish({ answeredRounds: rounds, phase: 'ending' });
      this.#finish();
      return;
    }
    if (this.#state.teacherText.trim()) this.#prompt = this.#state.teacherText;
    // Configure the next native response BEFORE reopening the microphone.
    await this.#configure(false, rounds);
    this.#publish({ answeredRounds: rounds, phase: 'waiting', error: null });
  }

  async #wait(): Promise<void> {
    if (this.#closed) return;
    await this.#configure(false);
    this.#publish({ phase: 'waiting', error: null });
  }

  async #configure(hint: boolean, rounds = this.#state.answeredRounds): Promise<void> {
    if (this.#closed) throw abortError();
    this.#instructions = [
      'You are conducting a short oral dialogue with one learner in the middle of a lesson.',
      'Speak only as the teacher, in the language of the question. Never invent a learner answer or answer your own question.',
      'Keep each response concise: at most 120 words, with at most one question.',
      `Original question: ${this.#question.question}`,
      `Teacher-only reasoning and misconceptions: ${this.#question.guidance}`,
      `Latest teacher question / feedback: ${this.#prompt}`,
      hint
        ? 'The learner requested a hint, not a new answer. Give ONE helpful hint without revealing the solution, then repeat the unanswered question and wait.'
        : rounds >= MAX_ANSWERS - 1
          ? 'This is the final answer round. Respond to the actual learner answer, explain any remaining misconception, then explicitly say we are returning to the lesson. Do NOT ask another question.'
          : 'Respond to the actual learner answer, not a generic question. If sound, briefly acknowledge the reasoning and ask ONE why/application follow-up. If mistaken or unsure, give ONE scaffold and ask ONE easier follow-up. Stop speaking after that question and wait.',
      'Do not call tools, navigate, grade, infer mastery, or claim any checkpoint is complete.',
    ].join('\n');
    await this.#port.updateInstructions(this.#instructions);
    if (this.#closed) throw abortError();
  }

  async #attempt(operation: () => Promise<void>, retry = operation): Promise<void> {
    this.#retry = retry;
    try {
      this.#operation = operation();
      await this.#operation;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (!this.#closed) this.#publish({ phase: 'failed', error: error.message });
      throw error;
    }
  }

  #finishNativeIfReady(): void {
    if (!this.#nativeFinal || !this.#nativeAudioCompleted) return;
    this.#clearNative();
    void this.#attempt(() => this.#advance(false)).catch(() => {
      /* A context refresh failure must not reopen input. */
    });
  }

  #clearNativeTimer(): void {
    if (this.#nativeTimer) clearTimeout(this.#nativeTimer);
    this.#nativeTimer = null;
  }

  #clearNative(): void {
    this.#clearNativeTimer();
    this.#native = false;
  }

  #publish(update: Partial<OralQuestionState>): void {
    if (this.#closed) return;
    this.#state = { ...this.#state, ...update };
    this.#port.setListening(['waiting', 'listening'].includes(this.#state.phase));
    this.#port.onState(this.#state);
  }

  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearNative();
    this.#port.setListening(false);
    this.#resolve();
  }
}

/** J3.2a: replay and in-class relisten play the script and do not open the oral port. */
export function shouldBindOralQuestionPort(input: {
  relistening: boolean;
  classroomState?: string | null;
}): boolean {
  return !input.relistening && input.classroomState !== 'replaying';
}
