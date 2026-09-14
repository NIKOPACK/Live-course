import { coursePlanSchema, type CoursePlan } from '@/lib/livecourse/domain/course-plan';

/** The explicit identities needed to open one classroom lesson. */
export interface CourseIdentity {
  courseId: string;
  lessonId: string;
}

export class CourseIdentityError extends Error {
  override readonly name = 'CourseIdentityError';
}

function requireStageId(value: string): string {
  const stageId = value.trim();
  if (!stageId) throw new CourseIdentityError('A classroom route requires a non-empty stageId');
  return stageId;
}

/**
 * Resolve the durable course / lesson identity for a classroom route.
 *
 * Legacy documents have no course-plan row, so their stage id remains the
 * identity for both course and lesson.  A versioned plan is authoritative
 * when present: it must parse successfully and contain at least one lesson
 * whose `stageId` is the requested route.  Multi-lesson plans are supported
 * for older persisted data, but a route stage must resolve to exactly one
 * lesson.  No `stageId -> courseId` fallback is used once a plan is present but
 * malformed or unrelated to the route.
 */
export function resolveCourseIdentity(input: {
  stageId: string;
  coursePlan?: unknown | null;
}): CourseIdentity {
  const stageId = requireStageId(input.stageId);
  if (input.coursePlan == null) {
    return { courseId: stageId, lessonId: stageId };
  }

  const parsed = coursePlanSchema.safeParse(input.coursePlan);
  if (!parsed.success) {
    throw new CourseIdentityError(
      `Course plan for classroom ${JSON.stringify(stageId)} is invalid`,
    );
  }

  const matchingLessons = parsed.data.lessons.filter((lesson) => lesson.stageId === stageId);
  if (matchingLessons.length === 0) {
    throw new CourseIdentityError(
      `Course plan ${JSON.stringify(parsed.data.courseId)} has no lesson for classroom ${JSON.stringify(stageId)}`,
    );
  }
  if (matchingLessons.length > 1) {
    throw new CourseIdentityError(
      `Course plan ${JSON.stringify(parsed.data.courseId)} has multiple lessons for classroom ${JSON.stringify(stageId)}`,
    );
  }
  const lesson = matchingLessons[0]!;

  return { courseId: parsed.data.courseId, lessonId: lesson.id };
}

/** Narrowing helper for callers that already hold a parsed plan. */
export function resolveCourseIdentityFromPlan(
  stageId: string,
  coursePlan: CoursePlan,
): CourseIdentity {
  return resolveCourseIdentity({ stageId, coursePlan });
}
