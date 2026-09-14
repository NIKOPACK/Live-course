import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCanvasPresentationOwner,
  type CanvasPresentationOwner,
} from '@/lib/api/stage-api-canvas';
import type { StageStore } from '@/lib/api/stage-api';
import { ActionEngine } from '@/lib/action/engine';
import { useCanvasStore } from '@/lib/store/canvas';
import { useMediaGenerationStore } from '@/lib/store/media-generation';

function createStageStore(
  owner: CanvasPresentationOwner,
  isDisposed: () => boolean = () => false,
): StageStore {
  let state = {
    stage: {
      id: 'stage-action-presentation-owner',
      whiteboard: [
        {
          id: 'whiteboard-1',
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          elements: [],
          background: { type: 'solid', color: '#fff' },
          animations: [],
        },
      ],
    },
    scenes: [
      {
        id: 'scene-1',
        stageId: 'stage-action-presentation-owner',
        type: 'slide' as const,
        title: 'Video',
        order: 0,
        content: {
          type: 'slide' as const,
          canvas: {
            id: 'canvas-1',
            viewportSize: 1000,
            viewportRatio: 16 / 9,
            background: { type: 'solid' as const, color: '#fff' },
            elements: [
              {
                id: 'video-replay',
                type: 'video' as const,
                src: 'video-replay',
                mediaRef: 'video-replay',
                left: 0,
                top: 0,
                width: 100,
                height: 56,
                rotate: 0,
                autoplay: false,
              },
            ],
          },
        },
        actions: [],
      },
    ],
    currentSceneId: 'scene-1',
    mode: 'playback' as const,
  } as unknown as ReturnType<StageStore['getState']>;

  return {
    getState: () => state,
    setState: (partial) => {
      state = { ...state, ...partial };
    },
    subscribe: () => () => undefined,
    // Mirror the structural owner exposed by the real StagePresentationStore.
    presentation: { canvas: owner, isDisposed },
  } as StageStore & { presentation: { canvas: CanvasPresentationOwner } };
}

