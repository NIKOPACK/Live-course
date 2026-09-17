import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { type ClientOptions } from 'ws';

import {
  VolcRealtimeSessionRegistry,
  type VolcRealtimeServerSession,
} from '@/lib/livecourse/realtime/volc/server';
import {
  VOLC_INPUT_FRAME_BYTES,
  VOLC_REALTIME_STUDENT_VOICE,
} from '@/lib/livecourse/realtime/volc/protocol';

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
  afterEach(() => vi.useRealTimers());

  it('keeps receive-only sessions muted without fabricating audio or learner turns', async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const registry = new VolcRealtimeSessionRegistry(() => socket as never);
    const connecting = registry.create('test-key', 'Read-only narration');
    socket.open();
    const session = await connecting;
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent.map((value) => JSON.parse(value).type)).toEqual(['session.create']);
    socket.receive({ type: 'session.created' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(socket.sent.map((value) => JSON.parse(value).type)).toEqual([
      'session.create',
      'input_audio_mute.commit',
    ]);
    session.close();
    expect(registry.get(session.id)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('paces batched PCM at 20ms and mutes a stopped stream until real input resumes', async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const registry = new VolcRealtimeSessionRegistry(() => socket as never);
    const connecting = registry.create('test-key', 'Teach');
    socket.open();
    const session = await connecting;
    socket.receive({ type: 'session.created' });
    const frames = [1, 2, 3].map((value) => Buffer.alloc(VOLC_INPUT_FRAME_BYTES, value));
    const inputEvents = () =>
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((event) => event.type.startsWith('input_audio'));
    session.sendAudio(Buffer.concat(frames).toString('base64'));
    await vi.advanceTimersByTimeAsync(19);
    expect(inputEvents()).toHaveLength(1);
    for (let index = 0; index < frames.length; index++) {
      await vi.advanceTimersByTimeAsync(index === 0 ? 1 : 20);
      expect(
        inputEvents()
          .filter((event) => event.type === 'input_audio_buffer.append')
          .map((event) => event.audio),
      ).toEqual(frames.slice(0, index + 1).map((frame) => frame.toString('base64')));
    }
    expect(
      inputEvents().filter((event) => event.type === 'input_audio_unmute.commit'),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(inputEvents().at(-1)?.type).toBe('input_audio_mute.commit');
    session.sendAudio(frames[0].toString('base64'));
    await vi.advanceTimersByTimeAsync(20);
    expect(
      inputEvents()
        .slice(-2)
        .map((event) => event.type),
    ).toEqual(['input_audio_unmute.commit', 'input_audio_buffer.append']);
    session.close();
  });

  it('rejects an input backlog instead of buffering unbounded stale learner audio', async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const registry = new VolcRealtimeSessionRegistry(() => socket as never);
    const connecting = registry.create('test-key', 'Teach');
    socket.open();
    const session = await connecting;
    socket.receive({ type: 'session.created' });
    expect(() =>
      session.sendAudio(Buffer.alloc(VOLC_INPUT_FRAME_BYTES * 151).toString('base64')),
    ).toThrow(/audio input backlog/i);
    session.close();
  });

  it('drops buffered and late input from earlier mute generations', async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const registry = new VolcRealtimeSessionRegistry(() => socket as never);
    const connecting = registry.create('test-key', 'Teach');
    socket.open();
    const session = await connecting;
    socket.receive({ type: 'session.created' });
    const oldAudio = Buffer.alloc(VOLC_INPUT_FRAME_BYTES * 2, 1).toString('base64');
    const newAudio = Buffer.alloc(VOLC_INPUT_FRAME_BYTES, 2).toString('base64');
    session.sendAudio(oldAudio, 0);
    session.setInputEnabled(false, 1);
    session.sendAudio(oldAudio, 0);
    await vi.advanceTimersByTimeAsync(40);
    expect(
      socket.sent.some((value) => JSON.parse(value).type === 'input_audio_buffer.append'),
    ).toBe(false);
    session.setInputEnabled(true, 2);
    session.setInputEnabled(false, 1);
    session.sendAudio(oldAudio, 0);
    session.sendAudio(newAudio, 2);
    await vi.advanceTimersByTimeAsync(20);
    expect(
      socket.sent
        .map((value) => JSON.parse(value))
        .filter((event) => event.type === 'input_audio_buffer.append'),
    ).toEqual([expect.objectContaining({ audio: newAudio })]);
    session.close();
  });

  it('commits input only after the paced upload has drained, including a partial final frame', async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const registry = new VolcRealtimeSessionRegistry(() => socket as never);
    const connecting = registry.create('test-key', 'Teach');
    socket.open();
    const session = await connecting;
    socket.receive({ type: 'session.created' });
    session.sendAudio(Buffer.alloc(VOLC_INPUT_FRAME_BYTES + 2, 1).toString('base64'));
    session.commitAudio();
    await vi.advanceTimersByTimeAsync(20);
    expect(
      socket.sent.some((value) => JSON.parse(value).type === 'input_audio_buffer.commit'),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    const events = socket.sent.map((value) => JSON.parse(value));
    expect(Buffer.from(events.at(-2).audio, 'base64')).toHaveLength(2);
    expect(events.at(-1).type).toBe('input_audio_buffer.commit');
    session.close();
  });

  it.each([
    { type: 'session.closed' },
    { type: 'error', error: { code: '55000000', message: 'Internal Server Error' } },
    {
      type: 'error',
      error: {
        code: '55000000',
        message: 'sami error: codes=52000033, desc=AudioServerNoAudioInputTooLongError',
      },
    },
  ])('releases the registry and input timer after $type', async (event) => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const registry = new VolcRealtimeSessionRegistry(() => socket as never);
    const connecting = registry.create('test-key', 'Teach');
    socket.open();
    const session = await connecting;
    socket.receive({ type: 'session.created' });
    session.sendAudio(Buffer.alloc(VOLC_INPUT_FRAME_BYTES * 3, 1).toString('base64'));
    socket.receive(event);
    expect(registry.get(session.id)).toBeUndefined();
    const count = socket.sent.length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(socket.sent).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the API key only in the upstream handshake and relays protocol events', async () => {
    vi.useFakeTimers();
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
    const audio = Buffer.alloc(VOLC_INPUT_FRAME_BYTES, 1).toString('base64');
    session.sendAudio(audio);
    await vi.advanceTimersByTimeAsync(20);
    session.updateInstructions('Teach the next step');
    session.sendText('误差会沿计算图逐段乘上局部导数。');

    expect(events).toContainEqual(expect.objectContaining({ type: 'local.connected' }));
    expect(events).toContainEqual({
      type: 'upstream.event',
      event: { type: 'session.created', session: { id: 'dialog-1' } },
    });
    expect(JSON.parse(socket.sent[3])).toMatchObject({
      type: 'input_audio_buffer.append',
      audio,
    });
    expect(JSON.parse(socket.sent[4])).toMatchObject({
      type: 'session.update',
      session: { instructions: 'Teach the next step' },
    });
    expect(JSON.parse(socket.sent[5])).toMatchObject({
      type: 'speech_text_buffer.commit',
      text: '误差会沿计算图逐段乘上局部导数。',
    });
    session.sendQuery('为什么要乘局部导数？');
    expect(JSON.parse(socket.sent[6])).toMatchObject({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '为什么要乘局部导数？' }],
      },
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
