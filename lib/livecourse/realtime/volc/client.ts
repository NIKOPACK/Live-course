'use client';

import {
  extractVolcEventText,
  isVolcSessionFailure,
  volcErrorMessage,
  VOLC_INPUT_FRAME_BYTES,
  VOLC_INPUT_SAMPLE_RATE,
  VOLC_MAX_INPUT_BUFFER_BYTES,
  VOLC_OUTPUT_SAMPLE_RATE,
  type VolcRealtimeAction,
  type VolcRealtimeRelayEvent,
  type VolcRealtimeUpstreamEvent,
  type VolcRealtimeVoice,
} from './protocol';
import { registerLipSyncAudioNode } from '@/lib/livecourse/realtime/client/audio-bridge';
import { createLogger } from '@/lib/logger';
import { getCurrentModelConfig } from '@/lib/utils/model-config';

const REALTIME_API_URL = '/api/livecourse/realtime/volc';
const RECORDER_BUFFER_SIZE = 4_096;
const CONNECTION_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 10_000;
const MODEL_SPEECH_TIMEOUT_MS = 60_000;
const INPUT_BATCH_INTERVAL_MS = 100;
const MAX_INPUT_BATCH_BYTES = VOLC_INPUT_FRAME_BYTES * 25;
const INPUT_REQUEST_TIMEOUT_MS = 10_000;
const log = createLogger('VolcRealtimeBrowserSession');

export type VolcRealtimeBrowserStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export type VolcRealtimeBrowserEvent =
  | { type: 'status'; status: VolcRealtimeBrowserStatus }
  | { type: 'transcript'; speaker: 'teacher' | 'student'; text: string }
  | { type: 'speaking'; speaking: boolean }
  | { type: 'audio_completed'; hasAudio: boolean }
  | { type: 'learner_turn_started' }
  | { type: 'learner_answer'; text: string }
  | { type: 'recognition_failed'; error: Error }
  | { type: 'error'; error: Error };

interface VolcRealtimeBrowserSessionOptions {
  onEvent?: (event: VolcRealtimeBrowserEvent) => void;
  fetchImpl?: typeof fetch;
  eventSourceFactory?: (url: string) => EventSource;
  captureMicrophone?: boolean;
  voice?: VolcRealtimeVoice;
  /** Learner-saved Volc key. Omitted when the server already has the env key. */
  apiKey?: string;
}

interface PendingSpeech {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number;
  requireAudio: boolean;
  hasAudio: boolean;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withCloseTimeout(close: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const closing = close(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Volc realtime session close timed out; retry close');
      controller.abort(error);
      reject(error);
    }, CLOSE_TIMEOUT_MS);
  });
  try {
    await Promise.race([closing, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

let sharedPlaybackContext: AudioContext | null = null;

async function activatePlaybackContext(): Promise<AudioContext> {
  if (!sharedPlaybackContext || sharedPlaybackContext.state === 'closed') {
    sharedPlaybackContext = new AudioContext({ sampleRate: VOLC_OUTPUT_SAMPLE_RATE });
  }
  if (sharedPlaybackContext.state === 'suspended') {
    // Firefox never resolves resume() without a user gesture. Auto-start
    // must not wait forever before the Volc relay handshake.
    await Promise.race([
      sharedPlaybackContext.resume(),
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, 1_500);
      }),
    ]);
  }
  return sharedPlaybackContext;
}

export function downsampleToPcm16(
  input: Float32Array,
  inputRate: number,
  targetRate = VOLC_INPUT_SAMPLE_RATE,
): Uint8Array {
  const ratio = inputRate / targetRate;
  const sampleCount = Math.floor(input.length / ratio);
  const bytes = new Uint8Array(sampleCount * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < sampleCount; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), input.length);
    let sum = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      sum += input[sourceIndex];
    }
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    const pcm = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
    view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, pcm, true);
  }

  return bytes;
}

class PcmStreamPlayer {
  #stopped = false;
  #nextPlayTime = 0;
  readonly #sources = new Set<AudioBufferSourceNode>();
  readonly #drainWaiters = new Set<() => void>();
  #tap: GainNode | null = null;
  #releaseLipSync: (() => void) | null = null;

