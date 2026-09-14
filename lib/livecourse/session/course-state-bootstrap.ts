import {
  deriveCoursePlanFromLessonPlan,
  lessonPlanSchema,
  type LessonPlan,
} from '@/lib/livecourse/domain';
import type { CourseStateSnapshot, CourseStateSnapshotInput } from './course-state-snapshot';
import type { CourseStateRepository } from './course-state-repository';

/**
 * Inputs needed to create the first durable course snapshot. The caller owns
 * the stable course identity and the generated lesson plan; this module only
 * assembles the empty, schema-valid C envelope.
 */
export interface InitialCourseStateInput {
  courseId: string;
  stageId: string;
  learnerId: string;
  lessonPlan: LessonPlan;
  lessonId?: string;
  /** Stable generation timestamp. Defaults to the lesson plan timestamp. */
  now?: string;
  /** Optional override for tests or a persisted generation command. */
  idempotencyKey?: string;
}

/**
 * Typed failure for the generation → C hand-off.  A plan is an application
 * payload, so the hand-off must verify both its schema and the identity that
 * the caller resolved from the generation session before deriving a course
 * plan.  Without this seam a stale response could be re-keyed into the
 * current course and silently contaminate its memory partition.
 */
export class CourseStateBootstrapError extends Error {
  override readonly name = 'CourseStateBootstrapError';
}

/**
 * Validate that a lesson plan belongs to the stable generation identity.
 * `requiredSceneIds` is optional for callers that only need the identity
 * check; generation uses it to ensure a persisted plan still covers exactly
 * the outlines it will turn into scenes.
 */
export function assertLessonPlanIdentity(input: {
  lessonPlan: unknown;
  courseId: string;
  stageId: string;
  requiredSceneIds?: readonly string[];
}): LessonPlan {
  const courseId = input.courseId.trim();
  const stageId = input.stageId.trim();
  if (!courseId || !stageId) {
    throw new CourseStateBootstrapError(
      'Lesson plan identity requires non-empty courseId and stageId',
    );
  }

  const parsed = lessonPlanSchema.safeParse(input.lessonPlan);
  if (!parsed.success) {
    throw new CourseStateBootstrapError('Lesson plan failed schema validation');
  }
  if (parsed.data.courseId !== courseId || parsed.data.stageId !== stageId) {
    throw new CourseStateBootstrapError(
      `Lesson plan identity ${JSON.stringify({
        courseId: parsed.data.courseId,
        stageId: parsed.data.stageId,
      })} does not match generation identity ${JSON.stringify({ courseId, stageId })}`,
    );
  }

  if (input.requiredSceneIds !== undefined) {
    const expected = [...input.requiredSceneIds].map((id) => id.trim()).sort();
    const actual = parsed.data.nodes.map((node) => node.sceneId).sort();
    if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
      throw new CourseStateBootstrapError(
        'Lesson plan nodes do not cover the current generation outlines exactly',
      );
    }
  }

  return parsed.data;
}

/**
 * Build the first C payload for a course. The payload intentionally contains
 * no teaching actions, evidence, adjustments or assistant tasks: those are
 * added only through their authoritative runtime boundaries after classroom
 * entry. `createdAt` and the initialization key are stable so a retried
 * generation command can safely call `initialize` again.
 */
export function buildInitialCourseStateInput(
  input: InitialCourseStateInput,
): CourseStateSnapshotInput {
  const lessonId = input.lessonId ?? input.courseId;
  const createdAt = input.now ?? input.lessonPlan.createdAt;
  const lessonPlan = assertLessonPlanIdentity({
    lessonPlan: input.lessonPlan,
    courseId: input.courseId,
    stageId: input.stageId,
  });
  const coursePlan = deriveCoursePlanFromLessonPlan({
    lessonPlan,
    courseId: input.courseId,
    stageId: input.stageId,
    lessonId,
    now: createdAt,
  });

  return {
    idempotencyKey: input.idempotencyKey ?? `course:init:${input.courseId}`,
    stageId: input.stageId,
    learnerId: input.learnerId,
    courseId: input.courseId,
    lessonId,
    createdAt,
    coursePlan,
    teachingActions: {
      actions: [],
      currentNodeId: null,
      lastSequence: -1,
    },
    assistantTasks: {
      schemaVersion: 1,
      tasks: [],
      events: [],
    },
    evidence: [],
    adjustments: [],
  };
}

/** Initialize C through the repository's guarded first-write boundary. */
export async function initializeCourseState(
  input: {
    repository: Pick<CourseStateRepository, 'initialize'>;
  } & InitialCourseStateInput,
): Promise<CourseStateSnapshot> {
  const { repository, ...bootstrap } = input;
  return repository.initialize(buildInitialCourseStateInput(bootstrap));
}
