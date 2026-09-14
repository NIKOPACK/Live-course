import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionEngine } from '@/lib/action/engine';
import { PlaybackEngine } from '@/lib/playback/engine';
import { useCanvasStore } from '@/lib/store/canvas';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import type { StageStore } from '@/lib/api/stage-api';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

function createStageStore(): StageStore & {
  read: () => ReturnType<StageStore['getState']>;
} {
  let state = {
    stage: {
      id: 'stage-whiteboard-lifecycle',
      whiteboard: [
        {
          id: 'whiteboard-1',
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          elements: [
            {
              id: 'element-1',
              type: 'text',
              content: 'keep me',
              left: 0,
              top: 0,
              width: 100,
              height: 40,
              rotate: 0,
            },
          ],
          background: { type: 'solid', color: '#fff' },
          animations: [],
        },
      ],
    },
    scenes: [],
    currentSceneId: null,
    mode: 'playback' as const,
  } as unknown as ReturnType<StageStore['getState']>;

  const store = {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      state = { ...state, ...partial };
    },
    subscribe: () => () => undefined,
    read: () => state,
  };
  return store;
}

function createAudioPlayer(): AudioPlayer {
  return {
    play: vi.fn(async () => false),
    onEnded: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPlaying: vi.fn(() => false),
    hasActiveAudio: vi.fn(() => false),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    setPlaybackRate: vi.fn(),
    destroy: vi.fn(),
  } as unknown as AudioPlayer;
}

function clearAction(): Action {
  return { id: 'clear-1', type: 'wb_clear' } as Action;
}

function scene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-whiteboard-lifecycle',
    type: 'slide',
    title: 'Whiteboard',
    order: 0,
    content: { type: 'slide', canvas: {} },
    actions,
  } as unknown as Scene;
}

describe('whiteboard delayed action lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    useCanvasStore.getState().setWhiteboardClearing(false);
    useCanvasStore.getState().setWhiteboardOpen(false);
    useWhiteboardHistoryStore.getState().clearHistory();
  });

  it('does not clear after an explicit abort during the cascade delay', async () => {
    vi.useFakeTimers();
    const store = createStageStore();
    const engine = new ActionEngine(store);
    const controller = new AbortController();
    useCanvasStore.getState().setWhiteboardOpen(true);

    const execution = engine.execute(clearAction(), { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(true);

    controller.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await execution;

    expect(store.read().stage?.whiteboard?.[0]?.elements).toHaveLength(1);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);
  });

  it('aborts a delayed clear when PlaybackEngine stops on a scene transition', async () => {
    vi.useFakeTimers();
    const store = createStageStore();
    const actionEngine = new ActionEngine(store);
    useCanvasStore.getState().setWhiteboardOpen(true);
    const playback = new PlaybackEngine(
      [scene([clearAction()])],
      actionEngine,
      createAudioPlayer(),
    );

    playback.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(true);

    playback.stop();
    await vi.advanceTimersByTimeAsync(2000);

    expect(store.read().stage?.whiteboard?.[0]?.elements).toHaveLength(1);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);
  });
});
