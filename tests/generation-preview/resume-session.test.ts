import { describe, expect, it } from 'vitest';

import {
  buildGenerationResumeSession,
  isGenerationPending,
  parseGenerationSession,
  shouldKeepLiveGenerationSession,
  shouldOpenGenerationPreview,
} from '@/app/generation-preview/resume-session';
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
