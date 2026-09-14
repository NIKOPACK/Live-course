import { describe, expect, it } from 'vitest';

import { applyLiveCourseTeachingAction } from '@/lib/api/stage-api';
import { teachingActionSchema, type TeachingAction } from '@/lib/livecourse/domain';
import type { StageStore } from '@/lib/api/stage-api-types';
import type { Scene, Stage, StageMode } from '@/lib/types/stage';

function action(
  value: Pick<TeachingAction, 'type' | 'payload'> & Partial<TeachingAction>,
): TeachingAction {
  return teachingActionSchema.parse({
    schemaVersion: 1,
    id: 'action-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    nodeId: 'node:scene-1',
    sequence: 1,
    timestamp: '2026-08-10T08:00:00.000Z',
    idempotencyKey: 'action-1',
    ...value,
  });
}

function mockStore() {
  const state = {
    stage: {
      id: 'stage-1',
      name: 'Stage',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [
        {
          id: 'board-1',
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          elements: [
            {
              id: 'text-1',
              type: 'text',
              left: 0,
              top: 0,
              width: 10,
              height: 10,
              rotate: 0,
              content: 'hello',
              defaultFontName: 'Arial',
              defaultColor: '#333333',
            },
          ],
          background: { type: 'solid', color: '#fff' },
          animations: [],
        },
      ],
    } as Stage,
    scenes: [
      { id: 'scene-1', stageId: 'stage-1', order: 0 },
      { id: 'scene-2', stageId: 'stage-1', order: 1 },
    ] as Scene[],
    currentSceneId: 'scene-1' as string | null,
    mode: 'playback' as StageMode,
  };
  const store: StageStore = {
    getState: () => state,
    setState: (partial) => Object.assign(state, partial),
    subscribe: () => () => {},
  };
  return { state, store };
}

describe('LiveCourse Stage action adapter', () => {
  it('maps scene and node navigation to the existing Stage API', () => {
    const { state, store } = mockStore();
    const byScene = applyLiveCourseTeachingAction(
      action({ type: 'stage.goto_scene', payload: { sceneId: 'scene-2' } }),
      store,
    );
    expect(byScene.success).toBe(true);
    expect(state.currentSceneId).toBe('scene-2');

    const byNode = applyLiveCourseTeachingAction(
      action({ type: 'lesson.goto_node', payload: { targetNodeId: 'node:scene-1' } }),
      store,
      { resolveNodeSceneId: () => 'scene-1' },
    );
    expect(byNode.success).toBe(true);
    expect(state.currentSceneId).toBe('scene-1');
  });

  it('clears the existing whiteboard without creating a second board', () => {
    const { state, store } = mockStore();
    const result = applyLiveCourseTeachingAction(
      action({ type: 'board.clear', payload: { whiteboardId: 'board-1' } }),
      store,
    );

    expect(result.success).toBe(true);
    expect(state.stage.whiteboard).toHaveLength(1);
    expect(state.stage.whiteboard?.[0].elements).toEqual([]);
  });

  it('leaves avatar actions for their dedicated consumer', () => {
    const { store } = mockStore();
    const result = applyLiveCourseTeachingAction(
      action({ type: 'avatar.expression', payload: { expression: 'think' } }),
      store,
    );

    expect(result).toEqual({ success: true, data: { handled: false } });
  });
});
