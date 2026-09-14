import { z } from 'zod';

import {
  identifierSchema,
  learningGoalSchema,
  lessonNodeSchema,
  lessonPlanSchema,
  timestampSchema,
  type LessonPlan,
} from './schemas';

export {
  assistantTaskConfirmationSchema,
  assistantTaskEventSchema,
  assistantTaskInputRefSchema,
  assistantTaskJsonValueSchema,
  assistantTaskKindSchema,
  assistantTaskProposalSchema,
  assistantTaskSchema,
  assistantTaskSnapshotSchema,
  ASSISTANT_TASK_KINDS,
  ASSISTANT_TASK_SCHEMA_VERSION,
  AssistantTaskIdempotencyConflictError,
  AssistantTaskNotFoundError,
  AssistantTaskService,
  AssistantTaskStateError,
  recoverAssistantTaskSnapshot,
} from './assistant-task';
export type {
  AssistantTask,
  AssistantTaskConfirmation,
  AssistantTaskCreationInput,
  AssistantTaskEvent,
  AssistantTaskKind,
  AssistantTaskProposal,
  AssistantTaskSnapshot,
} from './assistant-task';

/** The schema revision of the course-level contract (not a plan edit number). */
export const COURSE_PLAN_SCHEMA_VERSION = 1 as const;

const courseLessonSchema = z
  .object({
    id: identifierSchema,
    stageId: identifierSchema,
    title: z.string().trim().min(1).max(500),
    order: z.number().int().nonnegative(),
    dependsOn: z.array(identifierSchema),
    nodes: z.array(lessonNodeSchema).min(1),
  })
  .strict();

export const checkpointRuleSchema = z
  .object({
    id: identifierSchema,
    nodeId: identifierSchema,
    goalIds: z.array(identifierSchema).min(1),
    required: z.boolean(),
  })
  .strict();

export const coursePlanSchema = z
  .object({
    schemaVersion: z.literal(COURSE_PLAN_SCHEMA_VERSION),
    id: identifierSchema,
    courseId: identifierSchema,
    title: z.string().trim().min(1).max(500),
    version: z.number().int().positive(),
    status: z.enum(['draft', 'approved', 'archived']),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    goals: z.array(learningGoalSchema).min(1),
    // A course is the learner's single classroom journey. Older persisted
    // plans may contain multiple lessons, so the lower bound is intentionally
    // permissive while new generation bootstraps one lesson below.
    lessons: z.array(courseLessonSchema).min(1),
    checkpointRules: z.array(checkpointRuleSchema),
  })
  .strict()
  .superRefine((plan, context) => {
    const goalIds = new Set<string>();
    for (const [index, goal] of plan.goals.entries()) {
      if (goalIds.has(goal.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate goal id: ${goal.id}`,
          path: ['goals', index, 'id'],
        });
      }
      goalIds.add(goal.id);
    }

    const lessonIds = new Set<string>();
    const stageIds = new Set<string>();
    const nodeIds = new Set<string>();
    for (const [index, lesson] of plan.lessons.entries()) {
      if (lessonIds.has(lesson.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate lesson id: ${lesson.id}`,
          path: ['lessons', index, 'id'],
        });
      }
      if (stageIds.has(lesson.stageId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate lesson stage id: ${lesson.stageId}`,
          path: ['lessons', index, 'stageId'],
        });
      }
      lessonIds.add(lesson.id);
      stageIds.add(lesson.stageId);

      for (const [dependencyIndex, dependency] of lesson.dependsOn.entries()) {
        if (dependency === lesson.id || !lessonIds.has(dependency)) {
          // The existence check is completed below as well. Doing it here gives
          // the common forward-reference case a precise path without changing
          // the deterministic dependency validation.
          if (dependency === lesson.id) {
            context.addIssue({
              code: 'custom',
              message: `Lesson ${lesson.id} cannot depend on itself`,
              path: ['lessons', index, 'dependsOn', dependencyIndex],
            });
          }
        }
      }

      for (const [nodeIndex, node] of lesson.nodes.entries()) {
        if (nodeIds.has(node.id)) {
          context.addIssue({
            code: 'custom',
            message: `Duplicate node id: ${node.id}`,
            path: ['lessons', index, 'nodes', nodeIndex, 'id'],
          });
        }
        nodeIds.add(node.id);
        for (const [goalIndex, goalId] of node.goalIds.entries()) {
          if (!goalIds.has(goalId)) {
            context.addIssue({
              code: 'custom',
              message: `Unknown goal id: ${goalId}`,
              path: ['lessons', index, 'nodes', nodeIndex, 'goalIds', goalIndex],
            });
          }
        }
      }
    }

    for (const [index, lesson] of plan.lessons.entries()) {
      for (const [dependencyIndex, dependency] of lesson.dependsOn.entries()) {
        if (!lessonIds.has(dependency)) {
          context.addIssue({
            code: 'custom',
            message: `Unknown lesson dependency: ${dependency}`,
            path: ['lessons', index, 'dependsOn', dependencyIndex],
          });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(plan.lessons.map((lesson) => [lesson.id, lesson]));
    const visit = (lessonId: string): void => {
      if (visiting.has(lessonId)) {
        context.addIssue({
          code: 'custom',
          message: `Lesson dependency cycle includes ${lessonId}`,
          path: ['lessons'],
        });
        return;
      }
      if (visited.has(lessonId)) return;
      visiting.add(lessonId);
      for (const dependency of byId.get(lessonId)?.dependsOn ?? []) {
        if (byId.has(dependency)) visit(dependency);
      }
      visiting.delete(lessonId);
      visited.add(lessonId);
    };
    for (const lesson of plan.lessons) visit(lesson.id);

    const checkpointIds = new Set<string>();
    for (const [index, checkpoint] of plan.checkpointRules.entries()) {
      if (checkpointIds.has(checkpoint.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate checkpoint rule id: ${checkpoint.id}`,
          path: ['checkpointRules', index, 'id'],
        });
      }
      checkpointIds.add(checkpoint.id);
      if (!nodeIds.has(checkpoint.nodeId)) {
        context.addIssue({
          code: 'custom',
          message: `Unknown checkpoint node: ${checkpoint.nodeId}`,
          path: ['checkpointRules', index, 'nodeId'],
        });
      }
      for (const [goalIndex, goalId] of checkpoint.goalIds.entries()) {
        if (!goalIds.has(goalId)) {
          context.addIssue({
            code: 'custom',
            message: `Unknown checkpoint goal: ${goalId}`,
            path: ['checkpointRules', index, 'goalIds', goalIndex],
          });
        }
      }
    }
  });

