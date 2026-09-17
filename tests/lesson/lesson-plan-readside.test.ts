import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import {
  bindLessonPlanToGeneratedScenes,
  lessonPlanSchema,
  nodeIdForScene,
  type LessonPlan,
} from '@/lib/livecourse/domain';
import { resolveLessonPlan, resolveRecoverySceneId } from '@/lib/livecourse/session/context';
import type { Scene, Stage } from '@/lib/types/stage';

const STAGE: Stage = {
  id: 'stage-1',
  name: 'Algebra',
  createdAt: Date.parse('2026-08-10T08:00:00.000Z'),
  updatedAt: Date.parse('2026-08-10T08:00:00.000Z'),
} as Stage;

const SCENES = [
  { id: 'slide-1', stageId: STAGE.id, title: 'Concept', type: 'slide', order: 0 },
  { id: 'quiz-1', stageId: STAGE.id, title: 'Check', type: 'quiz', order: 1 },
] as Scene[];

function persistedPlan(): LessonPlan {
  return lessonPlanSchema.parse({
    schemaVersion: 1,
    id: `lesson-plan:${STAGE.id}`,
    courseId: STAGE.id,
    stageId: STAGE.id,
    title: 'Algebra (designed)',
    version: 1,
    status: 'approved',
    createdAt: '2026-08-10T08:00:00.000Z',
    goals: [
      {
        id: 'goal:quiz-1',
        title: 'Checkpoint goal',
        description: 'Pass the checkpoint.',
        rule: {
          version: 'livecourse-quiz-mastery-v1',
          passScore: 0.7,
          minAcceptedEvidence: 1,
          minPassingEvidence: 1,
        },
      },
    ],
    nodes: SCENES.map((scene, index) => ({
      id: nodeIdForScene(scene.id),
      sceneId: scene.id,
      title: scene.title,
      type: scene.type === 'quiz' ? 'checkpoint' : 'instruction',
      order: index,
      goalIds: ['goal:quiz-1'],
      design: {
        teachingPoints: ['Point A', 'Point B'],
        explanationPlan: 'Hook, expand, recap.',
        anticipatedQuestions: [{ question: 'Why?', response: 'Because…' }],
      },
    })),
    presentation: { mode: 'html', visualStyle: 'Ink diagrams on warm paper.' },
  });
}

describe('resolveLessonPlan (A1 read side)', () => {
  it('uses the persisted lesson plan from the outline snapshot when present', () => {
    const plan = persistedPlan();

    const resolved = resolveLessonPlan({
      stage: STAGE,
      scenes: SCENES,
      persistedLessonPlan: plan,
    });

    expect(resolved).toEqual(plan);
    // Teach-side design survives the round trip instead of being re-derived.
    expect(resolved.nodes[0].design?.teachingPoints).toEqual(['Point A', 'Point B']);
    expect(resolved.nodes[0].design?.anticipatedQuestions).toEqual([
      { question: 'Why?', response: 'Because…' },
    ]);
  });

  it.each([undefined, null])(
    'refuses to derive a legacy plan when the snapshot plan is %s',
    (absent) => {
      expect(() =>
        resolveLessonPlan({
          stage: STAGE,
          scenes: SCENES,
          persistedLessonPlan: absent,
        }),
      ).toThrow(/no HTML lesson plan/i);
    },
  );

  it('refuses a persisted plan that is not an HTML classroom', () => {
    const { presentation: _presentation, ...rest } = persistedPlan();
    expect(() =>
      resolveLessonPlan({
        stage: STAGE,
        scenes: SCENES,
        persistedLessonPlan: rest,
      }),
    ).toThrow(/not an HTML classroom/i);
  });

  it('fails loudly when an explicitly persisted snapshot plan is corrupt', () => {
    const corrupt = {
      ...persistedPlan(),
      schemaVersion: 2,
      nodes: 'not-an-array',
    };

    expect(() =>
      resolveLessonPlan({
        stage: STAGE,
        scenes: SCENES,
        persistedLessonPlan: corrupt,
      }),
    ).toThrow(/persisted lesson plan.*invalid/i);
  });

  it('fails loudly when a valid persisted plan belongs to another identity', () => {
    const plan = persistedPlan();

    expect(() =>
      resolveLessonPlan({
        stage: STAGE,
        scenes: SCENES,
        persistedLessonPlan: { ...plan, stageId: 'stage-other' },
      }),
    ).toThrow(/belongs to stage/i);
    expect(() =>
      resolveLessonPlan({
        stage: STAGE,
        scenes: SCENES,
        persistedLessonPlan: plan,
        courseId: 'course-other',
      }),
    ).toThrow(/belongs to course/i);
  });
});

