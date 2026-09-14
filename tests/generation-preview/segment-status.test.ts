import { describe, expect, it } from 'vitest';

import {
  allSegmentsCompleted,
  canEnterClassroom,
  canOpenSegmentMaterials,
  canRetrySegment,
  classroomEnterTarget,
  consumePendingClassroomEnterFailure,
  deriveSegmentProgress,
  PENDING_CLASSROOM_ENTER_FAILED_KEY,
  PENDING_CLASSROOM_ENTER_KEY,
} from '@/app/generation-preview/segment-status';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

function outline(id: string, order: number, title = id): SceneOutline {
  return {
    id,
    type: 'slide',
    title,
    description: title,
    keyPoints: [],
    order,
  };
}

function scene(id: string, order: number): Scene {
  return {
    id,
    stageId: 'stage-1',
    type: 'slide',
    title: id,
    order,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: { backgroundColor: '#fff', themeColors: ['#000'], fontColor: '#000', fontName: '' },
      },
    },
  } as Scene;
}

describe('deriveSegmentProgress', () => {
  const outlines = [outline('a', 0, 'Intro'), outline('b', 1, 'Check'), outline('c', 2, 'Close')];

  it('marks waiting / generating / completed / failed independently', () => {
    const segments = deriveSegmentProgress({
      outlines,
      scenes: [scene('scene-a', 0)],
      failedOutlines: [outlines[1]],
      generatingOutlines: [outlines[2]],
    });

    expect(segments.map((segment) => segment.status)).toEqual([
      'completed',
      'failed',
      'generating',
    ]);
    expect(allSegmentsCompleted(segments)).toBe(false);
  });

  it('treats missing scenes as waiting and empty decks as incomplete', () => {
    expect(allSegmentsCompleted([])).toBe(false);
    const segments = deriveSegmentProgress({
      outlines,
      scenes: [],
      failedOutlines: [],
      generatingOutlines: [],
    });
    expect(segments.map((segment) => segment.status)).toEqual(['waiting', 'waiting', 'waiting']);
    expect(allSegmentsCompleted(segments)).toBe(false);
  });

  it('does not treat a successful segment as failed after a later retry list changes', () => {
    const segments = deriveSegmentProgress({
      outlines,
      scenes: [scene('scene-a', 0), scene('scene-b', 1), scene('scene-c', 2)],
      failedOutlines: [],
      generatingOutlines: [],
    });

    expect(allSegmentsCompleted(segments)).toBe(true);
  });

  it('keeps completed segments completed even if their outline is still queued', () => {
    const segments = deriveSegmentProgress({
      outlines,
      scenes: [scene('scene-a', 0)],
      failedOutlines: [],
      generatingOutlines: outlines,
    });

    expect(segments[0].status).toBe('completed');
    expect(segments[1].status).toBe('generating');
  });

  it('attaches the generated scene and the current generating sub-step', () => {
    const completed = scene('scene-a', 0);
    const segments = deriveSegmentProgress({
      outlines,
      scenes: [completed],
      failedOutlines: [],
      generatingOutlines: [outlines[1]],
      generatingPhase: { outlineId: 'b', phase: 'actions' },
    });

    expect(segments[0].scene).toBe(completed);
    expect(segments[1].generatingPhase).toBe('actions');
    expect(segments[2].generatingPhase).toBeUndefined();
  });

  it('attaches the matching lesson-plan design without changing status', () => {
    const plan = {
      nodes: [
        {
          sceneId: 'b',
          order: 1,
          design: {
            teachingPoints: ['Check the derivative'],
            explanationPlan: 'Work one example.',
          },
        },
      ],
    } as LessonPlan;
    const segments = deriveSegmentProgress({
      outlines,
      scenes: [scene('scene-a', 0)],
      failedOutlines: [],
      generatingOutlines: [outlines[1]],
      lessonPlan: plan,
    });

    expect(segments[0].status).toBe('completed');
    expect(segments[1].design?.explanationPlan).toBe('Work one example.');
    expect(segments[2].design).toBeUndefined();
  });
});

describe('J2.1–J2.3 segment contracts', () => {
  it('lets waiting / generating / completed segments open materials and only failed retry', () => {
    expect(canOpenSegmentMaterials('waiting')).toBe(true);
    expect(canOpenSegmentMaterials('generating')).toBe(true);
    expect(canOpenSegmentMaterials('completed')).toBe(true);
    expect(canOpenSegmentMaterials('failed')).toBe(false);
    expect(canRetrySegment('failed')).toBe(true);
    expect(canRetrySegment('completed')).toBe(false);
    expect(canRetrySegment('generating')).toBe(false);
    expect(canRetrySegment('waiting')).toBe(false);
  });

  it('enables enter-classroom only when every segment is completed and not already navigating', () => {
    const ready = [
      { outlineId: 'a', order: 0, title: 'A', status: 'completed' as const },
      { outlineId: 'b', order: 1, title: 'B', status: 'completed' as const },
    ];
    expect(canEnterClassroom(ready)).toBe(true);
    expect(canEnterClassroom(ready, true)).toBe(false);
    expect(canEnterClassroom([{ ...ready[0], status: 'failed' }])).toBe(false);
    expect(canEnterClassroom([])).toBe(false);
  });

  it('stays on preview when save or stage id is missing', () => {
    expect(classroomEnterTarget({ saved: true, stageId: 'stage-1' })).toBe('stage-1');
    expect(classroomEnterTarget({ saved: false, stageId: 'stage-1' })).toBeNull();
    expect(classroomEnterTarget({ saved: true, stageId: '  ' })).toBeNull();
    expect(classroomEnterTarget({ saved: true, stageId: null })).toBeNull();
  });

  it('consumes the classroom-load-failure flag once and clears the pending enter key', () => {
    const storage = new Map<string, string>([
      [PENDING_CLASSROOM_ENTER_FAILED_KEY, '1'],
      [PENDING_CLASSROOM_ENTER_KEY, 'stage-1'],
    ]);
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
    };

    expect(consumePendingClassroomEnterFailure(adapter)).toBe(true);
    expect(storage.size).toBe(0);
    expect(consumePendingClassroomEnterFailure(adapter)).toBe(false);
  });
});
