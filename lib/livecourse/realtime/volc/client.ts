'use client';

import {
  extractVolcEventText,
  VOLC_INPUT_FRAME_BYTES,
  VOLC_INPUT_FRAME_MS,
  VOLC_INPUT_SAMPLE_RATE,
  VOLC_OUTPUT_SAMPLE_RATE,
  type VolcRealtimeAction,
  type VolcRealtimeRelayEvent,
  type VolcRealtimeUpstreamEvent,
  type VolcRealtimeVoice,
} from './protocol';
import { registerLipSyncAudioNode } from '@/lib/livecourse/realtime/client/audio-bridge';

const REALTIME_API_URL = '/api/livecourse/realtime/volc';
const RECORDER_BUFFER_SIZE = 4_096;
const MODEL_SPEECH_TIMEOUT_MS = 60_000;

export type VolcRealtimeBrowserStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export type VolcRealtimeBrowserEvent =
  | { type: 'status'; status: VolcRealtimeBrowserStatus }
  | { type: 'transcript'; speaker: 'teacher' | 'student'; text: string }
  | { type: 'speaking'; speaking: boolean }
  | { type: 'learner_turn_started' }
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
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function volcErrorMessage(event: VolcRealtimeUpstreamEvent): string {
  if (typeof event.message === 'string' && event.message.trim()) return event.message;
  const nested = event.error;
  if (typeof nested === 'string' && nested.trim()) return nested;
  if (nested && typeof nested === 'object' && 'message' in nested) {
    const message = (nested as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Volc realtime failed';
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
  if (sharedPlaybackContext.state === 'suspended') await sharedPlaybackContext.resume();
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
  #nextPlayTime = 0;
  readonly #sources = new Set<AudioBufferSourceNode>();
  #tap: GainNode | null = null;
  #releaseLipSync: (() => void) | null = null;

  async enqueue(bytes: Uint8Array): Promise<void> {
    if (bytes.length < Int16Array.BYTES_PER_ELEMENT) return;
    const context = await this.#activate();
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
    const context = sharedPlaybackContext;
    if (!context || context.state === 'closed') return;
    const remainingMs = Math.max(0, (this.#nextPlayTime - context.currentTime) * 1_000);
    if (remainingMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs));
    }
  }

  async stop(): Promise<void> {
    for (const source of this.#sources) {
      source.stop();
      source.disconnect();
    }
    this.#sources.clear();
    this.#nextPlayTime = 0;
  }

  dispose(): void {
    this.#releaseLipSync?.();
    this.#releaseLipSync = null;
    this.#tap = null;
  }

  async #activate(): Promise<AudioContext> {
    const context = await activatePlaybackContext();
    if (!this.#tap) {
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
  #sendChain = Promise.resolve();
  #player: PcmStreamPlayer | null = null;
  #assistantText = '';
  #connectResolve: (() => void) | null = null;
  #connectReject: ((error: Error) => void) | null = null;
  #pendingSpeech: PendingSpeech | null = null;
  #closed = false;
  #failing = false;
  #muted = false;

  constructor(options: VolcRealtimeBrowserSessionOptions = {}) {
    this.#options = options;
  }

  async connect(instructions: string): Promise<void> {
    if (this.#sessionId) return;
    this.#closed = false;
    this.#emit({ type: 'status', status: 'connecting' });
    const connected = new Promise<void>((resolve, reject) => {
      this.#connectResolve = resolve;
      this.#connectReject = reject;
    });
    void connected.catch(() => {});
    try {
      const clientApiKey = this.#options.apiKey?.trim();
      const response = await this.#post({
        action: 'connect',
        instructions,
        ...(this.#options.voice ? { voice: this.#options.voice } : {}),
        ...(clientApiKey ? { apiKey: clientApiKey } : {}),
      });
      const payload = (await response.json()) as { sessionId?: unknown };
      if (typeof payload.sessionId !== 'string' || !payload.sessionId) {
        throw new Error('Volc realtime session response is invalid');
      }
      this.#sessionId = payload.sessionId;
      const sourceFactory = this.#options.eventSourceFactory ?? ((url) => new EventSource(url));
      const source = sourceFactory(
        `${REALTIME_API_URL}?sessionId=${encodeURIComponent(payload.sessionId)}`,
      );
      source.onmessage = (message) => this.#handleRelayEvent(message.data);
      source.onerror = () => {
        if (!this.#closed) void this.#fail(new Error('Volc realtime event stream disconnected'));
      };
      this.#eventSource = source;
      await connected;
    } catch (error) {
      await this.#fail(toError(error));
      throw toError(error);
    }
  }

  async preparePlayback(): Promise<void> {
    this.#player ??= new PcmStreamPlayer();
    await this.#player.prepare();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const sessionId = this.#sessionId;
    this.#sessionId = null;
    this.#eventSource?.close();
    this.#eventSource = null;
    this.#rejectConnection(new Error('Volc realtime session closed'));
    this.#rejectPendingSpeech(new Error('Volc model narration was interrupted'));
    await this.#stopMicrophone();
    await this.#player?.stop();
    this.#player?.dispose();
    this.#player = null;
    this.#emit({ type: 'speaking', speaking: false });
    if (sessionId) {
      await this.#sendChain.catch(() => {});
      await this.#post({ action: 'close', sessionId }).catch(() => {});
    }
    this.#emit({ type: 'status', status: 'closed' });
  }

  async updateInstructions(instructions: string): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId || this.#closed) return;
    try {
      await this.#post({ action: 'update', sessionId, instructions });
    } catch (error) {
      await this.#fail(toError(error));
    }
  }

  async cancelNarration(): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId || this.#closed) return;
    this.#rejectPendingSpeech(new Error('Volc model narration was interrupted'));
    await this.#player?.stop();
    this.#player?.dispose();
    this.#player = null;
    this.#emit({ type: 'speaking', speaking: false });
    await this.#post({ action: 'cancel', sessionId }).catch(() => {});
  }

  mute(muted: boolean): void {
    this.#muted = muted;
  }

  async speakText(text: string): Promise<void> {
    return this.#awaitModelTurn({ action: 'text', text });
  }

  /** Send a learner question so the model answers live, not as scripted TTS. */
  async askQuestion(text: string): Promise<void> {
    return this.#awaitModelTurn({ action: 'query', text });
  }

  async #awaitModelTurn(action: { action: 'text' | 'query'; text: string }): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId || this.#closed) {
      throw new Error('Volc realtime session is not connected');
    }
    if (this.#pendingSpeech) {
      await this.cancelNarration();
    }

    const completion = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.#failTurn(new Error('Volc model narration timed out'));
      }, MODEL_SPEECH_TIMEOUT_MS);
      this.#pendingSpeech = { resolve, reject, timeout };
    });
    void completion.catch(() => {});

    try {
      await this.#post({ ...action, sessionId });
    } catch (error) {
      const failure = toError(error);
      this.#failTurn(failure);
      throw failure;
    }
    return completion;
  }

  async #startMicrophone(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      return;
    }
    try {
      this.#mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      return;
    }
    try {
      const context = new AudioContext();
      const source = context.createMediaStreamSource(this.#mediaStream);
      const processor = context.createScriptProcessor(RECORDER_BUFFER_SIZE, 1, 1);
      processor.onaudioprocess = (event) => {
        if (this.#closed) return;
        this.#appendAudio(downsampleToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate));
      };
      source.connect(processor);
      processor.connect(context.destination);
      this.#recorderContext = context;
      this.#recorderSource = source;
      this.#recorderNode = processor;
      this.#frameTimer = window.setInterval(() => this.#sendNextAudioFrame(), VOLC_INPUT_FRAME_MS);
      this.#sendNextAudioFrame();
    } catch {
      await this.#stopMicrophone();
    }
  }

  async #stopMicrophone(): Promise<void> {
    if (this.#frameTimer !== null) window.clearInterval(this.#frameTimer);
    this.#frameTimer = null;
    this.#recorderNode?.disconnect();
    this.#recorderSource?.disconnect();
    this.#mediaStream?.getTracks().forEach((track) => track.stop());
    if (this.#recorderContext && this.#recorderContext.state !== 'closed') {
      await this.#recorderContext.close();
    }
    this.#recorderNode = null;
    this.#recorderSource = null;
    this.#mediaStream = null;
    this.#recorderContext = null;
    this.#audioChunks.length = 0;
    this.#bufferedBytes = 0;
  }

  #appendAudio(bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.#audioChunks.push(bytes);
    this.#bufferedBytes += bytes.length;
  }

  #takeFrame(): Uint8Array {
    const frame = new Uint8Array(VOLC_INPUT_FRAME_BYTES);
    if (this.#bufferedBytes < VOLC_INPUT_FRAME_BYTES) return frame;
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
    if (!sessionId || this.#closed) return;
    const action: VolcRealtimeAction = {
      action: 'audio',
      sessionId,
      audio: bytesToBase64(
        this.#muted ? new Uint8Array(VOLC_INPUT_FRAME_BYTES) : this.#takeFrame(),
      ),
    };
    const sending = this.#sendChain.then(() => this.#post(action)).then(() => undefined);
    this.#sendChain = sending;
    void sending.catch((error) => this.#fail(toError(error)));
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
      this.#emit({ type: 'status', status: 'connected' });
      this.#resolveConnection();
      if (this.#options.captureMicrophone !== false) {
        void this.#startMicrophone();
      }
      return;
    }
    if (message.type === 'local.error') {
      void this.#fail(new Error(message.message));
      return;
    }
    if (message.type === 'local.closed') {
      void this.close();
      return;
    }
    this.#handleUpstreamEvent(message.event);
  }

  #handleUpstreamEvent(event: VolcRealtimeUpstreamEvent): void {
    const eventType = event.type;
    if (eventType === 'conversation.item.input_audio_transcription.started') {
      this.#rejectPendingSpeech(new Error('Volc model narration was interrupted'));
      void this.#player?.stop();
      this.#player?.dispose();
      this.#player = null;
      this.#assistantText = '';
      this.#emit({ type: 'speaking', speaking: false });
      this.#emit({ type: 'learner_turn_started' });
      return;
    }
    if (
      eventType === 'conversation.item.input_audio_transcription.delta' ||
      eventType === 'conversation.item.input_audio_transcription.completed'
    ) {
      const text = extractVolcEventText(event);
      if (text) this.#emit({ type: 'transcript', speaker: 'student', text });
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
        void this.#player
          .enqueue(base64ToBytes(audio))
          .catch((error) => this.#fail(toError(error)));
      }
      return;
    }
    if (eventType === 'response.output_audio.done') {
      const finished = this.#player?.finish() ?? Promise.resolve();
      void finished
        .then(() => {
          this.#emit({ type: 'speaking', speaking: false });
          this.#resolvePendingSpeech();
        })
        .catch((error) => this.#fail(toError(error)));
      return;
    }
    if (eventType === 'response.done' && !this.#player) {
      this.#resolvePendingSpeech();
      return;
    }
    if (eventType === 'error') {
      const error = new Error(volcErrorMessage(event));
      if (this.#pendingSpeech) {
        this.#failTurn(error);
        return;
      }
      void this.#fail(error);
    }
  }

  async #post(action: VolcRealtimeAction): Promise<Response> {
    const response = await (this.#options.fetchImpl ?? fetch)(REALTIME_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
      cache: 'no-store',
    });
    if (response.ok) return response;

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
    await this.close();
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
    void this.cancelNarration();
  }
}