  async enqueue(bytes: Uint8Array): Promise<void> {
    if (bytes.length < Int16Array.BYTES_PER_ELEMENT) return;
    const context = await this.#activate();
    if (this.#stopped) return;
    const samples = Math.floor(bytes.length / Int16Array.BYTES_PER_ELEMENT);
    const buffer = context.createBuffer(1, samples, VOLC_OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < samples; index += 1) {
      channel[index] = view.getInt16(index * Int16Array.BYTES_PER_ELEMENT, true) / 0x8000;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    if (this.#tap) source.connect(this.#tap);
    source.onended = () => {
      this.#sources.delete(source);
      source.disconnect();
      if (this.#sources.size === 0) this.#resolveDrain();
    };
    const startAt = Math.max(this.#nextPlayTime, context.currentTime + 0.01);
    source.start(startAt);
    this.#sources.add(source);
    this.#nextPlayTime = startAt + buffer.duration;
  }

  async prepare(): Promise<void> {
    await this.#activate();
  }

  async finish(): Promise<void> {
    if (this.#sources.size === 0) return;
    await new Promise<void>((resolve) => this.#drainWaiters.add(resolve));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const source of this.#sources) {
      source.stop();
      source.disconnect();
    }
    this.#sources.clear();
    this.#nextPlayTime = 0;
    this.#resolveDrain();
  }

  #resolveDrain(): void {
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }

  dispose(): void {
    this.#releaseLipSync?.();
    this.#releaseLipSync = null;
    this.#tap = null;
  }

  async #activate(): Promise<AudioContext> {
    const context = await activatePlaybackContext();
    if (!this.#tap && !this.#stopped) {
      this.#tap = context.createGain();
      this.#tap.gain.value = 1;
      this.#releaseLipSync = registerLipSyncAudioNode(this.#tap);
    }
    return context;
  }
}

export class VolcRealtimeBrowserSession {
  readonly #options: VolcRealtimeBrowserSessionOptions;
  readonly #audioChunks: Uint8Array[] = [];
  #sessionId: string | null = null;
  #eventSource: EventSource | null = null;
  #mediaStream: MediaStream | null = null;
  #recorderContext: AudioContext | null = null;
  #recorderSource: MediaStreamAudioSourceNode | null = null;
  #recorderNode: ScriptProcessorNode | null = null;
  #frameTimer: number | null = null;
  #bufferedBytes = 0;
  #inputState = Promise.resolve();
  #inputAbort = new AbortController();
  #sendingInput = false;
  #player: PcmStreamPlayer | null = null;
  #assistantText = '';
  #connectResolve: (() => void) | null = null;
  #connectReject: ((error: Error) => void) | null = null;
  #connectPromise: Promise<void> | null = null;
  #connectAbort: AbortController | null = null;
  #closePromise: Promise<void> | null = null;
  #closeCompleted = false;
  readonly #remoteClosures = new Map<string, Promise<void> | null>();
  #pendingSpeech: PendingSpeech | null = null;
  #closed = false;
  #failing = false;
  #muted = false;
  #inputEnabled = true;
  #inputGeneration = 0;
  #learnerAnswerDelivered = false;
  #audioGeneration = 0;
  #audioQueue: Promise<void> = Promise.resolve();
  #hasResponseAudio = false;
  #audioCompleted = false;
  #ignoreResponse = false;

  constructor(options: VolcRealtimeBrowserSessionOptions = {}) {
    this.#options = options;
  }

  connect(instructions: string): Promise<void> {
    if (!this.#closed && this.#connectPromise) return this.#connectPromise;
    if (!this.#closed && this.#sessionId) return Promise.resolve();
    if (
      this.#closePromise ||
      (this.#closed && !this.#closeCompleted) ||
      this.#remoteClosures.size
    ) {
      return Promise.reject(new Error('Volc realtime session cleanup pending; retry close'));
    }
    this.#closed = false;
    this.#closeCompleted = false;
    this.#failing = false;
    this.#inputAbort = new AbortController();
    this.#inputState = Promise.resolve();
    this.#sendingInput = false;
    this.#audioQueue = Promise.resolve();
    const controller = new AbortController();
    this.#connectAbort = controller;
    // Publish the singleflight before any observer or transport callback can reenter.
    const operation = Promise.resolve().then(() => this.#connect(instructions, controller));
    this.#connectPromise = operation;
    const finish = () => {
      if (this.#connectPromise === operation) this.#connectPromise = null;
    };
    void operation.then(finish, finish);
    return operation;
  }

  async #connect(instructions: string, controller: AbortController): Promise<void> {
    controller.signal.throwIfAborted();
    const connected = new Promise<void>((resolve, reject) => {
      this.#connectResolve = resolve;
      this.#connectReject = reject;
    });
    const abort = () => this.#rejectConnection(toError(controller.signal.reason));
    controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('Volc realtime connection timed out')),
      CONNECTION_TIMEOUT_MS,
    );
    try {
      this.#emit({ type: 'status', status: 'connecting' });
      void this.#openConnection(instructions, controller).catch((error) => {
        if (this.#connectAbort === controller && !controller.signal.aborted) {
          this.#rejectConnection(toError(error));
        }
      });
      await connected;
      controller.signal.throwIfAborted();
    } catch (error) {
      if (this.#connectAbort === controller) void this.#fail(toError(error));
      throw toError(error);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
    }
  }

  async #openConnection(instructions: string, controller: AbortController): Promise<void> {
    controller.signal.throwIfAborted();
    const clientApiKey = this.#options.apiKey?.trim();
    const response = await this.#post(
      {
        action: 'connect',
        instructions,
        ...(this.#options.voice ? { voice: this.#options.voice } : {}),
        ...(clientApiKey ? { apiKey: clientApiKey } : {}),
      },
      controller.signal,
    );
    const payload = (await response.json()) as { sessionId?: unknown };
    if (typeof payload.sessionId !== 'string' || !payload.sessionId) {
      throw new Error('Volc realtime session response is invalid');
    }
    const isCurrent = () =>
      this.#connectAbort === controller && !controller.signal.aborted && !this.#closed;
    if (!isCurrent()) {
      // A transport may deliver a created session even after its request was aborted.
      await this.#closeRemoteSession(payload.sessionId).catch((error) =>
        this.#reportCleanupFailure(toError(error), controller),
      );
      return;
    }
    this.#sessionId = payload.sessionId;
    const sourceFactory = this.#options.eventSourceFactory ?? ((url) => new EventSource(url));
    const source = sourceFactory(
      `${REALTIME_API_URL}?sessionId=${encodeURIComponent(payload.sessionId)}`,
    );
    if (!isCurrent()) {
      source.close();
      return;
    }
    this.#eventSource = source;
    source.onmessage = (message) => {
      if (isCurrent() && this.#eventSource === source) this.#handleRelayEvent(message.data);
    };
    source.onerror = () => {
      if (isCurrent() && this.#eventSource === source) {
        void this.#fail(new Error('Volc realtime event stream disconnected'));
      }
    };
  }

  async preparePlayback(): Promise<void> {
    this.#player ??= new PcmStreamPlayer();
    await this.#player.prepare();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed && this.#closeCompleted && !this.#remoteClosures.size) {
      return Promise.resolve();
    }
    this.#closed = true;
    this.#closeCompleted = false;
    this.#connectAbort?.abort(new Error('Volc realtime session closed'));
    this.#connectPromise = null;
    this.#inputAbort.abort();
    this.#clearInput();
    this.#audioGeneration += 1;
    const operation = Promise.resolve().then(() => this.#close());
    this.#closePromise = operation;
    const finish = () => {
      if (this.#closePromise === operation) this.#closePromise = null;
    };
    void operation.then(finish, finish);
    return operation;
  }

  async #close(): Promise<void> {
    const sessionId = this.#sessionId;
    this.#sessionId = null;
    if (sessionId) this.#remoteClosures.set(sessionId, null);
    this.#eventSource?.close();
    this.#eventSource = null;
    this.#rejectConnection(new Error('Volc realtime session closed'));
    this.#rejectPendingSpeech(new Error('Volc model narration was interrupted'));
    await withCloseTimeout(async (signal) => {
      const player = this.#player;
      const stopPlayback = async () => {
        await player?.stop();
        player?.dispose();
        if (this.#player === player) this.#player = null;
      };
      await Promise.all([
        this.#stopMicrophone(),
        stopPlayback(),
        ...Array.from(this.#remoteClosures.keys(), (id) => this.#closeRemoteSession(id)),
      ]);
      signal.throwIfAborted();
      while (this.#remoteClosures.size) {
        await Promise.all(
          Array.from(this.#remoteClosures.keys(), (id) => this.#closeRemoteSession(id)),
        );
        signal.throwIfAborted();
      }
    });
    this.#closeCompleted = true;
    this.#emit({ type: 'speaking', speaking: false });
    this.#emit({ type: 'status', status: 'closed' });
  }

  #closeRemoteSession(sessionId: string): Promise<void> {
    const pending = this.#remoteClosures.get(sessionId);
    if (pending) return pending;
    const operation = withCloseTimeout(async (signal) => {
      await this.#post({ action: 'close', sessionId }, signal);
    });
    this.#remoteClosures.set(sessionId, operation);
    void operation.then(
      () => {
        if (this.#remoteClosures.get(sessionId) === operation) {
          this.#remoteClosures.delete(sessionId);
        }
      },
      () => {
        if (this.#remoteClosures.get(sessionId) === operation) {
          this.#remoteClosures.set(sessionId, null);
        }
      },
    );
    return operation;
  }

  async updateInstructions(instructions: string): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId || this.#closed) throw new Error('Volc realtime session is not connected');
    const connection = this.#connectAbort;
    try {
      await this.#post({ action: 'update', sessionId, instructions }, AbortSignal.timeout(15_000));
    } catch (error) {
      if (this.#connectAbort === connection) await this.#fail(toError(error));
      throw toError(error);
    }
  }

  async cancelNarration(): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId || this.#closed) return;
    const connection = this.#connectAbort;
    this.#audioGeneration += 1;
    this.#audioQueue = Promise.resolve();
    this.#ignoreResponse = true;
    this.#rejectPendingSpeech(new Error('Volc model narration was interrupted'));
    const player = this.#player;
    await player?.stop();
    player?.dispose();
    if (this.#connectAbort !== connection || this.#closed) return;
    if (this.#player === player) this.#player = null;
    this.#emit({ type: 'speaking', speaking: false });
    try {
      await this.#post({ action: 'cancel', sessionId }, AbortSignal.timeout(15_000));
    } catch (error) {
      if (this.#connectAbort === connection) await this.#fail(toError(error));
      throw toError(error);
    }
  }

  mute(muted: boolean): void {
    if (this.#muted === muted) return;
    this.#muted = muted;
    this.#clearInput();
    this.#syncInputState();
  }

  setInputEnabled(enabled: boolean): void {
    if (this.#inputEnabled === enabled) return;
    this.#inputEnabled = enabled;
    this.#clearInput();
    this.#syncInputState();
  }

  #syncInputState(): void {
    const sessionId = this.#sessionId;
    if (!sessionId || this.#closed) return;
    const signal = this.#inputAbort.signal;
    this.#inputState = this.#post(
      {
        action: 'input',
        sessionId,
        enabled: this.#inputEnabled && !this.#muted,
        generation: this.#inputGeneration,
      },
      AbortSignal.any([signal, AbortSignal.timeout(INPUT_REQUEST_TIMEOUT_MS)]),
    ).then(() => undefined);
    void this.#inputState.catch((error) => {
      if (!signal.aborted) return this.#fail(toError(error));
    });
  }

  #clearInput(): void {
    this.#inputGeneration += 1;
    this.#audioChunks.length = 0;
    this.#bufferedBytes = 0;
  }

  async speakText(text: string, options: { requireAudio?: boolean } = {}): Promise<void> {
    return this.#awaitModelTurn({ action: 'text', text }, options.requireAudio);
  }

  /** Send a learner question so the model answers live, not as scripted TTS. */
  async askQuestion(text: string, options: { requireAudio?: boolean } = {}): Promise<void> {
    return this.#awaitModelTurn({ action: 'query', text }, options.requireAudio);
  }

  async #awaitModelTurn(
    action: { action: 'text' | 'query'; text: string },
    requireAudio = true,
  ): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId || this.#closed) {
      throw new Error('Volc realtime session is not connected');
    }
    if (this.#pendingSpeech) {
      await this.cancelNarration();
    }
    if (this.#closed || this.#sessionId !== sessionId) {
      throw new Error('Volc realtime session is not connected');
    }
    const generation = ++this.#audioGeneration;
    this.#hasResponseAudio = false;
    this.#audioCompleted = false;
    this.#ignoreResponse = false;
    this.#assistantText = '';

    const completion = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (generation === this.#audioGeneration) {
          this.#failTurn(new Error('Volc model narration timed out'));
        }
      }, MODEL_SPEECH_TIMEOUT_MS);
      this.#pendingSpeech = { resolve, reject, timeout, requireAudio, hasAudio: false };
    });
    void completion.catch(() => {});

