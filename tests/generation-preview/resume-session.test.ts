import { describe, expect, it } from 'vitest';

import {
  SHOWCASE_CLASSROOM_ID,
  buildGenerationResumeSession,
  isFourierShowcaseSession,
  isGenerationPending,
  outlinesFromClassroomScenes,
  parseGenerationSession,
  shouldKeepLiveGenerationSession,
  shouldOpenGenerationPreview,
} from '@/app/generation-preview/resume-session';
import { allSegmentsCompleted, deriveSegmentProgress } from '@/app/generation-preview/segment-status';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { SceneOutline } from '@/lib/types/generation';

function outline(id: string, order: number): SceneOutline {
  return {
    id,
    type: 'slide',
    title: id,
    description: id,
    keyPoints: [],
    order,
  };
}

describe('outlinesFromClassroomScenes', () => {
  it('projects classroom scenes so preview segments can complete', () => {
    const outlines = outlinesFromClassroomScenes([
      {
        id: 'scene-a',
        outlineId: 'why',
        title: '为什么需要傅里叶变换',
        type: 'interactive',
        order: 0,
      } as never,
      {
        id: 'scene-b',
        title: '测验',
        type: 'quiz',
        order: 1,
      } as never,
    ]);
    expect(outlines).toEqual([
      expect.objectContaining({ id: 'why', type: 'interactive', order: 0 }),
      expect.objectContaining({ id: 'scene-b', type: 'quiz', order: 1 }),
    ]);
    const segments = deriveSegmentProgress({
      outlines,
      scenes: [
        { id: 'scene-a', outlineId: 'why', title: '为什么需要傅里叶变换', type: 'interactive', order: 0 },
        { id: 'scene-b', title: '测验', type: 'quiz', order: 1 },
      ] as never,
      failedOutlines: [],
      generatingOutlines: [],
    });
    expect(allSegmentsCompleted(segments)).toBe(true);
  });
});

describe('isFourierShowcaseSession', () => {
  it('matches the server Fourier showcase by title or requirement', () => {
    expect(SHOWCASE_CLASSROOM_ID).toBe('fourier-intro');
    expect(isFourierShowcaseSession({ courseTitle: '傅里叶变换直观入门' })).toBe(true);
    expect(isFourierShowcaseSession({ requirement: 'Fourier Transform intro' })).toBe(true);
    expect(isFourierShowcaseSession({ name: 'Python 入门' })).toBe(false);
  });
});

describe('isGenerationPending', () => {
  it('treats only an explicit incomplete deck as pending', () => {
    expect(isGenerationPending({ generationComplete: false })).toBe(true);
    expect(isGenerationPending({ generationComplete: true })).toBe(false);
    expect(isGenerationPending({})).toBe(false);
    expect(isGenerationPending(null)).toBe(false);
  });
});

describe('shouldKeepLiveGenerationSession', () => {
  it('keeps the envelope only for the same classroom that is still generating', () => {
    expect(
      shouldKeepLiveGenerationSession({
        classroomId: 'stage-abc',
        liveSession: { stageId: 'stage-abc', currentStep: 'generating' },
      }),
    ).toBe(true);
    expect(
      shouldKeepLiveGenerationSession({
        classroomId: 'stage-abc',
        liveSession: { stageId: 'stage-abc', currentStep: 'complete' },
      }),
    ).toBe(false);
    expect(
      shouldKeepLiveGenerationSession({
        classroomId: 'stage-other',
        liveSession: { stageId: 'stage-abc', currentStep: 'generating' },
      }),
    ).toBe(false);
    expect(shouldKeepLiveGenerationSession({ classroomId: 'stage-abc', liveSession: null })).toBe(
      false,
    );
  });
});

