import {
  lessonPlanSchema,
  type LessonNode,
  type LessonPlan,
} from '@/lib/livecourse/domain/schemas';
import { goalIdForScene, nodeIdForScene } from '@/lib/livecourse/domain/lesson-plan';
import type { SceneOutline } from '@/lib/types/generation';

const DEFAULT_GOAL_RULE = Object.freeze({
  version: 'livecourse-quiz-mastery-v1',
  passScore: 0.7,
  minAcceptedEvidence: 1,
  minPassingEvidence: 1,
});

export interface LessonPlanSkeletonInput {
  stageId: string;
  courseId?: string;
  requirement: string;
  courseTitle?: string;
  outlines: SceneOutline[];
  now?: string;
}

function nodeTypeForOutline(outline: SceneOutline): LessonNode['type'] {
  switch (outline.type) {
    case 'quiz':
      return 'checkpoint';
    case 'interactive':
      return 'interactive';
    case 'pbl':
      return 'project';
    default:
      return 'instruction';
  }
}

function orderedOutlines(input: LessonPlanSkeletonInput): SceneOutline[] {
  const ordered = [...input.outlines].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  if (ordered.length === 0 || ordered.some((outline) => !outline.id?.trim())) {
    throw new Error('Cannot build a lesson plan without non-empty outline ids');
  }
  return ordered;
}

/**
 * Build a schema-valid plan from the actual outline entries without inventing
 * nodes. This module intentionally has no LLM/subagent imports so the
 * generation-preview client can use the truthful fallback safely.
 */
export function buildLessonPlanSkeleton(input: LessonPlanSkeletonInput): LessonPlan {
  const ordered = orderedOutlines(input);
  const courseId = input.courseId?.trim() || input.stageId.trim();
  const stageId = input.stageId.trim();
  if (!courseId || !stageId) {
    throw new Error('Lesson plan identity requires non-empty courseId and stageId');
  }

  const quizOutlines = ordered.filter((outline) => outline.type === 'quiz');
  const fallbackGoalId = `goal:${courseId}:lesson`;
  const goals =
    quizOutlines.length > 0
      ? quizOutlines.map((outline) => ({
          id: goalIdForScene(outline.id),
          title: outline.title || '课堂检查点',
          description: `通过课堂节点“${outline.title || outline.id}”的可审计结果判断掌握状态。`,
          rule: DEFAULT_GOAL_RULE,
        }))
      : [
          {
            id: fallbackGoalId,
            title: input.courseTitle || '本课学习目标',
            description: '等待课堂检查点或教师复核证据。',
            rule: DEFAULT_GOAL_RULE,
          },
        ];
  const goalIds = new Set(goals.map((goal) => goal.id));

  return lessonPlanSchema.parse({
    schemaVersion: 1,
    id: `lesson-plan:${courseId}`,
    courseId,
    stageId,
    title: input.courseTitle || input.requirement.slice(0, 50) || 'LiveCourse Lesson',
    version: 1,
    status: 'approved',
    createdAt: input.now ?? new Date().toISOString(),
    goals,
    nodes: ordered.map((outline) => {
      const sceneGoalId = goalIdForScene(outline.id);
      return {
        id: nodeIdForScene(outline.id),
        sceneId: outline.id,
        title: outline.title || `Scene ${outline.order + 1}`,
        type: nodeTypeForOutline(outline),
        order: outline.order,
        goalIds: goalIds.has(sceneGoalId)
          ? [sceneGoalId]
          : [fallbackGoalId].filter((id) => goalIds.has(id)),
      };
    }),
  });
}
