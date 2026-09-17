import { afterEach, describe, expect, it, vi } from 'vitest';

import { VolcRealtimeBrowserSession } from '@/lib/livecourse/realtime/volc/client';
import { VOLC_INPUT_FRAME_BYTES } from '@/lib/livecourse/realtime/volc/protocol';

async function microphoneSession() {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
  const stop = vi.fn();
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
  });
  const processor = {
    onaudioprocess: null as
      | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
      | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 16_000;
      state = 'running';
      destination = {};
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createScriptProcessor = () => processor;
      close = async () => {
        this.state = 'closed';
      };
    },
  );
  const source = {
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null,
    close: vi.fn(),
  };
  const requests: Array<{
    action: string;
    audio?: string;
    generation?: number;
    enabled?: boolean;
  }> = [];
  const errors: Error[] = [];
  const pending: Array<{ finish: () => void; signal: AbortSignal }> = [];
  const session = new VolcRealtimeBrowserSession({
    captureMicrophone: true,
    eventSourceFactory: () => source as unknown as EventSource,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (body.action === 'connect') return Response.json({ sessionId: 'input-session' });
      if (body.action !== 'audio') return Response.json({ success: true });
      const signal = init?.signal;
      if (!signal) throw new Error('Audio input must have a cancellation signal');
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        pending.push({ finish: () => resolve(Response.json({ success: true })), signal });
      });
    },
    onEvent: (event) => {
      if (event.type === 'error') errors.push(event.error);
    },
  });
  const connecting = session.connect('Teach');
  await vi.waitFor(() => expect(source.onmessage).toBeTypeOf('function'));
  source.onmessage?.({
    data: JSON.stringify({ type: 'local.connected', sessionId: 'input-session' }),
  });
  await connecting;
  const feed = (value = 0.5, samples = 1600) =>
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(samples).fill(value) },
    });
  const audioRequests = () => requests.filter((request) => request.action === 'audio');
  return { session, feed, requests, audioRequests, pending, errors, stop };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Volc microphone input transport', () => {
  it('coalesces slow HTTP uploads without queuing a request per 20ms frame', async () => {
    const { session, feed, audioRequests, pending, errors, stop } = await microphoneSession();
    feed();
    await vi.advanceTimersByTimeAsync(100);
    expect(audioRequests()).toHaveLength(1);
    expect(Buffer.from(audioRequests()[0].audio!, 'base64')).toHaveLength(
      5 * VOLC_INPUT_FRAME_BYTES,
    );
    for (let index = 0; index < 10; index++) {
      feed();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(audioRequests()).toHaveLength(1);
    pending[0].finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(audioRequests()).toHaveLength(2);
    expect(Buffer.from(audioRequests()[1].audio!, 'base64')).toHaveLength(
      25 * VOLC_INPUT_FRAME_BYTES,
    );
    pending[1].finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(Buffer.from(audioRequests()[2].audio!, 'base64')).toHaveLength(
      25 * VOLC_INPUT_FRAME_BYTES,
    );
    await session.close();
    expect(pending[2].signal.aborted).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
  });

  it('fences queued microphone frames across mute and listening transitions', async () => {
    const { session, feed, requests, audioRequests, pending } = await microphoneSession();
    feed();
    await vi.advanceTimersByTimeAsync(100);
    feed();
    session.mute(true);
    expect(requests.at(-1)).toMatchObject({ action: 'input', enabled: false, generation: 1 });
    pending[0].finish();
    feed();
    await vi.advanceTimersByTimeAsync(500);
    expect(audioRequests()).toHaveLength(1);
    session.setInputEnabled(false);
    session.mute(false);
    expect(requests.at(-1)).toMatchObject({ action: 'input', enabled: false, generation: 3 });
    session.setInputEnabled(true);
    feed(-0.5);
    await vi.advanceTimersByTimeAsync(100);
    expect(audioRequests()).toHaveLength(2);
    expect(audioRequests()[1].generation).toBe(4);
    const bytes = Buffer.from(audioRequests()[1].audio!, 'base64');
    expect(bytes.length).toBe(5 * VOLC_INPUT_FRAME_BYTES);
    expect(bytes.readInt16LE()).toBeLessThan(0);
    await session.close();
  });

  it('fails explicitly and cancels the upload when a blocked network exceeds the input bound', async () => {
    const { session, feed, pending, errors, stop } = await microphoneSession();
    feed();
    await vi.advanceTimersByTimeAsync(100);
    feed(0.5, 16_000 * 3 + 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/network backlog/);
    expect(pending[0].signal.aborted).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    await session.close();
  });
});
