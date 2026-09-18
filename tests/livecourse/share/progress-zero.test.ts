import { describe, expect, it } from 'vitest';
import { buildInitialCourseStateInput } from '@/lib/livecourse/session/course-state-bootstrap';
import { rewriteShareMaterials } from '@/lib/livecourse/share/rewrite';
import { buildShareSnapshot } from '@/lib/livecourse/share/build-snapshot';
import { htmlLessonPlan, htmlScene, htmlStage } from './fixtures';

describe('shared course progress', () => {
  it('initializes an empty C envelope without intake', async () => {
    const { snapshot } = await buildShareSnapshot({
      token: 'sharetoken11111111',
      stage: htmlStage(),
      scenes: [htmlScene('<p>plain</p>')],
      lessonPlan: htmlLessonPlan(),
    });
    const rewritten = rewriteShareMaterials({
      snapshot,
      newSeed: 'fresh-seed',
      token: snapshot.token,
      origin: 'https://host.test',
    });
    const envelope = buildInitialCourseStateInput({
      courseId: rewritten.identity.courseId,
      stageId: rewritten.identity.stageId,
      lessonId: rewritten.identity.lessonId,
      learnerId: 'anon:recipient',
      lessonPlan: rewritten.lessonPlan,
    });
    expect(envelope.progress).toBeUndefined();
    expect(envelope.playbackPosition).toBeUndefined();
    expect(envelope.evidence).toEqual([]);
    expect(envelope.teachingActions.actions).toEqual([]);
    expect(envelope).not.toHaveProperty('intake');
  });
});