    try {
      await this.#post({ ...action, sessionId }, AbortSignal.timeout(MODEL_SPEECH_TIMEOUT_MS));
    } catch (error) {
      const failure = toError(error);
      if (generation === this.#audioGeneration) this.#failTurn(failure);
      throw failure;
    }
    return completion;
  }

  async #startMicrophone(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (this.#closed || signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.#mediaStream = stream;
    } catch (error) {
      log.warn('Microphone unavailable; continuing receive-only narration', error);
      return;
    }
    try {
      const context = new AudioContext();
      const source = context.createMediaStreamSource(this.#mediaStream);
      const processor = context.createScriptProcessor(RECORDER_BUFFER_SIZE, 1, 1);
      processor.onaudioprocess = (event) => {
        if (this.#closed || this.#muted || !this.#inputEnabled) return;
        this.#appendAudio(
          downsampleToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate),
        );
      };
      source.connect(processor);
      processor.connect(context.destination);
      this.#recorderContext = context;
      this.#recorderSource = source;
      this.#recorderNode = processor;
      this.#frameTimer = window.setInterval(
        () => this.#sendNextAudioFrame(),
        INPUT_BATCH_INTERVAL_MS,
      );
      this.#sendNextAudioFrame();
    } catch (error) {
      log.warn('Microphone recorder unavailable; continuing receive-only narration', error);
      await this.#stopMicrophone();
    }
  }

  async #stopMicrophone(): Promise<void> {
    if (this.#frameTimer !== null) window.clearInterval(this.#frameTimer);
    this.#frameTimer = null;
    this.#recorderNode?.disconnect();
    this.#recorderSource?.disconnect();
    this.#mediaStream?.getTracks().forEach((track) => track.stop());
    const context = this.#recorderContext;
    if (context && context.state !== 'closed') {
      await context.close();
    }
    if (this.#recorderContext !== context) return;
    this.#recorderNode = null;
    this.#recorderSource = null;
    this.#mediaStream = null;
    this.#recorderContext = null;
    this.#audioChunks.length = 0;
    this.#bufferedBytes = 0;
  }

  #appendAudio(bytes: Uint8Array): void {
    if (!bytes.length) return;
    if (this.#bufferedBytes + bytes.length > VOLC_MAX_INPUT_BUFFER_BYTES) {
      void this.#fail(new Error('Realtime audio input network backlog exceeded its limit'));
      return;
    }
    this.#audioChunks.push(bytes);
    this.#bufferedBytes += bytes.length;
  }

  #takeFrame(): Uint8Array {
    const size = Math.min(
      MAX_INPUT_BATCH_BYTES,
      Math.floor(this.#bufferedBytes / VOLC_INPUT_FRAME_BYTES) * VOLC_INPUT_FRAME_BYTES,
    );
    const frame = new Uint8Array(size);
    let offset = 0;
    while (offset < frame.length) {
      const chunk = this.#audioChunks[0];
      if (!chunk) break;
      const take = Math.min(frame.length - offset, chunk.length);
      frame.set(chunk.subarray(0, take), offset);
      offset += take;
      this.#bufferedBytes -= take;
      if (take === chunk.length) this.#audioChunks.shift();
      else this.#audioChunks[0] = chunk.subarray(take);
    }
    return frame;
  }

  #sendNextAudioFrame(): void {
    const sessionId = this.#sessionId;
    if (
      !sessionId ||
      this.#closed ||
      this.#muted ||
      !this.#inputEnabled ||
      this.#sendingInput ||
      this.#bufferedBytes < VOLC_INPUT_FRAME_BYTES
    )
      return;
    this.#sendingInput = true;
    const signal = this.#inputAbort.signal;
    const generation = this.#inputGeneration;
    const frame = this.#takeFrame();
    const sending = this.#inputState.then(async () => {
      if (this.#closed || signal.aborted || generation !== this.#inputGeneration) return;
      await this.#post(
        { action: 'audio', sessionId, generation, audio: bytesToBase64(frame) },
        AbortSignal.any([signal, AbortSignal.timeout(INPUT_REQUEST_TIMEOUT_MS)]),
      );
    });
    void sending
      .catch((error) => {
        if (!signal.aborted) return this.#fail(toError(error));
      })
      .finally(() => {
        if (!signal.aborted) this.#sendingInput = false;
      });
  }

  #handleRelayEvent(raw: string): void {
    let message: VolcRealtimeRelayEvent;
    try {
      message = JSON.parse(raw) as VolcRealtimeRelayEvent;
    } catch {
      void this.#fail(new Error('Volc realtime event stream returned invalid JSON'));
      return;
    }

    if (message.type === 'local.connected') {
      if (!this.#connectResolve) return;
      if (message.sessionId !== this.#sessionId) {
        void this.#fail(new Error('Volc realtime event stream session does not match'));
        return;
      }
      const signal = this.#connectAbort?.signal;
      if (this.#muted || !this.#inputEnabled) this.#syncInputState();
      this.#emit({ type: 'status', status: 'connected' });
      this.#resolveConnection();
      if (signal && this.#options.captureMicrophone !== false) {
        void this.#startMicrophone(signal);
      }
      return;
    }
    if (message.type === 'local.error') {
      void this.#fail(new Error(message.message));
      return;
    }
    if (message.type === 'local.closed') {
      void this.close().catch((error) => this.#reportCleanupFailure(toError(error)));
      return;
    }
    if (message.type === 'local.teacher_text') {
      if (!this.#closed && !this.#ignoreResponse) {
        this.#emit({ type: 'transcript', speaker: 'teacher', text: message.text });
      }
      return;
    }
    this.#handleUpstreamEvent(message.event);
  }

  #handleUpstreamEvent(event: VolcRealtimeUpstreamEvent): void {
    const eventType = event.type;
    if (eventType === 'conversation.item.input_audio_transcription.started') {
      if (!this.#inputEnabled || this.#muted) return;
      this.#audioGeneration += 1;
      this.#hasResponseAudio = false;
      this.#audioCompleted = false;
      this.#ignoreResponse = false;
      this.#audioQueue = Promise.resolve();
      this.#learnerAnswerDelivered = false;
      this.#rejectPendingSpeech(new Error('Volc model narration was interrupted'));
      void this.#player?.stop();
      this.#player?.dispose();
      this.#player = null;
      this.#assistantText = '';
      this.#emit({ type: 'speaking', speaking: false });
      this.#emit({ type: 'learner_turn_started' });
      return;
    }
    if (eventType?.startsWith('response.') && this.#ignoreResponse) return;
    if (
      eventType === 'conversation.item.input_audio_transcription.delta' ||
      eventType === 'conversation.item.input_audio_transcription.completed'
    ) {
      const text = extractVolcEventText(event);
      if (text) this.#emit({ type: 'transcript', speaker: 'student', text });
      if (eventType.endsWith('.completed') && !this.#learnerAnswerDelivered) {
        this.#learnerAnswerDelivered = true;
        if (text.trim()) this.#emit({ type: 'learner_answer', text });
        else
          this.#emit({
            type: 'recognition_failed',
            error: new Error('Speech recognition returned no text'),
          });
      }
      return;
    }
    if (eventType === 'conversation.item.input_audio_transcription.failed') {
      this.#emit({ type: 'recognition_failed', error: new Error('Speech recognition failed') });
      return;
    }
    if (eventType === 'response.output_text.delta') {
      this.#assistantText += extractVolcEventText(event);
      if (this.#assistantText) {
        this.#emit({ type: 'transcript', speaker: 'teacher', text: this.#assistantText });
      }
      return;
    }
    if (eventType === 'response.output_text.done') {
      const text = extractVolcEventText(event) || this.#assistantText;
      if (text) this.#emit({ type: 'transcript', speaker: 'teacher', text });
      return;
    }
    if (eventType === 'response.output_audio.started') {
      this.#player ??= new PcmStreamPlayer();
      this.#emit({ type: 'speaking', speaking: true });
      return;
    }
    if (eventType === 'response.output_audio.delta') {
      const audio = event.audio ?? event.delta;
      if (typeof audio === 'string' && audio) {
        this.#player ??= new PcmStreamPlayer();
        const player = this.#player;
        const generation = this.#audioGeneration;
        this.#audioQueue = this.#audioQueue.then(async () => {
          if (generation !== this.#audioGeneration || this.#closed) return;
          const bytes = base64ToBytes(audio);
          if (bytes.length < 2 || bytes.length % 2 !== 0)
            throw new Error('Volc teacher returned invalid PCM audio');
          await player.enqueue(bytes);
          if (generation !== this.#audioGeneration || this.#closed) return;
          this.#hasResponseAudio = true;
          if (this.#pendingSpeech) this.#pendingSpeech.hasAudio = true;
        });
        void this.#audioQueue.catch((error) => {
          if (generation === this.#audioGeneration) return this.#fail(toError(error));
        });
      }
      return;
    }
    if (eventType === 'response.output_audio.done') {
      const generation = this.#audioGeneration;
      const player = this.#player;
      const finished = this.#audioQueue.then(() => {
        if (generation === this.#audioGeneration && !this.#closed) return player?.finish();
      });
      void finished
        .then(() => {
          if (generation !== this.#audioGeneration || this.#closed || this.#audioCompleted) return;
          this.#audioCompleted = true;
          this.#emit({ type: 'speaking', speaking: false });
          this.#emit({ type: 'audio_completed', hasAudio: this.#hasResponseAudio });
          this.#resolvePendingSpeech();
        })
        .catch((error) => {
          if (generation === this.#audioGeneration) return this.#fail(toError(error));
        });
      return;
    }
    if (eventType === 'response.done') {
      const generation = this.#audioGeneration;
      void this.#audioQueue
        .then(() => {
          if (
            generation !== this.#audioGeneration ||
            this.#closed ||
            this.#hasResponseAudio ||
            this.#audioCompleted
          )
            return;
          this.#audioCompleted = true;
          this.#emit({ type: 'audio_completed', hasAudio: false });
          this.#resolvePendingSpeech();
        })
        .catch((error) => {
          if (generation === this.#audioGeneration) return this.#fail(toError(error));
        });
      return;
    }
    if (eventType === 'error') {
      const fatal = isVolcSessionFailure(event);
      const message = volcErrorMessage(event);
      const error = new Error(fatal ? `Volc realtime session disconnected: ${message}` : message);
      if (this.#pendingSpeech && !fatal) {
        this.#failTurn(error);
        return;
      }
      void this.#fail(error);
    }
  }

  async #post(action: VolcRealtimeAction, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (action.action === 'query') {
      const config = getCurrentModelConfig();
      headers['x-model'] = config.modelString;
      headers['x-api-key'] = config.apiKey;
      headers['x-base-url'] = config.baseUrl;
      if (config.providerType) headers['x-provider-type'] = config.providerType;
    }
    const response = await (this.#options.fetchImpl ?? fetch)(REALTIME_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(action),
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (response.ok || (action.action === 'close' && response.status === 404)) return response;

    let message = `Volc realtime request failed with status ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: { message?: unknown } };
      if (typeof payload.error?.message === 'string') message = payload.error.message;
    } catch {
      // Keep the explicit status-based error when the server returned non-JSON.
    }
    throw new Error(message);
  }

  async #fail(error: Error): Promise<void> {
    if (this.#failing || this.#closed) return;
    this.#failing = true;
    this.#rejectConnection(error);
    this.#rejectPendingSpeech(error);
    this.#emit({ type: 'error', error });
    this.#emit({ type: 'status', status: 'error' });
    await this.close().catch((cause) => this.#reportCleanupFailure(toError(cause)));
  }

  #reportCleanupFailure(error: Error, connection = this.#connectAbort): void {
    log.warn('Realtime session cleanup failed; retry close', error);
    if (connection !== this.#connectAbort && !this.#closed) return;
    this.#emit({ type: 'error', error });
    this.#emit({ type: 'status', status: 'error' });
  }

  #emit(event: VolcRealtimeBrowserEvent): void {
    this.#options.onEvent?.(event);
  }

  #resolveConnection(): void {
    this.#connectResolve?.();
    this.#connectResolve = null;
    this.#connectReject = null;
  }

  #rejectConnection(error: Error): void {
    this.#connectReject?.(error);
    this.#connectResolve = null;
    this.#connectReject = null;
  }

  #resolvePendingSpeech(): void {
    const pending = this.#pendingSpeech;
    if (!pending) return;
    if (pending.requireAudio && !pending.hasAudio) {
      this.#failTurn(new Error('Teacher response completed without audio'));
      return;
    }
    this.#pendingSpeech = null;
    window.clearTimeout(pending.timeout);
    pending.resolve();
  }

  #rejectPendingSpeech(error: Error): void {
    const pending = this.#pendingSpeech;
    if (!pending) return;
    this.#pendingSpeech = null;
    window.clearTimeout(pending.timeout);
    pending.reject(error);
  }

  /** Drop the current model turn without tearing down the realtime session. */
  #failTurn(error: Error): void {
    this.#rejectPendingSpeech(error);
    void this.cancelNarration().catch(() => {
      /* cancelNarration already closes the failed session and reports the error. */
    });
  }
}