describe('shouldOpenGenerationPreview', () => {
  it('opens preview for the live generating session even before the deck is saved', () => {
    expect(
      shouldOpenGenerationPreview({
        classroomId: 'stage-abc',
        liveSession: { stageId: 'stage-abc', currentStep: 'generating' },
        outline: null,
      }),
    ).toBe(true);
  });

  it('opens preview for a persisted incomplete deck without a live session', () => {
    expect(
      shouldOpenGenerationPreview({
        classroomId: 'stage-abc',
        liveSession: null,
        outline: { generationComplete: false },
      }),
    ).toBe(true);
  });

  it('opens preview when the live session finished but the persisted deck is still incomplete', () => {
    expect(
      shouldOpenGenerationPreview({
        classroomId: 'stage-abc',
        liveSession: { stageId: 'stage-abc', currentStep: 'complete' },
        outline: { generationComplete: false },
      }),
    ).toBe(true);
  });

  it('opens preview for a live generating session even if an older outline snapshot looks complete', () => {
    expect(
      shouldOpenGenerationPreview({
        classroomId: 'stage-abc',
        liveSession: { stageId: 'stage-abc', currentStep: 'generating' },
        outline: { generationComplete: true },
      }),
    ).toBe(true);
  });

  it('does not intercept a completed deck or a finished live session', () => {
    expect(
      shouldOpenGenerationPreview({
        classroomId: 'stage-abc',
        liveSession: { stageId: 'stage-abc', currentStep: 'complete' },
        outline: { generationComplete: true },
      }),
    ).toBe(false);
    expect(
      shouldOpenGenerationPreview({
        classroomId: 'stage-other',
        liveSession: { stageId: 'stage-abc', currentStep: 'generating' },
        outline: { generationComplete: true },
      }),
    ).toBe(false);
    expect(
      shouldOpenGenerationPreview({
        classroomId: 'stage-abc',
        liveSession: null,
        outline: { generationComplete: true },
      }),
    ).toBe(false);
    expect(
      shouldOpenGenerationPreview({
        classroomId: 'stage-abc',
        liveSession: null,
        outline: {},
      }),
    ).toBe(false);
  });
});

describe('buildGenerationResumeSession', () => {
  it('reuses the stage seed and keeps outlines for J2.1 resume', () => {
    const session = buildGenerationResumeSession({
      stageId: 'stage-seed',
      courseId: 'course-seed',
      lessonId: 'lesson-seed',
      requirement: '链式法则',
      outlines: [outline('intro', 0)],
      courseTitle: '链式法则',
    });

    expect(session.sessionId).toBe('seed');
    expect(session.stageId).toBe('stage-seed');
    expect(session.courseId).toBe('course-seed');
    expect(session.previewPhase).toBe('generating-content');
    expect(session.currentStep).toBe('generating');
    expect(session.confirmationDone).toBe(true);
    expect(session.sceneOutlines).toHaveLength(1);
    expect(session.requirements.requirement).toBe('链式法则');
  });

  it('carries the persisted lesson plan and skips J2.0 confirmation on resume', () => {
    const lessonPlan = { id: 'lesson-plan:course-seed', title: '链式法则' } as LessonPlan;
    const session = buildGenerationResumeSession({
      stageId: 'seed',
      courseId: 'course-seed',
      lessonId: 'lesson-seed',
      requirement: '链式法则',
      outlines: [outline('intro', 0)],
      lessonPlan,
      languageDirective: 'Teach in Chinese.',
    });

    expect(session.sessionId).toBe('seed');
    expect(session.lessonPlan).toBe(lessonPlan);
    expect(session.confirmationDone).toBe(true);
    expect(session.languageDirective).toBe('Teach in Chinese.');
    expect(session.currentStep).toBe('generating');
  });
});

describe('parseGenerationSession', () => {
  it('rejects unreadable envelopes instead of inventing a session', () => {
    expect(parseGenerationSession(null)).toBeNull();
    expect(parseGenerationSession('{')).toBeNull();
    expect(parseGenerationSession(JSON.stringify({ requirements: {} }))).toBeNull();
  });

  it('round-trips a resume envelope and fills durable generation identity', () => {
    const built = buildGenerationResumeSession({
      stageId: 'stage-seed',
      courseId: 'course-seed',
      lessonId: 'lesson-seed',
      requirement: '链式法则',
      outlines: [outline('intro', 0)],
    });
    const parsed = parseGenerationSession(JSON.stringify(built));

    expect(parsed).toMatchObject({
      sessionId: 'seed',
      courseId: 'course-seed',
      stageId: 'stage-seed',
      lessonId: 'lesson-seed',
      currentStep: 'generating',
      confirmationDone: true,
    });
  });
});
