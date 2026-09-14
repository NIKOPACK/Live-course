import { describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import type { PlaybackEngineCallbacks } from '@/lib/playback/types';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: vi.fn() },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function speech(text: string): Action {
  return { id: text, type: 'speech', text, audioId: 'ignored-pre-generated-audio' };
}

function setup(actions: Action[], callbacks: PlaybackEngineCallbacks = {}) {
  const requests: Array<ReturnType<typeof deferred> & { text: string; signal: AbortSignal }> = [];
  const speak = vi.fn((text: string, signal: AbortSignal) => {
    const request = { ...deferred(), text, signal };
    requests.push(request);
    return request.promise;
  });
  const onSpeechStart = vi.fn();
  const onSpeechEnd = vi.fn();
  const onSpeechCancel = vi.fn();
  const onComplete = vi.fn();
  const onError = vi.fn();
  const onProactiveShow = vi.fn();
  const execute = vi.fn(
    async (_action: Action, _options?: { signal?: AbortSignal }): Promise<void> => undefined,
  );
  const actionEngine = {
    execute,
    cancelPendingActions: vi.fn(),
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
    pauseVideo: vi.fn(),
    setWhiteboardOpen: vi.fn(),
  } as unknown as ActionEngine;
  const play = vi.fn(async () => true);
  const audioPlayer = {
    play,
    onEnded: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPlaying: () => false,
    hasActiveAudio: () => false,
  } as unknown as AudioPlayer;
  const scene = {
    id: 'scene-one',
    stageId: 'stage',
    type: 'slide',
    title: 'First scene',
    order: 0,
    content: { type: 'slide', canvas: {} },
    actions,
  } as unknown as Scene;
  const engine = new PlaybackEngine([scene], actionEngine, audioPlayer, {
    speak,
    onSpeechStart,
    onSpeechEnd,
    onSpeechCancel,
    onComplete,
    onError,
    onProactiveShow,
    ...callbacks,
  });
  return {
    engine,
    requests,
    speak,
    execute,
    play,
    onSpeechStart,
    onSpeechEnd,
    onSpeechCancel,
    onComplete,
    onError,
    onProactiveShow,
  };
}