describe('ActionEngine Canvas presentation ownership', () => {
  beforeEach(() => {
    useCanvasStore.getState().resetCanvasState();
  });

  afterEach(() => {
    useCanvasStore.getState().resetCanvasState();
    useMediaGenerationStore.setState({ tasks: {} });
    vi.useRealTimers();
  });

  it('restores video and whiteboard runtime state when a replay owner is disposed', async () => {
    const owner = createCanvasPresentationOwner();
    const store = createStageStore(owner);
    useCanvasStore.getState().playVideo('video-canonical');
    useCanvasStore.getState().setWhiteboardOpen(false);
    useCanvasStore.getState().setWhiteboardClearing(false);

    const engine = new ActionEngine(store);
    await engine.execute({ id: 'spotlight', type: 'spotlight', elementId: 'replay-element' });
    const playback = engine.execute({
      id: 'play-video',
      type: 'play_video',
      elementId: 'video-replay',
    });
    await Promise.resolve();
    expect(useCanvasStore.getState().playingVideoElementId).toBe('video-replay');

    engine.pauseVideo();
    await playback;

    await engine.execute({ id: 'open-whiteboard', type: 'wb_open' }, { silent: true });
    expect(useCanvasStore.getState().spotlightElementId).toBe('replay-element');
    expect(useCanvasStore.getState().whiteboardOpen).toBe(true);

    engine.dispose();
    owner.dispose();

    expect(useCanvasStore.getState().spotlightElementId).toBe('');
    expect(useCanvasStore.getState().playingVideoElementId).toBe('video-canonical');
    expect(useCanvasStore.getState().whiteboardOpen).toBe(false);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);
  });

  it('does not let a superseded engine clear a newer replay projection', async () => {
    const oldOwner = createCanvasPresentationOwner();
    const newOwner = createCanvasPresentationOwner();
    const oldEngine = new ActionEngine(createStageStore(oldOwner));
    const newEngine = new ActionEngine(createStageStore(newOwner));

    oldEngine.execute({ id: 'old-spotlight', type: 'spotlight', elementId: 'old' });
    newEngine.execute({ id: 'new-spotlight', type: 'spotlight', elementId: 'new' });
    oldEngine.clearEffects();

    expect(useCanvasStore.getState().spotlightElementId).toBe('new');

    const oldVideo = oldEngine.execute({
      id: 'old-video',
      type: 'play_video',
      elementId: 'video-replay',
    });
    await Promise.resolve();
    const newVideo = newEngine.execute({
      id: 'new-video',
      type: 'play_video',
      elementId: 'video-replay',
    });
    await Promise.resolve();
    oldEngine.pauseVideo();
    expect(useCanvasStore.getState().playingVideoElementId).toBe('video-replay');
    newEngine.pauseVideo();
    await Promise.all([oldVideo, newVideo]);

    await oldEngine.execute({ id: 'old-open', type: 'wb_open' }, { silent: true });
    await newEngine.execute({ id: 'new-close', type: 'wb_close' }, { silent: true });
    oldEngine.setWhiteboardOpen(true);
    expect(useCanvasStore.getState().whiteboardOpen).toBe(false);

    oldEngine.dispose();
    oldOwner.dispose();
    expect(useCanvasStore.getState().spotlightElementId).toBe('new');
    newEngine.dispose();
    newOwner.dispose();
  });

  it('does not let a superseded engine reset the current whiteboard contents', async () => {
    const owner = createCanvasPresentationOwner();
    const store = createStageStore(owner);
    const oldEngine = new ActionEngine(store);
    const newEngine = new ActionEngine(store);

    await oldEngine.execute({ id: 'old-open', type: 'wb_open' }, { silent: true });
    await newEngine.execute({ id: 'new-open', type: 'wb_open' }, { silent: true });
    await newEngine.execute(
      {
        id: 'new-draw',
        type: 'wb_draw_text',
        elementId: 'new-element',
        content: 'new',
        x: 0,
        y: 0,
      },
      { silent: true },
    );

    await oldEngine.execute(
      {
        id: 'stale-draw',
        type: 'wb_draw_text',
        elementId: 'stale-element',
        content: 'stale',
        x: 0,
        y: 0,
      },
      { silent: true },
    );
    await oldEngine.execute(
      { id: 'stale-delete', type: 'wb_delete', elementId: 'new-element' },
      { silent: true },
    );

    oldEngine.resetPlaybackVisualState();

    expect(store.getState().stage?.whiteboard?.[0]?.elements.map((element) => element.id)).toEqual([
      'new-element',
    ]);

    oldEngine.dispose();
    newEngine.dispose();
    owner.dispose();
  });

  it('does not let a superseded clear animation mutate the shared whiteboard', async () => {
    vi.useFakeTimers();
    const owner = createCanvasPresentationOwner();
    const store = createStageStore(owner);
    const oldEngine = new ActionEngine(store);

    await oldEngine.execute({ id: 'old-open', type: 'wb_open' }, { silent: true });
    await oldEngine.execute(
      {
        id: 'old-draw',
        type: 'wb_draw_text',
        elementId: 'existing-element',
        content: 'keep',
        x: 0,
        y: 0,
      },
      { silent: true },
    );

    const clearing = oldEngine.execute({ id: 'old-clear', type: 'wb_clear' });
    await vi.advanceTimersByTimeAsync(0);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(true);

    const newEngine = new ActionEngine(store);
    await vi.advanceTimersByTimeAsync(2_000);
    await clearing;

    expect(store.getState().stage?.whiteboard?.[0]?.elements.map((element) => element.id)).toEqual([
      'existing-element',
    ]);

    oldEngine.dispose();
    newEngine.dispose();
    owner.dispose();
  });

  it('completes a current owner clear after its animation delay', async () => {
    vi.useFakeTimers();
    const owner = createCanvasPresentationOwner();
    const store = createStageStore(owner);
    const engine = new ActionEngine(store);

    await engine.execute({ id: 'open', type: 'wb_open' }, { silent: true });
    await engine.execute(
      {
        id: 'draw',
        type: 'wb_draw_text',
        elementId: 'element-to-clear',
        content: 'clear me',
        x: 0,
        y: 0,
      },
      { silent: true },
    );

    const clearing = engine.execute({ id: 'clear', type: 'wb_clear' });
    await vi.advanceTimersByTimeAsync(2_000);
    await clearing;

    expect(store.getState().stage?.whiteboard?.[0]?.elements).toEqual([]);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);

    engine.dispose();
    owner.dispose();
  });

  it('does not let a disposed engine execute another whiteboard mutation', async () => {
    const owner = createCanvasPresentationOwner();
    const store = createStageStore(owner);
    const engine = new ActionEngine(store);

    engine.dispose();
    await engine.execute(
      {
        id: 'disposed-draw',
        type: 'wb_draw_text',
        elementId: 'disposed-element',
        content: 'stale',
        x: 0,
        y: 0,
      },
      { silent: true },
    );

    expect(store.getState().stage?.whiteboard?.[0]?.elements).toEqual([]);
    owner.dispose();
  });

  it('keeps owner-less cleanup semantics when canceling or disposing', () => {
    const owner = createCanvasPresentationOwner();
    const store = createStageStore(owner);
    const engine = new ActionEngine(store, null, null, null);

    useCanvasStore.getState().setWhiteboardClearing(true);
    engine.cancelPendingActions();
    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);

    useCanvasStore.getState().setWhiteboardClearing(true);
    engine.dispose();
    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);

    owner.dispose();
  });

  it('allows the presentation owner to dispose before its engine', async () => {
    const owner = createCanvasPresentationOwner();
    let disposed = false;
    const store = createStageStore(owner, () => disposed);
    const engine = new ActionEngine(store);

    await engine.execute({ id: 'open', type: 'wb_open' }, { silent: true });
    disposed = true;
    owner.dispose();

    expect(() => engine.dispose()).not.toThrow();
    await engine.execute({ id: 'stale-open', type: 'wb_open' }, { silent: true });
    expect(useCanvasStore.getState().whiteboardOpen).toBe(false);
  });

  it('keeps cleanup helpers inert until the engine owns their channels', () => {
    const owner = createCanvasPresentationOwner();
    const engine = new ActionEngine(createStageStore(owner));
    useCanvasStore.getState().playVideo('external-video');
    useCanvasStore.getState().setWhiteboardOpen(true);
    useCanvasStore.getState().setWhiteboardClearing(true);

    engine.pauseVideo();
    engine.setWhiteboardOpen(false);
    engine.setWhiteboardClearing(false);

    expect(useCanvasStore.getState().playingVideoElementId).toBe('external-video');
    expect(useCanvasStore.getState().whiteboardOpen).toBe(true);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(true);

    engine.dispose();
    owner.dispose();
  });

  it('clears an owned whiteboard animation flag when the action is aborted', async () => {
    vi.useFakeTimers();
    const owner = createCanvasPresentationOwner();
    const store = createStageStore(owner);
    const whiteboard = store.getState().stage?.whiteboard?.[0];
    if (!whiteboard) throw new Error('fixture whiteboard missing');
    whiteboard.elements = [
      {
        id: 'element-1',
        type: 'text',
        content: 'clear me',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
      },
    ] as never;
    const engine = new ActionEngine(store);
    const controller = new AbortController();
    await engine.execute({ id: 'open', type: 'wb_open' }, { silent: true });

    const clearing = engine.execute(
      { id: 'clear', type: 'wb_clear' },
      { signal: controller.signal },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(true);

    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    await clearing;
    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);

    engine.dispose();
    owner.dispose();
  });

  it('does not start a pending video after a newer replay claims the channel', async () => {
    const oldOwner = createCanvasPresentationOwner();
    const newOwner = createCanvasPresentationOwner();
    const oldEngine = new ActionEngine(createStageStore(oldOwner));
    const newEngine = new ActionEngine(createStageStore(newOwner));

    useMediaGenerationStore.setState({
      tasks: {
        'video-replay': {
          elementId: 'video-replay',
          type: 'video',
          status: 'pending',
          prompt: '',
          params: {},
          retryCount: 0,
          stageId: 'stage-action-presentation-owner',
        },
      },
    });

    const oldPlayback = oldEngine.execute({
      id: 'old-pending-video',
      type: 'play_video',
      elementId: 'video-replay',
    });
    await Promise.resolve();

    const newPlayback = newEngine.execute({
      id: 'new-video',
      type: 'play_video',
      elementId: 'video-replay',
    });
    await Promise.resolve();

    useMediaGenerationStore.setState((state) => ({
      tasks: {
        ...state.tasks,
        'video-replay': {
          ...state.tasks['video-replay'],
          status: 'done',
          objectUrl: 'blob:ready',
        },
      },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useCanvasStore.getState().playingVideoElementId).toBe('video-replay');
    newEngine.pauseVideo();
    await Promise.all([oldPlayback, newPlayback]);
    expect(useCanvasStore.getState().playingVideoElementId).toBe('');

    oldEngine.dispose();
    newEngine.dispose();
    oldOwner.dispose();
    newOwner.dispose();
  });
});
