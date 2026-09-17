import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import WebSocket, { type ClientOptions, type RawData } from 'ws';

import {
  buildVolcSessionCreate,
  isVolcSessionFailure,
  VOLC_INPUT_FRAME_BYTES,
  VOLC_INPUT_FRAME_MS,
  VOLC_MAX_INPUT_BUFFER_BYTES,
  VOLC_REALTIME_RESOURCE_ID,
  VOLC_REALTIME_URL,
  type VolcRealtimeVoice,
  type VolcRealtimeRelayEvent,
  type VolcRealtimeUpstreamEvent,
} from './protocol';

const CONNECTION_TIMEOUT_MS = 15_000;
const SESSION_LIFETIME_MS = 15 * 60_000;
const MAX_BUFFERED_EVENTS = 100;
const MAX_ACTIVE_SESSIONS = 8;
const INPUT_IDLE_MS = 1_000;

type EventListener = (event: VolcRealtimeRelayEvent) => void;
type WebSocketFactory = (url: string, options: ClientOptions) => WebSocket;

export class VolcRealtimeConfigurationError extends Error {
  override readonly name = 'VolcRealtimeConfigurationError';
}

export class VolcRealtimeUpstreamError extends Error {
  override readonly name = 'VolcRealtimeUpstreamError';

  constructor(
    message: string,
    readonly status?: number,
    readonly logId?: string,
  ) {
    super(message);
  }
}

interface VolcRealtimeServerSessionOptions {
  apiKey: string;
  instructions: string;
  voice?: VolcRealtimeVoice;
  webSocketFactory?: WebSocketFactory;
  onClosed?: () => void;
}

export class VolcRealtimeServerSession {
  readonly id = randomUUID();

  readonly #options: VolcRealtimeServerSessionOptions;
  readonly #listeners = new Set<EventListener>();
  readonly #bufferedEvents: VolcRealtimeRelayEvent[] = [];
  readonly #lifetimeTimer: ReturnType<typeof setTimeout>;
  #socket: WebSocket | null = null;
  #closed = false;
  #inputTimer: ReturnType<typeof setTimeout> | undefined;
  #inputBuffer: Buffer = Buffer.alloc(0);
  #inputGeneration = 0;
  #inputEnabled = true;
  #upstreamInputMuted = false;
  #lastInputAt: number | null = null;
  #nextInputAt = 0;
  #inputCommitPending = false;

  constructor(options: VolcRealtimeServerSessionOptions) {
    this.#options = options;
    this.#lifetimeTimer = setTimeout(() => this.close(), SESSION_LIFETIME_MS);
    this.#lifetimeTimer.unref?.();
  }

