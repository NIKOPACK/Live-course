import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import WebSocket, { type ClientOptions, type RawData } from 'ws';

import {
  buildVolcSessionCreate,
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

  sendAudio(audio: string): void {
    this.#send({ type: 'input_audio_buffer.append', event_id: randomUUID(), audio });
  }

  commitAudio(): void {
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
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'session.close', event_id: randomUUID() }));
      socket.close();
      return;
    }
    this.#finishClose();
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
    this.#emit({ type: 'upstream.event', event });
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
