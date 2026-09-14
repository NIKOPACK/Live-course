import type { SceneOutline } from '@/lib/types/generation';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import { buildLessonPlanSkeleton } from '@/lib/livecourse/lesson/skeleton';
import { assertLessonPlanIdentity } from '@/lib/livecourse/session/course-state-bootstrap';
import type { GenerationSessionState } from './types';

export type LessonPlanSource = 'persisted' | 'generated' | 'skeleton';

/**
 * Resolve a plan at the generation boundary. Persisted plans are authoritative:
 * if one is present but no longer belongs to this session or no longer covers
 * the outlines, fail loudly so a stale plan cannot contaminate C or the stage
 * document. API output is untrusted and may degrade to a truthful skeleton.
 */
export function resolveGenerationLessonPlan(input: {
  session: GenerationSessionState;
  outlines: SceneOutline[];
  courseId: string;
  stageId: string;
  requirement: string;
  courseTitle?: string;
  now?: string;
  apiCandidate?: unknown;
  requireHtmlPresentation?: boolean;
}): { plan: LessonPlan; source: LessonPlanSource } {
  const requiredSceneIds = input.outlines.map((outline) => outline.id);

  if (input.session.lessonPlan !== undefined && input.session.lessonPlan !== null) {
    return {
      plan: assertLessonPlanIdentity({
        lessonPlan: input.session.lessonPlan,
        courseId: input.courseId,
        stageId: input.stageId,
        requiredSceneIds,
      }),
      source: 'persisted',
    };
  }

  if (input.apiCandidate !== undefined && input.apiCandidate !== null) {
    try {
      const plan = assertLessonPlanIdentity({
        lessonPlan: input.apiCandidate,
        courseId: input.courseId,
        stageId: input.stageId,
        requiredSceneIds,
      });
      if (input.requireHtmlPresentation && !plan.presentation) {
        throw new Error('The main agent has not supplied a classroom visual direction');
      }
      return {
        plan,
        source: 'generated',
      };
    } catch (error) {
      if (input.requireHtmlPresentation) throw error;
      // A model response is replaceable; retaining the real outline set is
      // safer than dropping the plan or re-keying an invalid response.
    }
  }

  if (input.requireHtmlPresentation) {
    throw new Error('The main agent has not supplied a classroom visual direction');
  }

  return {
    plan: buildLessonPlanSkeleton({
      stageId: input.stageId,
      courseId: input.courseId,
      requirement: input.requirement,
      courseTitle: input.courseTitle,
      outlines: input.outlines,
      now: input.now,
    }),
    source: 'skeleton',
  };
}
