import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';
import WebSocket, { type ClientOptions } from 'ws';

import {
  VolcRealtimeSessionRegistry,
  type VolcRealtimeServerSession,
} from '@/lib/livecourse/realtime/volc/server';
import { VOLC_REALTIME_STUDENT_VOICE } from '@/lib/livecourse/realtime/volc/protocol';

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  receive(value: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate(): void {
    this.close();
  }
}

describe('Volc realtime server relay', () => {
  it('uses the API key only in the upstream handshake and relays protocol events', async () => {
    const socket = new FakeWebSocket();
    const factory = vi.fn((_url: string, _options: ClientOptions) => socket as never);
    const registry = new VolcRealtimeSessionRegistry(factory);
    const createPromise = registry.create(
      'ark-server-secret',
      'Teach the current lesson',
      VOLC_REALTIME_STUDENT_VOICE,
    );

    socket.open();
    const session: VolcRealtimeServerSession = await createPromise;
    const [, options] = factory.mock.calls[0];

    expect(options.headers).toMatchObject({
      'X-Api-Key': 'ark-server-secret',
      'X-Api-Resource-Id': 'volc.speech.dialog',
      'X-Api-Connect-Id': session.id,
    });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: 'session.create',
      session: {
        model: '1.2.6.1',
        instructions: 'Teach the current lesson',
        audio: { output: { voice: VOLC_REALTIME_STUDENT_VOICE } },
      },
    });
    expect(socket.sent[0]).not.toContain('ark-server-secret');

    const events: unknown[] = [];
    session.subscribe((event) => events.push(event));
    socket.receive({ type: 'session.created', session: { id: 'dialog-1' } });
    session.sendAudio('AAE=');
    session.updateInstructions('Teach the next step');
    session.sendText('误差会沿计算图逐段乘上局部导数。');

    expect(events).toContainEqual(expect.objectContaining({ type: 'local.connected' }));
    expect(events).toContainEqual({
      type: 'upstream.event',
      event: { type: 'session.created', session: { id: 'dialog-1' } },
    });
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      type: 'input_audio_buffer.append',
      audio: 'AAE=',
    });
    expect(JSON.parse(socket.sent[2])).toMatchObject({
      type: 'session.update',
      session: { instructions: 'Teach the next step' },
    });
    expect(JSON.parse(socket.sent[3])).toMatchObject({
      type: 'speech_text_buffer.commit',
      text: '误差会沿计算图逐段乘上局部导数。',
    });

    session.close();
    expect(registry.get(session.id)).toBeUndefined();
  });

  it('preserves the upstream handshake error and log ID', async () => {
    const socket = new FakeWebSocket();
    const factory = vi.fn((_url: string, _options: ClientOptions) => socket as never);
    const registry = new VolcRealtimeSessionRegistry(factory);
    const createPromise = registry.create('invalid-speech-key', 'Teach the current lesson');
    const rejection = expect(createPromise).rejects.toMatchObject({
      message: 'Invalid X-Api-Key · LogID: upstream-log-id',
      status: 401,
      logId: 'upstream-log-id',
    });
    const response = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
    };
    response.statusCode = 401;
    response.headers = { 'x-tt-logid': 'upstream-log-id' };

    socket.emit('unexpected-response', {}, response);
    response.emit('data', Buffer.from('{"error":{"message":"Invalid X-Api-Key"}}'));
    response.emit('end');

    await rejection;
  });
});
