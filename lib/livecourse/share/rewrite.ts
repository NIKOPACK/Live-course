import { deriveCoursePlanFromLessonPlan } from '@/lib/livecourse/domain/course-plan';
import { lessonPlanSchema, type LessonPlan } from '@/lib/livecourse/domain/schemas';
import { createGenerationIdentity } from '@/lib/livecourse/session/generation-identity';
import type { Scene, Stage } from '@/lib/types/stage';
import { replaceShareMediaPlaceholders } from './media';
import type { CourseShareSnapshot } from './schema';
import { stripShareMaterials } from './strip';

export class ShareRewriteError extends Error {
  override readonly name = 'ShareRewriteError';
}

export function rewriteShareMaterials(input: {
  snapshot: CourseShareSnapshot;
  newSeed: string;
  token: string;
  origin: string;
}): {
  identity: ReturnType<typeof createGenerationIdentity>;
  stage: Stage;
  scenes: Scene[];
  lessonPlan: LessonPlan;
  coursePlan: ReturnType<typeof deriveCoursePlanFromLessonPlan>;
} {
  if (!input.newSeed.trim() || input.newSeed === input.token || input.token.includes(input.newSeed)) {
    throw new ShareRewriteError('Redeem seed must not be the share token');
  }
  const identity = createGenerationIdentity(input.newSeed);
  const stage = stripShareMaterials(structuredClone(input.snapshot.stage)) as Stage;
  const scenes = stripShareMaterials(structuredClone(input.snapshot.scenes)) as Scene[];
  const bound = replaceShareMediaPlaceholders(stage, scenes, identity.stageId, input.origin);
  bound.stage.id = identity.stageId;
  for (const scene of bound.scenes) {
    scene.stageId = identity.stageId;
  }

  const parsedPlan = lessonPlanSchema.safeParse(stripShareMaterials(input.snapshot.lessonPlan));
  if (!parsedPlan.success) {
    throw new ShareRewriteError('Share snapshot lesson plan is invalid');
  }
  const lessonPlan: LessonPlan = {
    ...parsedPlan.data,
    id: identity.lessonId,
    courseId: identity.courseId,
    stageId: identity.stageId,
  };
  const coursePlan = deriveCoursePlanFromLessonPlan({
    lessonPlan,
    courseId: identity.courseId,
    stageId: identity.stageId,
    lessonId: identity.lessonId,
  });

  return {
    identity,
    stage: bound.stage,
    scenes: bound.scenes,
    lessonPlan,
    coursePlan,
  };
}
