import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { Scene } from '@/lib/types/stage';

/** Stable classroom-load error token. The classroom page maps it to i18n. */
export const LEGACY_CLASSROOM_ERROR = 'legacy-classroom-unsupported';

/** Opening or playing a pre-HTML classroom is not supported. */
export class LegacyClassroomError extends Error {
  override readonly name = 'LegacyClassroomError';

  constructor() {
    super(LEGACY_CLASSROOM_ERROR);
  }
}

/** Scene generation without an HTML visual direction is not supported. */
export class ClassroomHtmlRequiredError extends Error {
  readonly isRetryable = false;
  override readonly name = 'ClassroomHtmlRequiredError';

  constructor(message = 'HTML classroom visual direction is required') {
    super(message);
  }
}

export function isHtmlLessonPlan(
  lessonPlan: LessonPlan | null | undefined,
): lessonPlan is LessonPlan & { presentation: { mode: 'html'; visualStyle: string } } {
  return lessonPlan?.presentation?.mode === 'html';
}

/**
 * HTML is the only classroom format. Slide, widget and PBL documents cannot
 * be opened or taught (docs/spec/03-product-design.md, 04 §7 A5.1).
 */
export function assertHtmlClassroom(input: {
  lessonPlan: LessonPlan | null | undefined;
  scenes: readonly Scene[];
}): void {
  if (!isHtmlLessonPlan(input.lessonPlan)) {
    throw new LegacyClassroomError();
  }
  for (const scene of input.scenes) {
    if (scene.type === 'quiz') {
      if (scene.content.type !== 'quiz' || !scene.content.html?.trim()) {
        throw new LegacyClassroomError();
      }
      continue;
    }
    if (scene.type === 'interactive') {
      if (scene.content.type !== 'interactive' || !scene.content.html?.trim()) {
        throw new LegacyClassroomError();
      }
      continue;
    }
    throw new LegacyClassroomError();
  }
}