  async connect(): Promise<void> {
    const socketFactory =
      this.#options.webSocketFactory ?? ((url, options) => new WebSocket(url, options));
    const socket = socketFactory(VOLC_REALTIME_URL, {
      headers: {
        'X-Api-Key': this.#options.apiKey,
        'X-Api-Resource-Id': VOLC_REALTIME_RESOURCE_ID,
        'X-Api-Connect-Id': this.id,
      },
    });
    this.#socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        finish(() => {
          reject(new VolcRealtimeUpstreamError('Volc realtime connection timed out'));
          socket.terminate();
        });
      }, CONNECTION_TIMEOUT_MS);

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.off('open', handleOpen);
        socket.off('error', handleError);
        socket.off('unexpected-response', handleUnexpectedResponse);
        callback();
      };
      const handleOpen = () => finish(resolve);
      const handleError = (error: Error) =>
        finish(() =>
          reject(new VolcRealtimeUpstreamError(error.message || 'Volc realtime connection failed')),
        );
      const handleUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          if (size >= 8_192) return;
          const value = Buffer.from(chunk);
          chunks.push(value.subarray(0, 8_192 - size));
          size += value.length;
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const logId = headerString(response, 'x-tt-logid');
          const message = parseUpstreamErrorMessage(body);
          finish(() =>
            reject(
              new VolcRealtimeUpstreamError(
                [
                  message || `Volc realtime handshake failed with status ${response.statusCode}`,
                  logId ? `LogID: ${logId}` : '',
                ]
                  .filter(Boolean)
                  .join(' · '),
                response.statusCode,
                logId,
              ),
            ),
          );
        });
      };

      socket.once('open', handleOpen);
      socket.once('error', handleError);
      socket.once('unexpected-response', handleUnexpectedResponse);
    });

    socket.on('message', (data) => this.#handleMessage(data));
    socket.on('error', () => {
      this.#emit({ type: 'local.error', message: 'Volc realtime connection failed' });
    });
    socket.on('close', () => this.#finishClose());

    socket.send(
      JSON.stringify(buildVolcSessionCreate(this.#options.instructions, this.#options.voice)),
    );
    const logId = headerValue(socket, 'x-tt-logid');
    this.#emit({ type: 'local.connected', sessionId: this.id, ...(logId ? { logId } : {}) });
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    for (const event of this.#bufferedEvents.splice(0)) listener(event);
    return () => this.#listeners.delete(listener);
  }

  sendAudio(audio: string, generation = 0): void {
    if (this.#closed || this.#socket?.readyState !== WebSocket.OPEN) {
      throw new VolcRealtimeUpstreamError('Volc realtime session is not connected');
    }
    if (!this.#inputEnabled || generation !== this.#inputGeneration) return;
    const bytes = Buffer.from(audio, 'base64');
    if (!bytes.length || bytes.length % Int16Array.BYTES_PER_ELEMENT !== 0) {
      throw new VolcRealtimeUpstreamError('Invalid realtime PCM input');
    }
    if (this.#inputBuffer.length + bytes.length > VOLC_MAX_INPUT_BUFFER_BYTES) {
      throw new VolcRealtimeUpstreamError('Realtime audio input backlog exceeded its limit');
    }
    this.#inputBuffer = Buffer.concat([this.#inputBuffer, bytes]);
  }

  setInputEnabled(enabled: boolean, generation: number): void {
    if (generation < this.#inputGeneration) return;
    this.#inputGeneration = generation;
    this.#inputEnabled = enabled;
    this.#inputBuffer = Buffer.alloc(0);
    this.#inputCommitPending = false;
    if (!enabled && this.#inputTimer) this.#setUpstreamInputMuted(true);
  }

  #setUpstreamInputMuted(muted: boolean): void {
    if (this.#upstreamInputMuted === muted) return;
    this.#send({
      type: muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit',
      event_id: randomUUID(),
    });
    this.#upstreamInputMuted = muted;
  }

  #pumpInput(): void {
    if (this.#closed) return;
    try {
      if (
        this.#inputBuffer.length >= VOLC_INPUT_FRAME_BYTES ||
        (this.#inputCommitPending && this.#inputBuffer.length > 0)
      ) {
        this.#setUpstreamInputMuted(false);
        const frame = this.#inputBuffer.subarray(0, VOLC_INPUT_FRAME_BYTES);
        this.#send({
          type: 'input_audio_buffer.append',
          event_id: randomUUID(),
          audio: frame.toString('base64'),
        });
        this.#inputBuffer = this.#inputBuffer.subarray(VOLC_INPUT_FRAME_BYTES);
        this.#lastInputAt = Date.now();
        if (this.#inputCommitPending && !this.#inputBuffer.length) {
          this.#send({ type: 'input_audio_buffer.commit', event_id: randomUUID() });
          this.#inputCommitPending = false;
        }
      } else if (this.#lastInputAt === null || Date.now() - this.#lastInputAt >= INPUT_IDLE_MS) {
        this.#setUpstreamInputMuted(true);
      }
    } catch (error) {
      this.#emit({
        type: 'local.error',
        message: error instanceof Error ? error.message : 'Volc realtime audio input failed',
      });
      this.close();
      return;
    }
    // Correct timer drift without bursting queued audio after an event-loop stall.
    this.#nextInputAt = Math.max(
      this.#nextInputAt + VOLC_INPUT_FRAME_MS,
      Date.now() + VOLC_INPUT_FRAME_MS / 2,
    );
    this.#inputTimer = setTimeout(() => this.#pumpInput(), this.#nextInputAt - Date.now());
    this.#inputTimer.unref?.();
  }

  commitAudio(): void {
    if (this.#inputBuffer.length) {
      this.#inputCommitPending = true;
      return;
    }
    this.#send({ type: 'input_audio_buffer.commit', event_id: randomUUID() });
  }

  updateInstructions(instructions: string): void {
    this.#send({
      type: 'session.update',
      event_id: randomUUID(),
      session: { instructions },
    });
  }

  sendText(text: string): void {
    this.#send({ type: 'speech_text_buffer.commit', event_id: randomUUID(), text });
  }

  /** Learner text becomes a user turn so the model answers, instead of TTS of a script. */
  sendQuery(text: string): void {
    this.#send({
      type: 'conversation.item.create',
      event_id: randomUUID(),
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
  }

  cancelResponse(): void {
    this.#send({ type: 'response.cancel', event_id: randomUUID() });
  }

  close(): void {
    if (this.#closed) return;
    const socket = this.#socket;
    this.#finishClose();
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'session.close', event_id: randomUUID() }));
        socket.close();
      } catch (error) {
        console.warn('Volc realtime socket close failed', error);
        socket.terminate();
      }
    }
  }

  #send(payload: Record<string, unknown>): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.#closed) {
      throw new VolcRealtimeUpstreamError('Volc realtime session is not connected');
    }
    socket.send(JSON.stringify(payload));
  }

  #handleMessage(data: RawData): void {
    let event: VolcRealtimeUpstreamEvent;
    try {
      event = JSON.parse(data.toString()) as VolcRealtimeUpstreamEvent;
    } catch {
      this.#emit({ type: 'local.error', message: 'Volc realtime returned invalid JSON' });
      return;
    }
    if (event.type === 'session.created' && !this.#inputTimer && !this.#closed) {
      // The duplex service requires explicit mute, not fake microphone audio.
      this.#nextInputAt = Date.now();
      this.#pumpInput();
    }
    this.#emit({ type: 'upstream.event', event });
    if (
      event.type === 'session.closed' ||
      (event.type === 'error' && isVolcSessionFailure(event))
    ) {
      this.close();
    }
  }

  #emit(event: VolcRealtimeRelayEvent): void {
    if (this.#listeners.size === 0) {
      this.#bufferedEvents.push(event);
      if (this.#bufferedEvents.length > MAX_BUFFERED_EVENTS) this.#bufferedEvents.shift();
      return;
    }
    for (const listener of this.#listeners) listener(event);
  }

  #finishClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#lifetimeTimer);
    clearTimeout(this.#inputTimer);
    this.#inputTimer = undefined;
    this.#inputBuffer = Buffer.alloc(0);
    this.#inputCommitPending = false;
    this.#emit({ type: 'local.closed' });
    this.#listeners.clear();
    this.#options.onClosed?.();
  }
}

