import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getActiveLipSyncAudioNode } from '@/lib/livecourse/realtime/client/audio-bridge';
import { VolcRealtimeBrowserSession } from '@/lib/livecourse/realtime/volc/client';
import { VOLC_REALTIME_STUDENT_VOICE } from '@/lib/livecourse/realtime/volc/protocol';

class FakeEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  close(): void {}
}

let playbackContext: { state: string };

beforeEach(() => {
  const context = {
    state: 'running',
    currentTime: 0,
    resume: vi.fn(async () => undefined),
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
    createBuffer: (_channels: number, samples: number, rate: number) => ({
      getChannelData: () => new Float32Array(samples),
      duration: samples / rate,
    }),
    createBufferSource: () => {
      const source = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: () => queueMicrotask(() => source.onended?.()),
        stop: vi.fn(),
        buffer: null,
        onended: null as (() => void) | null,
      };
      return source;
    },
    destination: {},
  };
  playbackContext = context;
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context;
      }
    },
  );
});

afterEach(() => {
  playbackContext.state = 'closed';
  vi.unstubAllGlobals();
});

function emitAudio(source: FakeEventSource): void {
  source.emit({
    type: 'upstream.event',
    event: { type: 'response.output_audio.delta', audio: 'AAA=' },
  });
  source.emit({ type: 'upstream.event', event: { type: 'response.output_audio.done' } });
}