export type CourseLesson = z.infer<typeof courseLessonSchema>;
export type CheckpointRule = z.infer<typeof checkpointRuleSchema>;
export type CoursePlan = z.infer<typeof coursePlanSchema>;

/**
 * A generated lesson is the source of truth for the executable nodes, while
 * the course-state contract stores those nodes under a course-level plan. A
 * malformed or underspecified lesson must fail at this boundary rather than
 * being padded with invented teaching content.
 */
export class CoursePlanBootstrapError extends Error {
  override readonly name = 'CoursePlanBootstrapError';
}

export interface DeriveCoursePlanFromLessonPlanInput {
  lessonPlan: LessonPlan;
  /** Stable course identity allocated when generation starts. */
  courseId: string;
  /** Stage identity used by the current classroom runtime. */
  stageId: string;
  /** The lesson opened by the current classroom route. Defaults to courseId. */
  lessonId?: string;
  /** Stable timestamp for an idempotent initial snapshot. */
  now?: string;
}

/**
 * Derive the durable course aggregate used by `CourseStateSnapshot` from the
 * generated lesson plan. The current product exposes one classroom journey.
 * Keep every generated node in the selected lesson instead of inventing a
 * second lesson merely to satisfy an older multi-lesson shape. Existing
 * persisted plans with multiple lessons remain valid because the schema still
 * accepts them.
 */
export function deriveCoursePlanFromLessonPlan(
  input: DeriveCoursePlanFromLessonPlanInput,
): CoursePlan {
  const lessonPlan = lessonPlanSchema.parse(input.lessonPlan);
  const courseId = identifierSchema.parse(input.courseId);
  const stageId = identifierSchema.parse(input.stageId);
  const initialLessonId = identifierSchema.parse(input.lessonId ?? courseId);

  const orderedNodes = [...lessonPlan.nodes].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  if (orderedNodes.length === 0) {
    throw new CoursePlanBootstrapError(
      'A course state bootstrap requires at least one lesson node',
    );
  }

  const fallbackGoalId = `goal:${courseId}:lesson`;
  const goals =
    lessonPlan.goals.length > 0
      ? lessonPlan.goals.map((goal) => ({ ...goal, rule: { ...goal.rule } }))
      : [
          {
            id: fallbackGoalId,
            title: lessonPlan.title,
            description: '等待课堂检查点或教师复核证据。',
            rule: {
              version: 'livecourse-quiz-mastery-v1',
              passScore: 0.7,
              minAcceptedEvidence: 1,
              minPassingEvidence: 1,
            },
          },
        ];
  const goalIds = new Set(goals.map((goal) => goal.id));

  const nodes = orderedNodes.map((node) => ({
    ...node,
    goalIds:
      node.goalIds.length > 0
        ? [...node.goalIds]
        : lessonPlan.goals.length > 0
          ? []
          : [fallbackGoalId],
    ...(node.design ? { design: { ...node.design } } : {}),
  }));
  const checkpointRules = nodes
    .filter((node) => node.type === 'checkpoint' && node.goalIds.some((id) => goalIds.has(id)))
    .map((node) => ({
      id: `checkpoint:${node.id}`,
      nodeId: node.id,
      goalIds: node.goalIds.filter((id) => goalIds.has(id)),
      required: true,
    }));
  const now = input.now ?? lessonPlan.createdAt;

  return coursePlanSchema.parse({
    schemaVersion: COURSE_PLAN_SCHEMA_VERSION,
    id: `course-plan:${courseId}`,
    courseId,
    title: lessonPlan.title,
    version: lessonPlan.version,
    status: lessonPlan.status,
    createdAt: lessonPlan.createdAt,
    updatedAt: now,
    goals,
    lessons: [
      {
        id: initialLessonId,
        stageId,
        title: lessonPlan.title,
        order: 0,
        dependsOn: [],
        nodes,
      },
    ],
    checkpointRules,
  });
}