const GENERATED_SCENE_ID = 'BOZ_Eshc5ap3oACPP8B-R';

function outlineKeyedPlan(): LessonPlan {
  return lessonPlanSchema.parse({
    schemaVersion: 1,
    id: `lesson-plan:${STAGE.id}`,
    courseId: STAGE.id,
    stageId: STAGE.id,
    title: 'Python 零基础入门',
    version: 1,
    status: 'approved',
    createdAt: '2026-08-10T08:00:00.000Z',
    presentation: { mode: 'html', visualStyle: 'Ink diagrams on warm paper.' },
    goals: [
      {
        id: 'goal:outline-check',
        title: 'Checkpoint goal',
        description: 'Pass the checkpoint.',
        rule: {
          version: 'livecourse-quiz-mastery-v1',
          passScore: 0.7,
          minAcceptedEvidence: 1,
          minPassingEvidence: 1,
        },
      },
    ],
    nodes: [
      {
        id: 'node:outline-intro',
        sceneId: 'outline-intro',
        title: '认识 Python',
        type: 'instruction',
        order: 0,
        goalIds: ['goal:outline-check'],
        design: {
          teachingPoints: ['What Python is'],
          explanationPlan: 'Name it, then show a tiny program.',
        },
      },
      {
        id: 'node:outline-check',
        sceneId: 'outline-check',
        title: '小测验',
        type: 'checkpoint',
        order: 1,
        goalIds: ['goal:outline-check'],
      },
    ],
  });
}

const GENERATED_SCENES = [
  {
    id: GENERATED_SCENE_ID,
    stageId: STAGE.id,
    title: '认识 Python',
    type: 'slide',
    order: 0,
    outlineId: 'outline-intro',
  },
  {
    id: 'quiz-nanoid',
    stageId: STAGE.id,
    title: '小测验',
    type: 'quiz',
    order: 1,
    outlineId: 'outline-check',
  },
] as Scene[];

describe('bindLessonPlanToGeneratedScenes', () => {
  it('rewrites outline-keyed nodes onto generated scene ids', () => {
    const plan = outlineKeyedPlan();
    const bound = bindLessonPlanToGeneratedScenes(plan, GENERATED_SCENES);

    expect(bound.nodes.map((node) => node.id)).toEqual([
      nodeIdForScene(GENERATED_SCENE_ID),
      nodeIdForScene('quiz-nanoid'),
    ]);
    expect(bound.nodes.map((node) => node.sceneId)).toEqual([GENERATED_SCENE_ID, 'quiz-nanoid']);
    expect(bound.nodes[0].design?.teachingPoints).toEqual(['What Python is']);
    expect(bound.nodes[0].goalIds).toEqual(['goal:outline-check']);
  });

  it('is a no-op when nodes already point at generated scene ids', () => {
    const plan = persistedPlan();
    expect(bindLessonPlanToGeneratedScenes(plan, SCENES)).toBe(plan);
  });

  it('fails loudly when two generated scenes share an outlineId', () => {
    expect(() =>
      bindLessonPlanToGeneratedScenes(outlineKeyedPlan(), [
        GENERATED_SCENES[0],
        { ...GENERATED_SCENES[1], outlineId: 'outline-intro' },
      ]),
    ).toThrow(/share outlineId "outline-intro"/i);
  });
});

describe('resolveLessonPlan binds generated scenes', () => {
  it('lets continue restore a scene-nanoid recovery point against an outline-keyed plan', () => {
    const resolved = resolveLessonPlan({
      stage: STAGE,
      scenes: GENERATED_SCENES,
      persistedLessonPlan: outlineKeyedPlan(),
    });

    expect(resolved.nodes[0].id).toBe(nodeIdForScene(GENERATED_SCENE_ID));
    expect(resolved.nodes[0].sceneId).toBe(GENERATED_SCENE_ID);
    expect(resolved.nodes[0].title).toBe('认识 Python');
    expect(
      resolveRecoverySceneId(
        { currentNodeId: nodeIdForScene(GENERATED_SCENE_ID), lastSequence: 0 },
        resolved,
      ),
    ).toBe(GENERATED_SCENE_ID);
  });
});