describe('Volc realtime browser narration', () => {
  it.each([
    ['speakText', 'response.done'],
    ['speakText', 'response.output_audio.done'],
    ['askQuestion', 'response.done'],
    ['askQuestion', 'response.output_audio.done'],
  ] as const)('rejects ordinary %s when %s completes without PCM', async (method, eventType) => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const source = new FakeEventSource();
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      fetchImpl: async (_url, init) =>
        Response.json(
          JSON.parse(String(init?.body)).action === 'connect'
            ? { sessionId: 'empty-audio-session' }
            : { success: true },
        ),
      eventSourceFactory: () => source as unknown as EventSource,
    });
    const connecting = session.connect('Teach rates.');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'empty-audio-session' });
    await connecting;
    const speaking = session[method]('Explain local changes.');
    const rejected = expect(speaking).rejects.toThrow('without audio');
    source.emit({ type: 'upstream.event', event: { type: eventType } });
    await rejected;
    await session.close();
  });

  it('rejects oral replies without PCM and deduplicates final learner transcription', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const source = new FakeEventSource();
    const events: Array<{ type: string }> = [];
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      fetchImpl: async (_url, init) =>
        Response.json(
          JSON.parse(String(init?.body)).action === 'connect'
            ? { sessionId: 'oral-session' }
            : { success: true },
        ),
      eventSourceFactory: () => source as unknown as EventSource,
      onEvent: (event) => events.push(event),
    });
    const connecting = session.connect('Teach local changes.');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'oral-session' });
    await connecting;
    const emit = (event: unknown) => source.emit({ type: 'upstream.event', event });
    emit({ type: 'conversation.item.input_audio_transcription.started' });
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      text: 'The local rate changes.',
    });
    emit({ type: 'conversation.item.input_audio_transcription.completed', text: 'Duplicate' });
    expect(events.filter((event) => event.type === 'learner_answer')).toHaveLength(1);
    const completion = session.askQuestion('Why?', { requireAudio: true });
    emit({ type: 'response.output_audio.started' });
    emit({ type: 'response.output_audio.done' });
    await expect(completion).rejects.toThrow('without audio');
    expect(events).toContainEqual({ type: 'audio_completed', hasAudio: false });
    await session.close();
  });

  it('waits for queued PCM and its playback, and discards PCM queued before cancellation', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    let activate!: () => void;
    const context = {
      state: 'suspended',
      currentTime: 0,
      resume: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            activate = () => {
              context.state = 'running';
              resolve();
            };
          }),
      ),
      createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
      createBuffer: (_channels: number, samples: number, rate: number) => ({
        getChannelData: () => new Float32Array(samples),
        duration: samples / rate,
      }),
      createBufferSource: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        buffer: null,
        onended: null as (() => void) | null,
      })),
      destination: {},
    };
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return context;
        }
      },
    );
    const source = new FakeEventSource();
    const completed = vi.fn();
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      fetchImpl: async (_url, init) =>
        Response.json(
          JSON.parse(String(init?.body)).action === 'connect'
            ? { sessionId: 'pcm-session' }
            : { success: true },
        ),
      eventSourceFactory: () => source as unknown as EventSource,
    });
    const connecting = session.connect('Teach rates.');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'pcm-session' });
    await connecting;
    const emit = (event: unknown) => source.emit({ type: 'upstream.event', event });
    const completion = session.askQuestion('Why?', { requireAudio: true }).then(completed);
    emit({ type: 'response.output_audio.started' });
    emit({ type: 'response.output_audio.delta', audio: 'AAA=' });
    emit({ type: 'response.output_audio.done' });
    await vi.waitFor(() => expect(activate).toBeTypeOf('function'));
    expect(completed).not.toHaveBeenCalled();
    activate();
    await vi.waitFor(() => expect(context.createBufferSource).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    context.createBufferSource.mock.results[0].value.onended?.();
    await completion;
    expect(context.createBufferSource).toHaveBeenCalledOnce();
    const cancelled = session.askQuestion('Another answer', { requireAudio: true });
    const rejected = expect(cancelled).rejects.toThrow('interrupted');
    emit({ type: 'response.output_audio.delta', audio: 'AAA=' });
    await session.cancelNarration();
    await rejected;
    expect(context.createBufferSource).toHaveBeenCalledOnce();
    await session.close();
    context.state = 'closed';
  });
  it('connects without a microphone and resolves after model audio completes', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const source = new FakeEventSource();
    const requests: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.action === 'connect') {
        return Response.json({ sessionId: 'narration-session' });
      }
      return Response.json({ success: true });
    });
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      voice: VOLC_REALTIME_STUDENT_VOICE,
      fetchImpl,
      eventSourceFactory: () => source as unknown as EventSource,
    });

    const connecting = session.connect('Teach backpropagation');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'narration-session' });
    await connecting;
    expect(requests).toContainEqual({
      action: 'connect',
      instructions: 'Teach backpropagation',
      voice: VOLC_REALTIME_STUDENT_VOICE,
    });

    const speaking = session.speakText('误差会沿计算图逐段乘上局部导数。');
    await vi.waitFor(() =>
      expect(requests).toContainEqual({
        action: 'text',
        sessionId: 'narration-session',
        text: '误差会沿计算图逐段乘上局部导数。',
      }),
    );
    emitAudio(source);
    await speaking;
    await session.close();
  });

  it('still connects and narrates when the browser has no microphone API', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('navigator', {});
    const source = new FakeEventSource();
    const errors: Error[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.action === 'connect') {
        return Response.json({ sessionId: 'http-session' });
      }
      return Response.json({ success: true });
    });
    const session = new VolcRealtimeBrowserSession({
      fetchImpl,
      eventSourceFactory: () => source as unknown as EventSource,
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.error);
      },
    });

    const connecting = session.connect('Teach Fourier analysis');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'http-session' });
    await connecting;
    expect(errors).toEqual([]);

    const speaking = session.speakText('傅里叶变换把信号按频率拆开。');
    emitAudio(source);
    await speaking;
    await session.close();
  });

  it('taps playback audio so the teacher avatar can lip-sync', async () => {
    const tap = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
    const activeContext = {
      state: 'running',
      currentTime: 0,
      createGain: () => tap,
      resume: vi.fn(async () => undefined),
    };
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return activeContext;
        }
      },
    );
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const session = new VolcRealtimeBrowserSession({ captureMicrophone: false });
    await session.preparePlayback();
    expect(getActiveLipSyncAudioNode()).toBe(tap);
    await session.close();
    expect(getActiveLipSyncAudioNode()).toBeNull();
    activeContext.state = 'closed';
  });

  it('connects without waiting for microphone permission', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const source = new FakeEventSource();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.action === 'connect') return Response.json({ sessionId: 'mic-session' });
      return Response.json({ success: true });
    });
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () => new Promise(() => undefined),
      },
    });
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: true,
      fetchImpl,
      eventSourceFactory: () => source as unknown as EventSource,
    });
    const connecting = session.connect('Teach Fourier analysis');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'mic-session' });
    await connecting;
    await session.close();
  });

  it('posts learner questions as queries so the model answers live', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const source = new FakeEventSource();
    const requests: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.action === 'connect') return Response.json({ sessionId: 'query-session' });
      return Response.json({ success: true });
    });
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      fetchImpl,
      eventSourceFactory: () => source as unknown as EventSource,
    });
    const connecting = session.connect('Teach Fourier analysis');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'query-session' });
    await connecting;
    const answering = session.askQuestion('傅里叶变换和拉普拉斯变换有什么区别？');
    emitAudio(source);
    await answering;
    expect(requests).toContainEqual({
      action: 'query',
      sessionId: 'query-session',
      text: '傅里叶变换和拉普拉斯变换有什么区别？',
    });
    await session.close();
  });

  it('replaces in-flight narration instead of throwing already speaking', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const source = new FakeEventSource();
    const requests: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.action === 'connect') {
        return Response.json({ sessionId: 'overlap-session' });
      }
      return Response.json({ success: true });
    });
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      fetchImpl,
      eventSourceFactory: () => source as unknown as EventSource,
    });
    const connecting = session.connect('Teach Fourier analysis');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'overlap-session' });
    await connecting;

    const first = session.speakText('first sentence');
    const second = session.speakText('second sentence');
    await expect(first).rejects.toThrow('interrupted');
    emitAudio(source);
    await second;
    expect(requests).toContainEqual(
      expect.objectContaining({ action: 'cancel', sessionId: 'overlap-session' }),
    );
    expect(requests).toContainEqual(
      expect.objectContaining({
        action: 'text',
        sessionId: 'overlap-session',
        text: 'second sentence',
      }),
    );
    await session.close();
  });

  it('keeps the session open after a model error so narration can retry', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const source = new FakeEventSource();
    const requests: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (body.action === 'connect') {
        return Response.json({ sessionId: 'retry-session' });
      }
      return Response.json({ success: true });
    });
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      fetchImpl,
      eventSourceFactory: () => source as unknown as EventSource,
    });
    const connecting = session.connect('Teach Newton');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'retry-session' });
    await connecting;

    const first = session.speakText('第一句');
    await vi.waitFor(() =>
      expect(requests).toContainEqual(expect.objectContaining({ action: 'text', text: '第一句' })),
    );
    source.emit({
      type: 'upstream.event',
      event: { type: 'error', message: 'Volc realtime failed' },
    });
    await expect(first).rejects.toThrow('Volc realtime failed');

    const second = session.speakText('重试第一句');
    await vi.waitFor(() =>
      expect(requests).toContainEqual(
        expect.objectContaining({ action: 'text', text: '重试第一句' }),
      ),
    );
    emitAudio(source);
    await second;
    expect(
      requests.filter((item) => (item as { action?: string }).action === 'close'),
    ).toHaveLength(0);
    await session.close();
  });
});
