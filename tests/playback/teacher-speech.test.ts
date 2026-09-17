import { describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import type { PlaybackEngineCallbacks } from '@/lib/playback/types';
import { ActionEngine } from '@/lib/action/engine';
import { useStageStore } from '@/lib/store';
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
  it('restores an interrupted chunk in a new engine and rebuilds HTML visuals without replaying speech', async () => {
    const first = `${'A'.repeat(110)}!`;
    const second = `${'B'.repeat(110)}!`;
    const visual: Action = { id: 'widget', type: 'widget_setState', state: { step: 1 } };
    const actions = [speech('Earlier speech'), visual, speech(first + second)];
    const state = setup(actions);
    await state.engine.restoreTeachingPosition({
      sceneId: 'scene-one',
      actionId: first + second,
      actionIndex: 2,
      speechChunkIndex: 1,
    });
    expect(state.execute).toHaveBeenCalledExactlyOnceWith(
      visual,
      expect.objectContaining({ silent: false }),
    );
    expect(state.speak).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
    state.engine.continuePlayback();
    expect(state.requests[0].text).toBe(second);
    expect(state.engine.getTeachingPosition()).toMatchObject({
      actionIndex: 2,
      speechChunkIndex: 1,
    });
    state.requests[0].resolve();
    await flush();
    expect(state.onComplete).toHaveBeenCalledOnce();
    state.engine.stop();
  });

  it('actually delivers restored HTML state through the real action engine', async () => {
    const sendWidget = vi.fn(async () => undefined);
    const actionEngine = new ActionEngine(useStageStore, null, sendWidget);
    const visual: Action = { id: 'widget', type: 'widget_setState', state: { step: 2 } };
    const state = setup([visual, speech('Continue here')]);
    state.execute.mockImplementation((action, options) => actionEngine.execute(action, options));
    await state.engine.restoreTeachingPosition({
      sceneId: 'scene-one',
      actionId: 'Continue here',
      actionIndex: 1,
      speechChunkIndex: 0,
    });
    expect(sendWidget).toHaveBeenCalledWith(
      'SET_WIDGET_STATE',
      { state: { step: 2 }, content: undefined },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(state.speak).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
    state.engine.stop();
  });

  it('waits for durable position saving before speech and suppresses a late save after cancellation', async () => {
    const saving = deferred();
    const onTeachingPosition = vi.fn(() => saving.promise);
    const state = setup([speech('First')], { onTeachingPosition });
    state.engine.start();
    expect(onTeachingPosition).toHaveBeenCalledWith({
      sceneId: 'scene-one',
      actionId: 'First',
      actionIndex: 0,
      speechChunkIndex: 0,
    });
    expect(state.speak).not.toHaveBeenCalled();
    state.engine.pause();
    saving.resolve();
    await flush();
    expect(state.speak).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
    state.engine.resume();
    await flush();
    expect(state.requests[0].text).toBe('First');
    state.engine.stop();
  });

  it('stops on save failure without speaking or completing the node', async () => {
    const state = setup([speech('First')], {
      onTeachingPosition: async () => {
        throw new Error('Could not save learning position');
      },
    });
    state.engine.start();
    await flush();
    expect(state.speak).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
    expect(state.engine.getMode()).toBe('paused');
    expect(state.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Could not save learning position' }),
    );
    state.engine.stop();
  });

  it('rejects stale saved actions and invalid chunk offsets instead of skipping material', async () => {
    const state = setup([speech('First')]);
    await expect(
      state.engine.restoreTeachingPosition({
        sceneId: 'scene-one',
        actionId: 'Removed action',
        actionIndex: 0,
        speechChunkIndex: 0,
      }),
    ).rejects.toThrow('does not match');
    await expect(
      state.engine.restoreTeachingPosition({
        sceneId: 'scene-one',
        actionId: 'First',
        actionIndex: 0,
        speechChunkIndex: 1,
      }),
    ).rejects.toThrow('does not match');
    expect(state.speak).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
  });

  it('resumes only the unfinished chunk and ignores completion of the interrupted attempt', async () => {
    const chunks = ['A', 'B', 'C'].map((letter) => `${letter.repeat(110)}!`);
    const state = setup([speech(chunks.join('')), speech('Next action')]);
    state.engine.start();
    expect(state.requests[0].text).toBe(chunks[0]);
    expect(state.engine.getSpeechContext()).toMatchObject({
      lastCompletedText: null,
      resumeText: chunks[0],
      nextText: chunks[1],
    });
    state.requests[0].resolve();
    await flush();
    expect(state.requests[1].text).toBe(chunks[1]);
    expect(state.engine.getSpeechContext()).toMatchObject({
      lastCompletedText: chunks[0],
      resumeText: chunks[1],
      nextText: chunks[2],
    });
    state.engine.pause();
    expect(state.requests[1].signal.aborted).toBe(true);
    expect(state.engine.getSnapshot().actionIndex).toBe(0);
    state.engine.resume();
    expect(state.requests[2].text).toBe(chunks[1]);
    state.requests[1].resolve();
    await flush();
    expect(state.engine.getSpeechContext()?.lastCompletedText).toBe(chunks[0]);
    expect(state.onSpeechEnd).not.toHaveBeenCalled();
    state.requests[2].resolve();
    await flush();
    expect(state.requests[3].text).toBe(chunks[2]);
    expect(state.engine.getSpeechContext()?.nextText).toBe('Next action');
    expect(state.onSpeechEnd).not.toHaveBeenCalled();
    state.requests[3].resolve();
    await flush();
    expect(state.onSpeechEnd).toHaveBeenCalledOnce();
    expect(state.requests[4].text).toBe('Next action');
    expect(state.onComplete).not.toHaveBeenCalled();
    state.requests[4].resolve();
    await flush();
    expect(state.onComplete).toHaveBeenCalledOnce();
    expect(state.requests.every((request) => request.text.length <= 200)).toBe(true);
    expect(state.engine.getSpeechContext()).toMatchObject({
      lastCompletedText: 'Next action',
      resumeText: null,
      nextText: null,
    });
    state.engine.stop();
  });

  it('keeps chunk progress after failure but clears it on explicit restart or navigation', async () => {
    const first = `${'A'.repeat(110)}!`;
    const second = `${'B'.repeat(110)}!`;
    const state = setup([speech(first + second), speech('Next action')]);
    state.engine.start();
    state.requests[0].resolve();
    await flush();
    state.requests[1].reject(new Error('Audio failed'));
    await flush();
    expect(state.engine.getMode()).toBe('paused');
    expect(state.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Audio failed' }),
    );
    expect(state.engine.getSpeechContext()?.resumeText).toBe(second);
    state.engine.resume();
    expect(state.requests[2].text).toBe(second);
    state.engine.stop();
    state.engine.start();
    expect(state.requests[3].text).toBe(first);
    expect(state.engine.getSpeechContext()?.lastCompletedText).toBeNull();
    state.requests[3].resolve();
    await flush();
    state.engine.pause();
    await state.engine.jumpToAction(0, { autoplay: true });
    expect(state.requests.at(-1)?.text).toBe(first);
    expect(state.engine.getSpeechContext()?.lastCompletedText).toBeNull();
    state.engine.stop();
  });

  it('keeps visual actions outside chunk playback and reports the next authored passage', async () => {
    const first = `${'A'.repeat(110)}!`;
    const second = `${'B'.repeat(110)}!`;
    const visual: Action = { id: 'whiteboard', type: 'wb_open' };
    const state = setup([speech(first + second), visual, speech('Next explanation')]);
    state.engine.start();
    state.requests[0].resolve();
    await flush();
    state.engine.pause();
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.engine.getSpeechContext()?.nextText).toBe('Next explanation');
    state.engine.resume();
    state.requests[2].resolve();
    await flush();
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.requests.at(-1)?.text).toBe('Next explanation');
    state.engine.stop();
  });

  it('does not begin a dialogue if the speech-end observer synchronously pauses playback', async () => {
    const question = vi.fn();
    const state = setup(
      [
        {
          id: 'first',
          type: 'speech',
          text: 'First',
          oralQuestion: { question: 'Why?', guidance: 'Explain why.' },
        },
      ],
      { question, onSpeechEnd: () => state.engine.pause() },
    );
    state.engine.start();
    state.requests[0].resolve();
    await flush();
    expect(question).not.toHaveBeenCalled();
    expect(state.onComplete).not.toHaveBeenCalled();
  });
  it('waits for an oral question after narration before moving to the next sentence', async () => {
    const dialogue = deferred();
    const question = vi.fn(() => dialogue.promise);
    const state = setup(
      [
        {
          id: 'first',
          type: 'speech',
          text: 'First',
          oralQuestion: { question: 'Why?', guidance: 'Explain why.' },
        },
        speech('Second'),
      ],
      { question },
    );
    state.engine.start();
    state.requests[0].resolve();
    await flush();
    expect(state.onSpeechEnd).toHaveBeenCalledOnce();
    expect(question).toHaveBeenCalledOnce();
    expect(state.requests).toHaveLength(1);
    expect(state.onComplete).not.toHaveBeenCalled();
    dialogue.resolve();
    await flush();
    expect(state.requests[1].text).toBe('Second');
    state.engine.stop();
  });

  it('cancels a waiting oral question on pause and retains the original speech cursor', async () => {
    let signal!: AbortSignal;
    const dialogue = deferred();
    const state = setup(
      [
        {
          id: 'first',
          type: 'speech',
          text: 'First',
          oralQuestion: { question: 'Why?', guidance: 'Explain why.' },
        },
      ],
      {
        question: (_question, value) => {
          signal = value;
          return dialogue.promise;
        },
      },
    );
    state.engine.start();
    state.requests[0].resolve();
    await flush();
    state.engine.pause();
    expect(signal.aborted).toBe(true);
    expect(state.engine.getSnapshot().actionIndex).toBe(0);
    dialogue.resolve();
    await flush();
    expect(state.onComplete).not.toHaveBeenCalled();
    state.engine.resume();
    expect(state.requests[1].text).toBe('First');
    state.engine.stop();
  });

  it('replays narration without reopening an optional oral question', async () => {
    const state = setup([
      {
        id: 'first',
        type: 'speech',
        text: 'First',
        oralQuestion: { question: 'Why?', guidance: 'Explain why.' },
      },
    ]);
    state.engine.start();
    state.requests[0].resolve();
    await flush();
    expect(state.onComplete).toHaveBeenCalledOnce();
  });
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
