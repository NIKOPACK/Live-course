import { outlinesFromClassroomScenes } from '@/lib/livecourse/lesson/outlines-from-scenes';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { SceneOutline } from '@/lib/types/generation';
import { withGenerationIdentity, type GenerationSessionState } from './types';

export type { GenerationSessionState };
export { outlinesFromClassroomScenes };

/** Server-persisted showcase classroom used when live generation of this topic stalls. */
export const SHOWCASE_CLASSROOM_ID = 'fourier-intro';

export function isFourierShowcaseSession(input: {
  courseTitle?: string;
  requirement?: string;
  name?: string;
}): boolean {
  const haystack = [input.courseTitle, input.requirement, input.name]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
  return /傅里叶|Fourier/i.test(haystack);
}

/** True when the persisted deck is still being prepared (docs/spec/01 J2.1 / J4.4). */
export function isGenerationPending(outline?: { generationComplete?: boolean } | null): boolean {
  return outline?.generationComplete === false;
}

/**
 * Keep the in-browser generation envelope when the same classroom is still
 * preparing. Homepage must not rebuild it from the stage document (that would
 * drop confirmation answers) and must not open the J4.4 chooser.
 */
export function shouldKeepLiveGenerationSession(input: {
  classroomId: string;
  liveSession?: Pick<GenerationSessionState, 'stageId' | 'currentStep'> | null;
}): boolean {
  return (
    input.liveSession?.stageId === input.classroomId && input.liveSession.currentStep !== 'complete'
  );
}

/**
 * Homepage card click: unfinished generation returns to the preview instead of
 * the J4.4 continue/replay chooser.
 */
export function shouldOpenGenerationPreview(input: {
  classroomId: string;
  liveSession?: Pick<GenerationSessionState, 'stageId' | 'currentStep'> | null;
  outline?: { generationComplete?: boolean } | null;
}): boolean {
  if (shouldKeepLiveGenerationSession(input)) return true;
  return isGenerationPending(input.outline);
}

export function parseGenerationSession(raw: string | null): GenerationSessionState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GenerationSessionState;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sessionId !== 'string') {
      return null;
    }
    return withGenerationIdentity(parsed);
  } catch {
    return null;
  }
}

/** Rebuild the resumable preview envelope from a persisted incomplete deck. */
export function buildGenerationResumeSession(input: {
  stageId: string;
  courseId: string;
  lessonId: string;
  requirement: string;
  outlines: SceneOutline[];
  lessonPlan?: LessonPlan | null;
  courseTitle?: string;
  languageDirective?: string;
}): GenerationSessionState {
  const sessionId = input.stageId.startsWith('stage-')
    ? input.stageId.slice('stage-'.length)
    : input.stageId;
  return withGenerationIdentity({
    sessionId,
    courseId: input.courseId,
    stageId: input.stageId,
    lessonId: input.lessonId,
    requirements: { requirement: input.requirement },
    pdfText: '',
    sceneOutlines: input.outlines,
    currentStep: 'generating',
    previewPhase: 'generating-content',
    confirmationDone: true,
    lessonPlan: input.lessonPlan ?? null,
    ...(input.courseTitle ? { courseTitle: input.courseTitle } : {}),
    ...(input.languageDirective ? { languageDirective: input.languageDirective } : {}),
  });
}
