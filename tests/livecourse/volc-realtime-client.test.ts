import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Volc realtime browser narration', () => {
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
    source.emit({
      type: 'upstream.event',
      event: { type: 'response.output_audio.done' },
    });
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
    source.emit({
      type: 'upstream.event',
      event: { type: 'response.output_audio.done' },
    });
    await speaking;
    await session.close();
  });

  it('taps playback audio so the teacher avatar can lip-sync', async () => {
    const tap = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
    class FakeAudioContext {
      state = 'running';
      currentTime = 0;
      constructor(_options?: { sampleRate?: number }) {}
      createGain() {
        return tap;
      }
      async resume() {}
    }
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const session = new VolcRealtimeBrowserSession({ captureMicrophone: false });
    await session.preparePlayback();
    expect(getActiveLipSyncAudioNode()).toBe(tap);
    await session.close();
    expect(getActiveLipSyncAudioNode()).toBeNull();
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
    source.emit({
      type: 'upstream.event',
      event: { type: 'response.output_audio.done' },
    });
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
    source.emit({
      type: 'upstream.event',
      event: { type: 'response.output_audio.done' },
    });
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
      expect(requests).toContainEqual(
        expect.objectContaining({ action: 'text', text: '第一句' }),
      ),
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
    source.emit({
      type: 'upstream.event',
      event: { type: 'response.output_audio.done' },
    });
    await second;
    expect(requests.filter((item) => (item as { action?: string }).action === 'close')).toHaveLength(
      0,
    );
    await session.close();
  });
});
