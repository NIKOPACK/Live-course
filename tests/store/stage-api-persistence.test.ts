import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { incrementalSave } = vi.hoisted(() => ({
  incrementalSave: vi.fn().mockResolvedValue({ failedChanges: [] }),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: (...args: unknown[]) => incrementalSave(...args),
  loadStageData: vi.fn().mockResolvedValue(null),
}));

import { createStageAPI, createStagePresentationStore } from '@/lib/api/stage-api';
import { flushStageSave, isStagePresentationFenceActive, useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';

const stage: Stage = {
  id: 'stage-1',
  name: 'Stage',
  createdAt: 1,
  updatedAt: 1,
};

const scene: Scene = {
  id: 'scene-1',
  stageId: stage.id,
  type: 'slide',
  title: 'Scene',
  order: 1,
  content: {
    type: 'slide',
    canvas: {
      id: 'canvas-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#fff',
        themeColors: ['#000'],
        fontColor: '#000',
        fontName: 'Inter',
      },
      elements: [],
    },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  incrementalSave.mockReset().mockResolvedValue({ failedChanges: [] });
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage,
    scenes: [scene],
    currentSceneId: 'scene-1',
  });
});

afterEach(() => {
  useStageStore.getState().clearStore();
  vi.useRealTimers();
});

describe('Stage API persistence injection', () => {
  it('classifies production raw setState mutations by persisted owner', async () => {
    const api = createStageAPI(useStageStore);

    expect(
      api.element.add('scene-1', {
        type: 'text',
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        content: 'hello',
      }).success,
    ).toBe(true);
    await flushStageSave();
    expect(incrementalSave.mock.calls[0]![1]).toEqual([{ kind: 'scene', sceneId: 'scene-1' }]);

    expect(api.whiteboard.create().success).toBe(true);
    await flushStageSave();
    expect(incrementalSave.mock.calls[1]![1]).toEqual([{ kind: 'stage' }]);

    expect(api.scene.create({ type: 'slide', title: 'New scene' }).success).toBe(true);
    await flushStageSave();
    expect(incrementalSave.mock.calls[2]![1]).toEqual([{ kind: 'structure' }]);
  });

  it('keeps presentation-only navigation and whiteboard effects out of document persistence', async () => {
    const presentationStore = createStagePresentationStore();
    try {
      const api = createStageAPI(presentationStore);

      expect(api.navigation.goTo('scene-1').success).toBe(true);
      expect(api.whiteboard.create().success).toBe(true);
      expect(api.whiteboard.get().success).toBe(true);

      await flushStageSave();

      expect(incrementalSave).not.toHaveBeenCalled();
      expect(useStageStore.getState().currentSceneId).toBe('scene-1');
      expect(useStageStore.getState().stage?.whiteboard).toHaveLength(1);
    } finally {
      presentationStore.presentation.dispose();
    }
  });

  it('captures a lazy presentation baseline at the first effective mutation', () => {
    const presentationStore = createStagePresentationStore({ fence: 'lazy' });
    const loadedStage: Stage = { ...stage, name: 'Loaded after adapter creation' };
    const loadedScene: Scene = { ...scene, id: 'scene-loaded' };
    const targetScene: Scene = { ...scene, id: 'scene-target', order: 2 };

    try {
      expect(isStagePresentationFenceActive()).toBe(false);

      // Simulate an async document load completing after React created the
      // render-owned adapter but before replay applies its first scene.
      useStageStore.setState({
        stage: loadedStage,
        scenes: [loadedScene, targetScene],
        currentSceneId: loadedScene.id,
      });

      presentationStore.setState({ currentSceneId: targetScene.id });
      expect(isStagePresentationFenceActive()).toBe(true);
      expect(useStageStore.getState().currentSceneId).toBe(targetScene.id);

      presentationStore.presentation.restore();
      expect(useStageStore.getState().stage).toEqual(loadedStage);
      expect(useStageStore.getState().scenes).toEqual([loadedScene, targetScene]);
      expect(useStageStore.getState().currentSceneId).toBe(loadedScene.id);
    } finally {
      presentationStore.presentation.dispose();
    }

    expect(isStagePresentationFenceActive()).toBe(false);
  });

  it('does not acquire a lazy presentation fence for a no-op mutation', () => {
    const presentationStore = createStagePresentationStore({ fence: 'lazy' });

    try {
      expect(isStagePresentationFenceActive()).toBe(false);

      presentationStore.setState({ currentSceneId: useStageStore.getState().currentSceneId });

      expect(isStagePresentationFenceActive()).toBe(false);
      presentationStore.presentation.restore();
      presentationStore.presentation.restore();
      expect(useStageStore.getState().currentSceneId).toBe('scene-1');
    } finally {
      presentationStore.presentation.dispose();
      presentationStore.presentation.dispose();
    }

    expect(presentationStore.presentation.isDisposed()).toBe(true);
    expect(isStagePresentationFenceActive()).toBe(false);
  });

  it('keeps restore and dispose idempotent across repeated presentation attempts', () => {
    const presentationStore = createStagePresentationStore({ fence: 'lazy' });

    presentationStore.setState({ currentSceneId: null });
    expect(isStagePresentationFenceActive()).toBe(true);

    presentationStore.presentation.restore();
    presentationStore.presentation.restore();
    expect(useStageStore.getState().currentSceneId).toBe('scene-1');

    presentationStore.setState({ currentSceneId: null });
    presentationStore.presentation.dispose();
    presentationStore.presentation.dispose();

    expect(useStageStore.getState().currentSceneId).toBe('scene-1');
    expect(presentationStore.presentation.isDisposed()).toBe(true);
    expect(isStagePresentationFenceActive()).toBe(false);
  });

  it('journals direct restoreSnapshot writes for later disposal', () => {
    const presentationStore = createStagePresentationStore({ fence: 'lazy' });
    const before = presentationStore.presentation.capture();
    const temporary = {
      ...before,
      currentSceneId: null,
    };

    try {
      presentationStore.presentation.restoreSnapshot(temporary);
      expect(useStageStore.getState().currentSceneId).toBeNull();
      expect(isStagePresentationFenceActive()).toBe(true);
    } finally {
      presentationStore.presentation.dispose();
    }

    expect(useStageStore.getState().currentSceneId).toBe(before.currentSceneId);
    expect(isStagePresentationFenceActive()).toBe(false);
  });

  it('routes every raw-setState Stage API module through the guarded store', () => {
    const apiDir = path.join(process.cwd(), 'lib/api');
    const modules = [
      ['stage-api-scene.ts', 'createSceneAPI'],
      ['stage-api-element.ts', 'createElementAPI'],
      ['stage-api-canvas.ts', 'createCanvasAPI'],
      ['stage-api-mode.ts', 'createModeAPI'],
      ['stage-api-mode.ts', 'createStageMetaAPI'],
      ['stage-api-navigation.ts', 'createNavigationAPI'],
      ['stage-api-whiteboard.ts', 'createWhiteboardAPI'],
    ] as const;
    const composition = fs.readFileSync(path.join(apiDir, 'stage-api.ts'), 'utf8');

    for (const [file, factory] of modules) {
      const source = fs.readFileSync(path.join(apiDir, file), 'utf8');
      expect(source, `${file} must remain covered by this inventory`).toContain('store.setState(');
      expect(composition, `${factory} must receive the persistence wrapper`).toContain(
        `${factory}(persistenceStore)`,
      );
    }
    expect(composition).toContain('markStagePersistenceDirty(changes)');
  });
});