function headerValue(socket: WebSocket, name: string): string | undefined {
  const response = (
    socket as WebSocket & {
      _req?: { res?: { headers?: Record<string, string | string[] | undefined> } };
    }
  )._req?.res;
  const value = response?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function headerString(response: IncomingMessage, name: string): string | undefined {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseUpstreamErrorMessage(body: string): string | undefined {
  try {
    const payload = JSON.parse(body) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    if (typeof payload.error?.message === 'string') return payload.error.message;
    if (typeof payload.message === 'string') return payload.message;
  } catch {
    return undefined;
  }
  return undefined;
}

export class VolcRealtimeSessionRegistry {
  readonly #sessions = new Map<string, VolcRealtimeServerSession>();
  readonly #webSocketFactory?: WebSocketFactory;

  constructor(webSocketFactory?: WebSocketFactory) {
    this.#webSocketFactory = webSocketFactory;
  }

  async create(
    apiKey: string,
    instructions: string,
    voice?: VolcRealtimeVoice,
  ): Promise<VolcRealtimeServerSession> {
    if (this.#sessions.size >= MAX_ACTIVE_SESSIONS) {
      throw new VolcRealtimeUpstreamError('Too many active realtime sessions');
    }
    const session = new VolcRealtimeServerSession({
      apiKey,
      instructions,
      voice,
      webSocketFactory: this.#webSocketFactory,
      onClosed: () => this.#sessions.delete(session.id),
    });
    this.#sessions.set(session.id, session);
    try {
      await session.connect();
      return session;
    } catch (error) {
      this.#sessions.delete(session.id);
      session.close();
      throw error;
    }
  }

  get(sessionId: string): VolcRealtimeServerSession | undefined {
    return this.#sessions.get(sessionId);
  }
}

const globalForVolcRealtime = globalThis as typeof globalThis & {
  __livecourseVolcRealtimeRegistry?: VolcRealtimeSessionRegistry;
};

export const volcRealtimeSessionRegistry =
  (globalForVolcRealtime.__livecourseVolcRealtimeRegistry ??= new VolcRealtimeSessionRegistry());
