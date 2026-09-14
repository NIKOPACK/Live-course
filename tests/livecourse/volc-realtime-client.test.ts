import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
