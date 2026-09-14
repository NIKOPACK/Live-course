/**
 * A5 教案配图（docs/spec/04-detailed-design.md §5/§7、05 A5）：
 * 声明式 visualAids 的 schema 与 outline 合并行为。
 */
import { describe, expect, test } from 'vitest';
import {
  lessonNodeDesignSchema,
  lessonPlanSchema,
  type LessonPlan,
} from '@/lib/livecourse/domain/schemas';
import {
  applyVisualAidsToOutlines,
  visualAidToMediaRequest,
} from '@/lib/livecourse/lesson/visual-aids';
import type { SceneOutline } from '@/lib/types/generation';

const NOW = '2026-08-21T00:00:00.000Z';

function makePlan(visualAids?: unknown): LessonPlan {
  return lessonPlanSchema.parse({
    schemaVersion: 1,
    id: 'lesson-plan:stage-1',
    courseId: 'stage-1',
    stageId: 'stage-1',
    title: '水循环',
    version: 1,
    status: 'approved',
    createdAt: NOW,
    goals: [
      {
        id: 'goal:stage-1:lesson',
        title: '理解水循环',
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
        id: 'node:scene-intro',
        sceneId: 'scene-intro',
        title: '水循环引入',
        type: 'instruction',
        order: 0,
        goalIds: ['goal:stage-1:lesson'],
        design: {
          teachingPoints: ['蒸发', '凝结'],
          explanationPlan: '从海面蒸发讲起',
          ...(visualAids !== undefined ? { visualAids } : {}),
        },
      },
      {
        id: 'node:scene-quiz',
        sceneId: 'scene-quiz',
        title: '检查点',
        type: 'checkpoint',
        order: 1,
        goalIds: ['goal:stage-1:lesson'],
      },
    ],
  });
}

const outlines: SceneOutline[] = [
  {
    id: 'scene-intro',
    type: 'slide',
    title: '水循环引入',
    description: '',
    keyPoints: ['蒸发'],
    order: 0,
  },
  {
    id: 'scene-quiz',
    type: 'quiz',
    title: '检查点',
    description: '',
    keyPoints: ['水循环过程'],
    order: 1,
  },
];

describe('lessonNodeDesignSchema.visualAids (A5)', () => {
  test('接受合法 visualAids 并保留字段', () => {
    const design = lessonNodeDesignSchema.parse({
      teachingPoints: ['要点'],
      explanationPlan: '怎么讲',
      visualAids: [
        {
          id: 'lesson_img_scene-intro_1',
          prompt: '水循环示意图，所有标注为中文',
          purpose: '建立整体过程图景',
          aspectRatio: '16:9',
        },
      ],
    });
    expect(design.visualAids).toHaveLength(1);
    expect(design.visualAids![0].id).toBe('lesson_img_scene-intro_1');
  });

  test('无 visualAids 的旧 design 仍可解析（schema 只加可选字段）', () => {
    const design = lessonNodeDesignSchema.parse({
      teachingPoints: ['要点'],
      explanationPlan: '怎么讲',
    });
    expect(design.visualAids).toBeUndefined();
  });

  test('拒绝未知字段与非法 aspectRatio', () => {
    expect(() =>
      lessonNodeDesignSchema.parse({
        teachingPoints: ['要点'],
        explanationPlan: '怎么讲',
        visualAids: [{ id: 'a', prompt: 'p', aspectRatio: '3:4' }],
      }),
    ).toThrow();
    expect(() =>
      lessonNodeDesignSchema.parse({
        teachingPoints: ['要点'],
        explanationPlan: '怎么讲',
        visualAids: [{ id: 'a', prompt: 'p', extra: 'x' }],
      }),
    ).toThrow();
  });
});

describe('applyVisualAidsToOutlines (A5)', () => {
  test('把节点配图合并为对应 outline 的 image mediaGenerations', () => {
    const plan = makePlan([
      {
        id: 'lesson_img_scene-intro_1',
        prompt: '水循环示意图，所有标注为中文',
        purpose: '建立整体图景',
        aspectRatio: '4:3',
      },
    ]);
    const merged = applyVisualAidsToOutlines(plan, outlines);

    expect(merged[0].mediaGenerations).toEqual([
      {
        type: 'image',
        prompt: '水循环示意图，所有标注为中文',
        elementId: 'lesson_img_scene-intro_1',
        aspectRatio: '4:3',
      },
    ]);
    // 无配图的节点 outline 原样保留
    expect(merged[1]).toBe(outlines[1]);
    // 不修改输入
    expect(outlines[0].mediaGenerations).toBeUndefined();
  });

  test('幂等：已存在的 elementId 不重复追加', () => {
    const existing: SceneOutline = {
      ...outlines[0],
      mediaGenerations: [
        { type: 'image', prompt: '旧 prompt', elementId: 'lesson_img_scene-intro_1' },
      ],
    };
    const plan = makePlan([
      { id: 'lesson_img_scene-intro_1', prompt: '新 prompt' },
      { id: 'lesson_img_scene-intro_2', prompt: '第二张图' },
    ]);
    const merged = applyVisualAidsToOutlines(plan, [existing, outlines[1]]);
    expect(merged[0].mediaGenerations).toHaveLength(2);
    expect(merged[0].mediaGenerations![0].prompt).toBe('旧 prompt');
    expect(merged[0].mediaGenerations![1].elementId).toBe('lesson_img_scene-intro_2');
  });

  test('lessonPlan 为空或无 visualAids 时原样返回输入数组', () => {
    expect(applyVisualAidsToOutlines(null, outlines)).toBe(outlines);
    expect(applyVisualAidsToOutlines(makePlan(undefined), outlines)).toBe(outlines);
  });
});

describe('visualAidToMediaRequest (A5)', () => {
  test('省略 aspectRatio 时不带该字段（由执行层取默认 16:9）', () => {
    expect(visualAidToMediaRequest({ id: 'x', prompt: 'p' })).toEqual({
      type: 'image',
      prompt: 'p',
      elementId: 'x',
    });
  });
});
