import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getActiveLipSyncAudioNode } from '@/lib/livecourse/realtime/client/audio-bridge';
import {
  VolcRealtimeBrowserSession,
  type VolcRealtimeBrowserEvent,
} from '@/lib/livecourse/realtime/volc/client';
import {
  VOLC_REALTIME_STUDENT_VOICE,
  type VolcRealtimeAction,
} from '@/lib/livecourse/realtime/volc/protocol';

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: () => ({
    modelString: 'test-provider:test-model',
    apiKey: 'test-learner-llm-key',
    baseUrl: 'https://example.com/v1',
    providerType: 'openai',
  }),
}));

class FakeEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  close = vi.fn();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Volc browser connection and close lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function transport(
    respond: (
      action: VolcRealtimeAction,
      signal: AbortSignal | null | undefined,
    ) => Promise<Response>,
    observe?: (event: VolcRealtimeBrowserEvent) => void,
  ) {
    const sources: FakeEventSource[] = [];
    const events: VolcRealtimeBrowserEvent[] = [];
    const requests: Array<{ action: VolcRealtimeAction; signal: RequestInit['signal'] }> = [];
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      fetchImpl: async (_url, init) => {
        const action = JSON.parse(String(init?.body)) as VolcRealtimeAction;
        requests.push({ action, signal: init?.signal });
        return respond(action, init?.signal);
      },
      eventSourceFactory: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      },
      onEvent: (event) => {
        events.push(event);
        observe?.(event);
      },
    });
    return { session, sources, requests, events };
  }

  function success(action: VolcRealtimeAction): Promise<Response> {
    return Promise.resolve(
      Response.json(
        action.action === 'connect' ? { sessionId: 'lifecycle-session' } : { success: true },
      ),
    );
  }

  async function connect(session: VolcRealtimeBrowserSession, sources: FakeEventSource[]) {
    const connecting = session.connect('Teach rates.');
    await vi.advanceTimersByTimeAsync(0);
    sources.at(-1)!.emit({ type: 'local.connected', sessionId: 'lifecycle-session' });
    await connecting;
  }

  it.each(['abort-aware HTTP', 'abort-ignoring HTTP', 'response body'])(
    'bounds a hanging connect %s at 20 seconds',
    async (phase) => {
      const pending = deferred<Response>();
      const body = deferred<{ sessionId: string }>();
      const response = Response.json({});
      vi.spyOn(response, 'json').mockReturnValue(body.promise);
      const { session, sources, requests, events } = transport(async (action, signal) => {
        if (action.action !== 'connect') return success(action);
        if (phase === 'response body') return response;
        if (phase === 'abort-aware HTTP') {
          signal?.addEventListener('abort', () => pending.reject(signal.reason), { once: true });
        }
        return pending.promise;
      });
      const connecting = session.connect('Teach rates.');
      const rejected = expect(connecting).rejects.toThrow('connection timed out');
      const settled = vi.fn();
      void connecting.then(settled, settled);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(requests[0].signal?.aborted).toBe(true);
      expect(sources).toHaveLength(0);
      expect(events).toContainEqual({ type: 'status', status: 'error' });
      await session.close();

      if (phase === 'response body') body.resolve({ sessionId: 'late-timeout' });
      else if (phase === 'abort-ignoring HTTP') {
        pending.resolve(Response.json({ sessionId: 'late-timeout' }));
      }
      await vi.advanceTimersByTimeAsync(0);
      if (phase !== 'abort-aware HTTP') {
        expect(requests.at(-1)?.action).toEqual({ action: 'close', sessionId: 'late-timeout' });
      }
      expect(sources).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('uses one total HTTP and SSE deadline rather than restarting the budget after POST', async () => {
    const response = deferred<Response>();
    const { session, sources, requests } = transport((action) =>
      action.action === 'connect' ? response.promise : success(action),
    );
    const connecting = session.connect('Teach rates.');
    const rejected = expect(connecting).rejects.toThrow('connection timed out');
    await vi.advanceTimersByTimeAsync(12_000);
    response.resolve(Response.json({ sessionId: 'missing-handshake' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(sources[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(sources[0].close).toHaveBeenCalledOnce();
    expect(requests.at(-1)?.action).toEqual({ action: 'close', sessionId: 'missing-handshake' });
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects the handshake at 20 seconds even when its automatic cleanup also hangs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocked = deferred<Response>();
    let closeRequests = 0;
    const { session, sources, events } = transport((action) => {
      if (action.action === 'close' && ++closeRequests === 1) return blocked.promise;
      return success(action);
    });
    const connecting = session.connect('No SSE handshake');
    const rejected = expect(connecting).rejects.toThrow('connection timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(sources[0].close).toHaveBeenCalledOnce();
    expect(events).not.toContainEqual({ type: 'status', status: 'closed' });
    const closing = session.close();
    const closeRejected = expect(closing).rejects.toThrow('close timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await closeRejected;
    await session.close();
    expect(closeRequests).toBe(2);
  });

  it('coalesces callers during both POST and SSE, including synchronous status observers', async () => {
    const response = deferred<Response>();
    let reentrant: Promise<void> | undefined;
    const { session, sources, requests, events } = transport(
      (action) => (action.action === 'connect' ? response.promise : success(action)),
      (event) => {
        if (event.type === 'status' && event.status === 'connecting') {
          reentrant = session.connect('Reentrant caller');
        }
      },
    );
    const first = session.connect('Teach rates.');
    expect(session.connect('Second caller')).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(reentrant).toBe(first);
    expect(requests).toHaveLength(1);
    response.resolve(Response.json({ sessionId: 'lifecycle-session' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(session.connect('Waiting for SSE')).toBe(first);
    const settled = vi.fn();
    void first.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    sources[0].emit({ type: 'local.connected', sessionId: 'lifecycle-session' });
    await first;
    sources[0].emit({ type: 'local.connected', sessionId: 'lifecycle-session' });
    expect(
      events.filter((event) => event.type === 'status' && event.status === 'connected'),
    ).toHaveLength(1);
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start POST when a connecting observer closes synchronously', async () => {
    let closing: Promise<void> | undefined;
    const { session, sources, requests } = transport(success, (event) => {
      if (event.type === 'status' && event.status === 'connecting') closing = session.close();
    });
    const connecting = session.connect('Teach rates.');
    await expect(connecting).rejects.toThrow('session closed');
    await closing;
    expect(requests).toHaveLength(0);
    expect(sources).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['HTTP', 'response body'])(
    'closes a late %s session without attaching it or replacing a newer connection',
    async (phase) => {
      const response = deferred<Response>();
      const body = deferred<{ sessionId: string }>();
      const oldResponse = Response.json({});
      vi.spyOn(oldResponse, 'json').mockReturnValue(body.promise);
      let connections = 0;
      const { session, sources, requests, events } = transport((action) => {
        if (action.action === 'connect' && ++connections === 1) {
          return phase === 'HTTP' ? response.promise : Promise.resolve(oldResponse);
        }
        return success(action);
      });
      const oldConnection = session.connect('Old instructions');
      const rejected = expect(oldConnection).rejects.toThrow('session closed');
      await vi.advanceTimersByTimeAsync(0);
      await session.close();
      await rejected;
      expect(requests[0].signal?.aborted).toBe(true);
      await connect(session, sources);
      const eventCount = events.length;
      if (phase === 'HTTP') response.resolve(Response.json({ sessionId: 'old-session' }));
      else body.resolve({ sessionId: 'old-session' });
      await vi.advanceTimersByTimeAsync(0);
      expect(sources).toHaveLength(1);
      expect(sources[0].close).not.toHaveBeenCalled();
      expect(events).toHaveLength(eventCount);
      expect(requests.at(-1)?.action).toEqual({ action: 'close', sessionId: 'old-session' });
      const speaking = session.speakText('Still connected to the new session.');
      emitAudio(sources[0]);
      await speaking;
      expect(requests.at(-1)?.action).toMatchObject({
        action: 'text',
        sessionId: 'lifecycle-session',
      });
      await session.close();
      expect(requests.filter(({ action }) => action.action === 'close')).toHaveLength(2);
    },
  );

  it('ignores queued events and errors from a closed EventSource after reconnecting', async () => {
    const { session, sources, events } = transport(success);
    await connect(session, sources);
    const oldMessage = sources[0].onmessage!;
    const oldError = sources[0].onerror!;
    await session.close();
    await connect(session, sources);
    const count = events.length;
    for (const event of [
      { type: 'local.connected', sessionId: 'lifecycle-session' },
      { type: 'local.closed' },
      { type: 'local.teacher_text', text: 'Old caption' },
      { type: 'upstream.event', event: { type: 'response.output_audio.done' } },
    ]) {
      oldMessage({ data: JSON.stringify(event) } as MessageEvent<string>);
    }
    oldError();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(count);
    expect(sources[1].close).not.toHaveBeenCalled();
    await session.close();
  });

  it('releases old microphone permission grants even after the same instance reconnects', async () => {
    type Stream = { getTracks: () => Array<{ stop: () => void }> };
    const oldGrant = deferred<Stream>();
    const newGrant = deferred<Stream>();
    const oldStop = vi.fn();
    const newStop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockReturnValueOnce(oldGrant.promise)
          .mockReturnValueOnce(newGrant.promise),
      },
    });
    const createRecorder = vi.fn(function () {
      throw new Error('Stale microphone grants must not initialize a recorder');
    });
    vi.stubGlobal('AudioContext', createRecorder);
    const sources: FakeEventSource[] = [];
    const session = new VolcRealtimeBrowserSession({
      eventSourceFactory: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source as unknown as EventSource;
      },
      fetchImpl: async (_url, init) => success(JSON.parse(String(init?.body))),
    });
    await connect(session, sources);
    await session.close();
    await connect(session, sources);
    oldGrant.resolve({ getTracks: () => [{ stop: oldStop }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(oldStop).toHaveBeenCalledOnce();
    expect(createRecorder).not.toHaveBeenCalled();
    await session.close();
    newGrant.resolve({ getTracks: () => [{ stop: newStop }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(newStop).toHaveBeenCalledOnce();
    expect(createRecorder).not.toHaveBeenCalled();
  });

  it.each(['HTTP', 'error response body'])(
    'coalesces close, bounds hanging %s at 10 seconds, and retries the same remote ID',
    async (phase) => {
      const blocked = deferred<Response>();
      const body = deferred<unknown>();
      const response = new Response(null, { status: 503 });
      vi.spyOn(response, 'json').mockReturnValue(body.promise);
      let closes = 0;
      const { session, sources, requests, events } = transport((action) => {
        if (action.action !== 'close') return success(action);
        closes += 1;
        if (closes > 1) return Promise.resolve(new Response(null, { status: 404 }));
        return phase === 'HTTP' ? blocked.promise : Promise.resolve(response);
      });
      await connect(session, sources);
      const first = session.close();
      expect(session.close()).toBe(first);
      const rejected = expect(first).rejects.toThrow('close timed out');
      await vi.advanceTimersByTimeAsync(9_999);
      expect(closes).toBe(1);
      expect(events).not.toContainEqual({ type: 'status', status: 'closed' });
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(requests.find(({ action }) => action.action === 'close')?.signal?.aborted).toBe(true);
      await expect(session.connect('Must finish cleanup first')).rejects.toThrow('retry close');
      await expect(session.speakText('Must not use a closing session')).rejects.toThrow(
        'not connected',
      );
      expect(events).not.toContainEqual({ type: 'status', status: 'closed' });
      await session.close();
      await session.close();
      expect(
        requests.filter(({ action }) => action.action === 'close').map(({ action }) => action),
      ).toEqual([
        { action: 'close', sessionId: 'lifecycle-session' },
        { action: 'close', sessionId: 'lifecycle-session' },
      ]);
      expect(sources[0].close).toHaveBeenCalledOnce();
      expect(
        events.filter((event) => event.type === 'status' && event.status === 'closed'),
      ).toHaveLength(1);
      if (phase === 'HTTP') blocked.reject(new Error('Late network rejection'));
      else body.resolve({ error: { message: 'Late HTTP failure' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['network', 'HTTP 500'])(
    'rejects arbitrary %s close failures rather than reporting closed',
    async (failure) => {
      let failClose = true;
      const { session, sources, requests, events } = transport((action) => {
        if (action.action !== 'close' || !failClose) return success(action);
        if (failure === 'network') return Promise.reject(new Error('Network unavailable'));
        return Promise.resolve(
          Response.json({ error: { message: 'Cleanup rejected' } }, { status: 500 }),
        );
      });
      await connect(session, sources);
      await expect(session.close()).rejects.toThrow(
        failure === 'network' ? 'Network unavailable' : 'Cleanup rejected',
      );
      expect(events).not.toContainEqual({ type: 'status', status: 'closed' });
      failClose = false;
      await session.close();
      expect(requests.filter(({ action }) => action.action === 'close')).toHaveLength(2);
      expect(events).toContainEqual({ type: 'status', status: 'closed' });
    },
  );

  it('can retry immediately from a close-timeout rejection without reusing the expired request', async () => {
    const blocked = deferred<Response>();
    let closes = 0;
    const { session, sources } = transport((action) => {
      if (action.action === 'close' && ++closes === 1) return blocked.promise;
      return success(action);
    });
    await connect(session, sources);
    const first = session.close();
    const rejected = expect(first).rejects.toThrow('close timed out');
    const retry = first.catch(() => session.close());
    const recovered = expect(retry).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    await recovered;
    expect(closes).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds local recorder teardown and does not repeat successful remote cleanup on retry', async () => {
    const stopped = deferred<void>();
    const recorder = {
      state: 'running',
      sampleRate: 16_000,
      destination: {},
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createScriptProcessor: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      close: vi.fn(() => stopped.promise),
    };
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) },
    });
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return recorder;
        }
      },
    );
    const source = new FakeEventSource();
    const events: VolcRealtimeBrowserEvent[] = [];
    const requests: VolcRealtimeAction[] = [];
    const session = new VolcRealtimeBrowserSession({
      eventSourceFactory: () => source as unknown as EventSource,
      fetchImpl: async (_url, init) => {
        const action = JSON.parse(String(init?.body)) as VolcRealtimeAction;
        requests.push(action);
        return success(action);
      },
      onEvent: (event) => events.push(event),
    });
    await connect(session, [source]);
    const closing = session.close();
    const rejected = expect(closing).rejects.toThrow('close timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(events).not.toContainEqual({ type: 'status', status: 'closed' });
    recorder.close.mockImplementationOnce(async () => {
      recorder.state = 'closed';
    });
    await session.close();
    expect(requests.filter((action) => action.action === 'close')).toHaveLength(1);
    const count = events.length;
    stopped.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['local.error', 'local.closed', 'native error'])(
    'reports cleanup failures from %s without an unhandled rejection and permits close retry',
    async (eventType) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let failClose = true;
      const { session, sources, events } = transport((action) => {
        if (action.action === 'close' && failClose)
          return Promise.reject(new Error('Cleanup offline'));
        return success(action);
      });
      await connect(session, sources);
      sources[0].emit(
        eventType === 'native error'
          ? {
              type: 'upstream.event',
              event: { type: 'error', error: { code: '55000000', message: 'Upstream lost' } },
            }
          : { type: eventType, message: 'Relay lost' },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toContainEqual({ type: 'error', error: new Error('Cleanup offline') });
      expect(events).not.toContainEqual({ type: 'status', status: 'closed' });
      expect(warning).toHaveBeenCalled();
      failClose = false;
      await session.close();
      expect(events).toContainEqual({ type: 'status', status: 'closed' });
    },
  );

  it('does not wait for aborted input HTTP or let its late failure close a new session', async () => {
    const input = deferred<Response>();
    let inputs = 0;
    const { session, sources, requests, events } = transport((action) => {
      if (action.action === 'input' && ++inputs === 1) return input.promise;
      return success(action);
    });
    await connect(session, sources);
    session.mute(true);
    await session.close();
    expect(requests.find(({ action }) => action.action === 'input')?.signal?.aborted).toBe(true);
    await connect(session, sources);
    const count = events.length;
    input.reject(new Error('Old input request failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(count);
    expect(sources[1].close).not.toHaveBeenCalled();
    await session.close();
  });

  it.each(['updateInstructions', 'cancelNarration'] as const)(
    'does not let a late %s failure close a newer connection',
    async (method) => {
      const pending = deferred<Response>();
      const { session, sources, events } = transport((action) =>
        action.action === 'update' || action.action === 'cancel'
          ? pending.promise
          : success(action),
      );
      await connect(session, sources);
      const control = session[method]('Old context');
      const rejected = expect(control).rejects.toThrow('Old control failed');
      await vi.advanceTimersByTimeAsync(0);
      await session.close();
      await connect(session, sources);
      const count = events.length;
      pending.reject(new Error('Old control failed'));
      await rejected;
      expect(events).toHaveLength(count);
      expect(sources[1].close).not.toHaveBeenCalled();
      await session.close();
    },
  );

  it('retains a failed late-session cleanup for retry without failing the newer connection', async () => {
    const late = deferred<Response>();
    let connections = 0;
    let failOldClose = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { session, sources, requests, events } = transport((action) => {
      if (action.action === 'connect' && ++connections === 1) return late.promise;
      if (action.action === 'close' && action.sessionId === 'old-session' && failOldClose) {
        return Promise.reject(new Error('Old cleanup offline'));
      }
      return success(action);
    });
    const old = session.connect('Old connection');
    const rejected = expect(old).rejects.toThrow('session closed');
    await vi.advanceTimersByTimeAsync(0);
    await session.close();
    await rejected;
    await connect(session, sources);
    const count = events.length;
    late.resolve(Response.json({ sessionId: 'old-session' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(count);
    expect(sources[0].close).not.toHaveBeenCalled();
    await expect(session.connect('Keep using the new session')).resolves.toBeUndefined();
    failOldClose = false;
    await session.close();
    expect(
      requests.filter(({ action }) => action.action === 'close').map(({ action }) => action),
    ).toEqual([
      { action: 'close', sessionId: 'old-session' },
      { action: 'close', sessionId: 'old-session' },
      { action: 'close', sessionId: 'lifecycle-session' },
    ]);
  });
});

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
    const events: Array<{ type: string }> = [];
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      fetchImpl,
      eventSourceFactory: () => source as unknown as EventSource,
      onEvent: (event) => events.push(event),
    });
    const connecting = session.connect('Teach Fourier analysis');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'query-session' });
    await connecting;
    const answering = session.askQuestion('傅里叶变换和拉普拉斯变换有什么区别？');
    let completed = false;
    void answering.then(() => {
      completed = true;
    });
    source.emit({ type: 'local.teacher_text', text: '它们使用不同的变换核。' });
    await Promise.resolve();
    expect(events).toContainEqual({
      type: 'transcript',
      speaker: 'teacher',
      text: '它们使用不同的变换核。',
    });
    expect(completed).toBe(false);
    emitAudio(source);
    await answering;
    expect(requests).toContainEqual({
      action: 'query',
      sessionId: 'query-session',
      text: '傅里叶变换和拉普拉斯变换有什么区别？',
    });
    const queryRequest = fetchImpl.mock.calls.find(
      ([, init]) => JSON.parse(String(init?.body)).action === 'query',
    );
    expect(queryRequest?.[1]?.headers).toMatchObject({
      'x-model': 'test-provider:test-model',
      'x-api-key': 'test-learner-llm-key',
      'x-base-url': 'https://example.com/v1',
      'x-provider-type': 'openai',
    });
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('x-api-key');
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

  it('does not cancel new playback when an older text-generation request fails late', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const source = new FakeEventSource();
    let rejectQuery!: (error: Error) => void;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'connect') return Response.json({ sessionId: 'query-race' });
      if (body.action === 'query') {
        return new Promise<Response>((_resolve, reject) => {
          rejectQuery = reject;
        });
      }
      return Response.json({ success: true });
    });
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      fetchImpl,
      eventSourceFactory: () => source as unknown as EventSource,
    });
    const connecting = session.connect('Current node');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'query-race' });
    await connecting;
    const oldQuestion = session.askQuestion('Old question');
    const rejected = expect(oldQuestion).rejects.toThrow('Old question interrupted');
    const narration = session.speakText('New narration');
    const completed = expect(narration).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(
        fetchImpl.mock.calls.some(([, init]) => JSON.parse(String(init?.body)).action === 'text'),
      ).toBe(true),
    );
    rejectQuery(new Error('Old question interrupted'));
    await rejected;
    emitAudio(source);
    await completed;
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

  it('closes a timed-out input session instead of retrying a turn on a dead connection', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const source = new FakeEventSource();
    const events: Array<{ type: string; status?: string }> = [];
    const requests: Array<{ action: string }> = [];
    const session = new VolcRealtimeBrowserSession({
      captureMicrophone: false,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return Response.json(
          body.action === 'connect' ? { sessionId: 'idle-session' } : { success: true },
        );
      },
      eventSourceFactory: () => source as unknown as EventSource,
      onEvent: (event) => events.push(event),
    });
    const connecting = session.connect('Teach');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'idle-session' });
    await connecting;
    const speaking = session.speakText('Continue the current sentence.');
    const rejected = expect(speaking).rejects.toThrow('52000033');
    source.emit({
      type: 'upstream.event',
      event: {
        type: 'error',
        error: {
          code: '55000000',
          message: 'sami error: codes=52000033, desc=AudioServerNoAudioInputTooLongError',
        },
      },
    });
    await rejected;
    await vi.waitFor(() =>
      expect(requests.some((request) => request.action === 'close')).toBe(true),
    );
    expect(events).toContainEqual({ type: 'status', status: 'error' });
    expect(events.some((event) => event.type === 'audio_completed')).toBe(false);
    await expect(session.speakText('Must reconnect first.')).rejects.toThrow('not connected');
  });

  it('releases a microphone permission grant that arrives after the session closed', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
    const createContext = vi.fn(function () {
      throw new Error('A closed session must not initialize a recorder');
    });
    vi.stubGlobal('AudioContext', createContext);
    let grant!: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void;
    const stop = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    });
    const source = new FakeEventSource();
    const session = new VolcRealtimeBrowserSession({
      fetchImpl: async (_url, init) =>
        Response.json(
          JSON.parse(String(init?.body)).action === 'connect'
            ? { sessionId: 'late-microphone' }
            : { success: true },
        ),
      eventSourceFactory: () => source as unknown as EventSource,
    });
    const connecting = session.connect('Teach');
    await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
    source.emit({ type: 'local.connected', sessionId: 'late-microphone' });
    await connecting;
    await session.close();
    grant({ getTracks: () => [{ stop }] });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(createContext).not.toHaveBeenCalled();
  });
});
