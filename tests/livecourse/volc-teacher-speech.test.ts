import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMocks = vi.hoisted(() => ({
  connect: vi.fn(async (_instructions: string) => undefined),
  preparePlayback: vi.fn(async () => undefined),
  speakText: vi.fn(async (_text: string) => undefined),
  close: vi.fn(async () => undefined),
  onEvent: undefined as ((event: unknown) => void) | undefined,
}));

vi.mock('@/lib/livecourse/realtime/volc/client', () => ({
  VolcRealtimeBrowserSession: class FakeVolcRealtimeBrowserSession {
    constructor(options: { onEvent?: (event: unknown) => void }) {
      sessionMocks.onEvent = options.onEvent;
    }
    connect = sessionMocks.connect;
    preparePlayback = sessionMocks.preparePlayback;
    speakText = sessionMocks.speakText;
    close = sessionMocks.close;
  },
}));

import { VolcTeacherSpeechSession } from '@/lib/livecourse/realtime/client/volc-teacher-speech';

describe('VolcTeacherSpeechSession', () => {
  beforeEach(() => {
    sessionMocks.connect.mockClear();
    sessionMocks.preparePlayback.mockClear();
    sessionMocks.speakText.mockClear();
    sessionMocks.close.mockClear();
    sessionMocks.onEvent = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('connects through the Volc relay and speaks narration', async () => {
    const events: string[] = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach photosynthesis.',
      onEvent: (event) => events.push(event.type),
    });

    await session.connect();
    expect(sessionMocks.preparePlayback).toHaveBeenCalledOnce();
    expect(sessionMocks.connect).toHaveBeenCalledWith('Teach photosynthesis.');
    expect(session.connected).toBe(true);

    await session.speak('叶绿体吸收光能。');
    expect(sessionMocks.speakText).toHaveBeenCalledWith('叶绿体吸收光能。');

    await session.ask('什么是光反应？');
    expect(sessionMocks.speakText).toHaveBeenCalledWith(
      expect.stringContaining('什么是光反应？'),
    );

    await session.close();
    expect(session.connected).toBe(false);
    expect(sessionMocks.close).toHaveBeenCalledOnce();
    expect(events[0]).toBe('status');
    expect(events).toContain('transcript');
  });
});