/**
 * Typed, schema-valid course plan deltas. A course-level adjustment may only
 * change a plan through one of these shapes — never through arbitrary JSON
 * patches. Every field references existing plan entities so the resulting
 * plan stays valid after re-validation.
 */
export const coursePlanRevisionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('add_checkpoint'),
      checkpoint: checkpointRuleSchema,
    })
    .strict(),
]);

export type CoursePlanRevision = z.infer<typeof coursePlanRevisionSchema>;

export const teachingAdjustmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifierSchema,
    courseId: identifierSchema,
    coursePlanVersion: z.number().int().positive(),
    targetLessonIds: z.array(identifierSchema).min(1),
    targetNodeIds: z.array(identifierSchema),
    basis: z
      .object({
        evidenceIds: z.array(identifierSchema).min(1),
        goalStateIds: z.array(identifierSchema),
        rationale: z.string().trim().min(1).max(4000),
      })
      .strict(),
    recommendation: z
      .object({
        kind: z.enum(['remediate', 'advance', 'reorder', 'add_checkpoint', 'change_pacing']),
        summary: z.string().trim().min(1).max(2000),
        revision: coursePlanRevisionSchema.optional(),
      })
      .strict(),
    approvalStatus: z.enum(['pending', 'approved', 'rejected']),
    idempotencyKey: identifierSchema,
    createdAt: timestampSchema,
    decidedAt: timestampSchema.optional(),
    decidedBy: identifierSchema.optional(),
  })
  .strict()
  .superRefine((adjustment, context) => {
    if (adjustment.approvalStatus === 'pending') {
      if (adjustment.decidedAt !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Pending adjustments cannot have decidedAt',
          path: ['decidedAt'],
        });
      }
      if (adjustment.decidedBy !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Pending adjustments cannot have decidedBy',
          path: ['decidedBy'],
        });
      }
      return;
    }
    if (adjustment.decidedAt === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Approved or rejected adjustments require decidedAt',
        path: ['decidedAt'],
      });
    }
    if (adjustment.decidedBy === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Approved or rejected adjustments require decidedBy',
        path: ['decidedBy'],
      });
    }
  });

export type TeachingAdjustment = z.infer<typeof teachingAdjustmentSchema>;

/** Parse and validate the one canonical course-plan contract. */
export function parseCoursePlan(value: unknown): CoursePlan {
  return coursePlanSchema.parse(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

/**
 * Deterministically project every executable lesson in a course plan. The
 * returned array is deeply immutable and follows the stable order/id ordering
 * used by the contract rather than input array order.
 */
export function projectCoursePlan(coursePlan: CoursePlan): readonly LessonPlan[] {
  const plan = coursePlanSchema.parse(coursePlan);
  const projected = [...plan.lessons]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((lesson) =>
      deepFreeze(
        lessonPlanSchema.parse({
          schemaVersion: 1,
          id: `lesson-plan:${plan.id}:${lesson.id}`,
          courseId: plan.courseId,
          stageId: lesson.stageId,
          title: lesson.title,
          version: plan.version,
          status: plan.status,
          createdAt: plan.createdAt,
          goals: plan.goals,
          nodes: [...lesson.nodes].sort(
            (left, right) => left.order - right.order || left.id.localeCompare(right.id),
          ),
        }),
      ),
    );
  return Object.freeze(projected);
}

// A descriptive alias makes the projection boundary discoverable to callers
// that name the operation after its source aggregate.
export const projectCoursePlanToLessonPlans = projectCoursePlan;
export const deriveLessonPlansFromCoursePlan = projectCoursePlan;
export const coursePlanToLessonPlans = projectCoursePlan;
