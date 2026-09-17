// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openaiOptions: null as Record<string, unknown> | null,
  volcOptions: null as Record<string, unknown> | null,
  connect: vi.fn(async () => {}),
  speak: vi.fn(async () => {}),
  volcSpeak: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  audioClose: vi.fn(async () => {}),
}));
vi.mock('@/lib/livecourse/realtime/client/session', () => ({
  LiveCourseRealtimeSession: class {
    constructor(options: Record<string, unknown>) {
      mocks.openaiOptions = options;
    }
    connect = mocks.connect;
    speak = mocks.speak;
    close = mocks.close;
  },
}));
vi.mock('@/lib/livecourse/realtime/client/volc-teacher-speech', () => ({
  VolcTeacherSpeechSession: class {
    constructor(options: Record<string, unknown>) {
      mocks.volcOptions = options;
    }
    connect = mocks.connect;
    speak = mocks.volcSpeak;
    close = mocks.close;
  },
}));
vi.mock('@/lib/livecourse/realtime/client/audio-bridge', () => ({
  RealtimeAudioBridge: class {
    close = mocks.audioClose;
  },
}));

import { createReplaySpeech } from '@/lib/livecourse/session/replay-speech';

function setup(provider: 'openai' | 'volc') {
  return createReplaySpeech({
    provider,
    courseId: 'course',
    lessonId: 'lesson',
    getLearnerId: async () => 'learner',
    getApiKey: () => undefined,
    getInstructions: () => 'Authored narration only.',
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.openaiOptions = null;
  mocks.volcOptions = null;
});

describe('J4 receive-only replay speech', () => {
  it.each(['openai', 'volc'] as const)(
    'plays authored %s speech without learner interaction',
    async (provider) => {
      const teacher = setup(provider);
      const signal = new AbortController().signal;
      await teacher.speak('Authored explanation', { signal });
      if (provider === 'openai') {
        expect(mocks.openaiOptions).toMatchObject({ readOnly: true });
        expect(mocks.speak).toHaveBeenCalledWith('Authored explanation', { signal });
        const dispatch = mocks.openaiOptions!.dispatchCommand as () => Promise<void>;
        await expect(dispatch()).rejects.toThrow('unavailable in replay');
      } else {
        expect(mocks.volcOptions).toMatchObject({ readOnly: true });
        expect(mocks.volcSpeak).toHaveBeenCalledWith('Authored explanation', { signal });
      }
      expect(teacher.question).toBeUndefined();
      await expect(teacher.ask('Why?')).rejects.toThrow('unavailable in replay');
      await teacher.close();
      await expect(teacher.speak('late')).rejects.toMatchObject({ name: 'AbortError' });
    },
  );

  it('cancels a pending narration on pause and never accepts its late success', async () => {
    let finish!: () => void;
    mocks.volcSpeak.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const teacher = setup('volc');
    const abort = new AbortController();
    const speaking = teacher.speak('Pending narration', { signal: abort.signal });
    const rejected = expect(speaking).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.volcSpeak).toHaveBeenCalled());
    abort.abort();
    finish();
    await rejected;
    expect(mocks.volcSpeak).toHaveBeenCalledWith('Pending narration', { signal: abort.signal });
    await teacher.close();
  });

  it('preserves a voice failure for explicit retry rather than silently completing', async () => {
    mocks.speak.mockRejectedValueOnce(new Error('audio unavailable'));
    const teacher = setup('openai');
    await expect(teacher.speak('Explanation')).rejects.toThrow('audio unavailable');
    await expect(teacher.speak('Explanation')).resolves.toBeUndefined();
    await teacher.close();
  });
});
