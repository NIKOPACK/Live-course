import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCanvasAPI, createCanvasPresentationOwner } from '@/lib/api/stage-api-canvas';
import { createStagePresentationStore } from '@/lib/api/stage-api';
import type { TeachingAction } from '@/lib/livecourse/domain';
import { createTeachingPresentationApplier } from '@/lib/livecourse/session/context';
import { useCanvasStore } from '@/lib/store/canvas';

describe('teaching presentation compensation', () => {
  beforeEach(() => {
    useCanvasStore.getState().resetCanvasState();
  });

  afterEach(() => {
    useCanvasStore.getState().resetCanvasState();
  });

  it('rolls back only the action channel when another owner changes zoom', async () => {
    const presentationStore = createStagePresentationStore({ fence: false });
    const otherOwner = createCanvasPresentationOwner();
    const otherCanvas = createCanvasAPI(presentationStore, {
      presentationOwner: otherOwner,
    });
    const apply = createTeachingPresentationApplier({ presentationStore });
    const action = {
      schemaVersion: 1,
      id: 'action-highlight',
      sequence: 0,
      classroomSessionId: 'classroom-session',
      courseId: 'course',
      lessonId: 'lesson',
      nodeId: 'node',
      timestamp: '2026-08-10T09:00:00.000Z',
      idempotencyKey: 'action-highlight',
      type: 'stage.highlight',
      payload: {
        sceneId: 'scene-1',
        elementId: 'owned-highlight',
      },
    } as TeachingAction;

    try {
      const result = await apply(action);
      expect(result.success).toBe(true);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['owned-highlight']);

      expect(
        otherCanvas.setZoom(
          'scene-1',
          'other-zoom',
          { x: 0, y: 0, w: 0, h: 0, centerX: 0, centerY: 0 },
          2,
        ),
      ).toMatchObject({ success: true });

      expect(() => result.rollback?.()).not.toThrow();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      expect(useCanvasStore.getState().zoomTarget).toEqual({
        elementId: 'other-zoom',
        scale: 2,
      });
    } finally {
      presentationStore.presentation.dispose();
      otherOwner.dispose();
    }
  });

  it('rejects rollback when another owner replaces the action channel', async () => {
    const presentationStore = createStagePresentationStore({ fence: false });
    const otherOwner = createCanvasPresentationOwner();
    const otherCanvas = createCanvasAPI(presentationStore, {
      presentationOwner: otherOwner,
    });
    const apply = createTeachingPresentationApplier({ presentationStore });
    const action = {
      schemaVersion: 1,
      id: 'action-highlight',
      sequence: 0,
      classroomSessionId: 'classroom-session',
      courseId: 'course',
      lessonId: 'lesson',
      nodeId: 'node',
      timestamp: '2026-08-10T09:00:00.000Z',
      idempotencyKey: 'action-highlight',
      type: 'stage.highlight',
      payload: {
        sceneId: 'scene-1',
        elementId: 'owned-highlight',
      },
    } as TeachingAction;

    try {
      const result = await apply(action);
      expect(result.success).toBe(true);
      expect(otherCanvas.highlight('scene-1', 'replacement-highlight')).toMatchObject({
        success: true,
      });

      expect(() => result.rollback?.()).toThrow(
        'Teaching presentation changed before rollback could complete',
      );
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['replacement-highlight']);
    } finally {
      presentationStore.presentation.dispose();
      otherOwner.dispose();
    }
  });
});
