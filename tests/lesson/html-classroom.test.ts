import { describe, expect, it } from 'vitest';
import {
  assertHtmlClassroom,
  ClassroomHtmlRequiredError,
  LEGACY_CLASSROOM_ERROR,
  LegacyClassroomError,
} from '@/lib/livecourse/lesson/html-classroom';
import { generateSceneContent } from '@/lib/generation/scene-generator';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { Scene } from '@/lib/types/stage';

const presentation = { mode: 'html' as const, visualStyle: 'Ink diagrams on warm paper.' };

function plan(): LessonPlan {
  return {
    schemaVersion: 1,
    id: 'lesson-plan:stage',
    courseId: 'course',
    stageId: 'stage',
    title: 'HTML class',
    version: 1,
    status: 'approved',
    createdAt: '2026-09-14T00:00:00.000Z',
    goals: [],
    nodes: [],
    presentation,
  };
}

function htmlScene(id: string, type: 'interactive' | 'quiz' = 'interactive'): Scene {
  const scene = {
    id,
    stageId: 'stage',
    title: id,
    order: 0,
  };
  return type === 'quiz'
    ? {
        ...scene,
        type: 'quiz',
        content: {
          type: 'quiz',
          questions: [
            {
              id: 'q1',
              type: 'single',
              question: 'Q',
              options: [{ value: 'a', label: 'A' }],
              answer: ['a'],
            },
          ],
          html: '<html><body><main id="quiz">Quiz</main></body></html>',
        },
      }
    : {
        ...scene,
        type: 'interactive',
        content: {
          type: 'interactive',
          url: '',
          html: '<html><body><main id="teach">Lesson</main></body></html>',
        },
      };
}

describe('HTML-only classroom', () => {
  it('accepts an HTML teaching page and checkpoint', () => {
    expect(() =>
      assertHtmlClassroom({
        lessonPlan: plan(),
        scenes: [htmlScene('teach'), htmlScene('check', 'quiz')],
      }),
    ).not.toThrow();
  });

  it('rejects a missing visual direction', () => {
    expect(() =>
      assertHtmlClassroom({ lessonPlan: { ...plan(), presentation: undefined }, scenes: [] }),
    ).toThrow(LegacyClassroomError);
  });

  it('rejects slide and PBL scenes', () => {
    const slide: Scene = {
      id: 'old',
      stageId: 'stage',
      type: 'slide',
      title: 'Old',
      order: 0,
      content: {
        type: 'slide',
        canvas: {
          id: 'c',
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
    expect(() => assertHtmlClassroom({ lessonPlan: plan(), scenes: [slide] })).toThrow(
      LegacyClassroomError,
    );
    expect(new LegacyClassroomError().message).toBe(LEGACY_CLASSROOM_ERROR);
  });

  it('refuses to generate scene content without an HTML direction', async () => {
    await expect(
      generateSceneContent(
        { id: 'intro', type: 'slide', title: 'Intro', description: 'x', keyPoints: [], order: 0 },
        async () => '<html></html>',
      ),
    ).rejects.toMatchObject({
      name: 'ClassroomHtmlRequiredError',
    } satisfies Partial<ClassroomHtmlRequiredError>);
  });
});