describe('PlaybackEngine teaching speech port', () => {
  it('does not count an empty-scene dwell as a voiced lesson', async () => {
    const state = setup([]);
    state.engine.start();
    await flush();
    expect(state.speak).not.toHaveBeenCalled();
    expect(state.onSpeechStart).not.toHaveBeenCalled();
    expect(state.onSpeechEnd).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
    expect(state.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Teaching speech has no narration text' }),
    );
    expect(state.engine.getMode()).toBe('paused');
  });

  it('does not complete a speech or scene before its real audio request resolves', async () => {
    const state = setup([speech('First'), speech('Second')]);
    state.engine.start();
    await flush();
    expect(state.speak).toHaveBeenCalledOnce();
    expect(state.onSpeechStart).toHaveBeenCalledWith('First');
    expect(state.onSpeechEnd).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
    expect(state.play).not.toHaveBeenCalled();
    state.requests[0].resolve();
    await flush();
    expect(state.onSpeechEnd).toHaveBeenCalledOnce();
    expect(state.requests[1].text).toBe('Second');
    expect(state.onComplete).not.toHaveBeenCalled();
    state.requests[1].resolve();
    await flush();
    expect(state.onComplete).toHaveBeenCalledOnce();
    expect(state.onSpeechCancel).not.toHaveBeenCalled();
  });

  it('aborts on pause, restores the same sentence and ignores stale resolution after resume', async () => {
    const state = setup([speech('Same sentence'), speech('Next sentence')]);
    state.engine.start();
    state.engine.pause();
    expect(state.requests[0].signal.aborted).toBe(true);
    expect(state.engine.getMode()).toBe('paused');
    expect(state.engine.getSnapshot().actionIndex).toBe(0);
    expect(state.onSpeechCancel).toHaveBeenCalledOnce();
    expect(state.onSpeechEnd).not.toHaveBeenCalled();

    state.engine.resume();
    expect(state.requests[1].text).toBe('Same sentence');
    expect(state.onSpeechStart).toHaveBeenNthCalledWith(2, 'Same sentence');
    state.requests[0].resolve();
    await flush();
    expect(state.onSpeechEnd).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
    state.requests[1].resolve();
    await flush();
    expect(state.onSpeechEnd).toHaveBeenCalledOnce();
    expect(state.requests[2].text).toBe('Next sentence');
    state.engine.stop();
  });

  it('does not advance a new playback generation when stopped speech settles late', async () => {
    const state = setup([speech('Sentence')]);
    state.engine.start();
    state.engine.stop();
    state.engine.start();
    state.requests[0].resolve();
    await flush();
    expect(state.onSpeechEnd).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
    expect(state.onSpeechCancel).toHaveBeenCalledOnce();
    state.requests[1].resolve();
    await flush();
    expect(state.onSpeechEnd).toHaveBeenCalledOnce();
    expect(state.onComplete).toHaveBeenCalledOnce();
  });

  it('cancels a jumped-over sentence without completing it', async () => {
    const state = setup([speech('First'), speech('Second')]);
    state.engine.start();
    await expect(state.engine.jumpToAction(1, { autoplay: true })).resolves.toBe(true);
    expect(state.requests[0].signal.aborted).toBe(true);
    expect(state.requests[1].text).toBe('Second');
    state.requests[0].reject(new DOMException('Cancelled', 'AbortError'));
    await flush();
    expect(state.onError).not.toHaveBeenCalled();
    expect(state.onSpeechEnd).not.toHaveBeenCalled();
    state.requests[1].resolve();
    await flush();
    expect(state.onComplete).toHaveBeenCalledOnce();
  });

  it('freezes failed speech at its original cursor and permits retry without fake completion', async () => {
    const state = setup([speech('Retry sentence')]);
    const error = new Error('Realtime failed');
    state.engine.start();
    state.requests[0].reject(error);
    await flush();
    expect(state.engine.getMode()).toBe('paused');
    expect(state.engine.getSnapshot().actionIndex).toBe(0);
    expect(state.onError).toHaveBeenCalledWith(error);
    expect(state.onSpeechCancel).toHaveBeenCalledOnce();
    expect(state.onSpeechEnd).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
    expect(state.play).not.toHaveBeenCalled();
    state.engine.resume();
    expect(state.requests[1].text).toBe('Retry sentence');
    state.requests[1].resolve();
    await flush();
    expect(state.onComplete).toHaveBeenCalledOnce();
  });

  it.each<Action>([
    { id: 'spot', type: 'spotlight', elementId: 'element' },
    { id: 'laser', type: 'laser', elementId: 'element' },
    { id: 'whiteboard', type: 'wb_open' },
  ])('surfaces $type execution failure and does not advance', async (action) => {
    const state = setup([action, speech('Must not start')]);
    state.execute.mockRejectedValueOnce(new Error('Action failed'));
    state.engine.start();
    await flush();
    expect(state.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Action failed' }),
    );
    expect(state.engine.getMode()).toBe('paused');
    expect(state.engine.getSnapshot().actionIndex).toBe(0);
    expect(state.speak).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
    state.engine.resume();
    await flush();
    expect(state.requests[0].text).toBe('Must not start');
    state.engine.stop();
  });

  it('awaits visual actions and cancels them coherently when paused', async () => {
    const action: Action = { id: 'spot', type: 'spotlight', elementId: 'element' };
    const state = setup([action, speech('After spotlight')]);
    const gate = deferred();
    state.execute.mockImplementationOnce(async () => gate.promise);
    state.engine.start();
    expect(state.speak).not.toHaveBeenCalled();
    const signal = state.execute.mock.calls[0][1]?.signal;
    state.engine.pause();
    expect(signal?.aborted).toBe(true);
    gate.reject(new DOMException('Cancelled', 'AbortError'));
    await flush();
    expect(state.onError).not.toHaveBeenCalled();
    state.engine.resume();
    await flush();
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.requests[0].text).toBe('After spotlight');
    state.engine.stop();
  });

  it('speaks legacy discussion topics as the teacher without waiting for a hidden card', async () => {
    const state = setup(
      [
        {
          id: 'discussion',
          type: 'discussion',
          topic: 'Consider this question.',
          agentId: 'old-student',
        },
        speech('Continue teaching'),
      ],
      { isAgentSelected: () => false },
    );
    state.engine.start();
    expect(state.requests[0].text).toBe('Consider this question.');
    expect(state.onProactiveShow).not.toHaveBeenCalled();
    state.requests[0].resolve();
    await flush();
    expect(state.engine.getSnapshot().consumedDiscussions).toEqual(['discussion']);
    expect(state.requests[1].text).toBe('Continue teaching');
    state.requests[1].resolve();
    await flush();
    expect(state.onComplete).toHaveBeenCalledOnce();
  });
});
