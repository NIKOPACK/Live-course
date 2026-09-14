import { describe, expect, it, vi } from 'vitest';

import { lessonPlanSchema, projectGoalState } from '@/lib/livecourse/domain';
import {
  checkpointFeedbackText,
  createCheckpointSubmissionCoordinator,
  isCompletedCheckpointEvidence,
  nextTeachingNode,
} from '@/lib/livecourse/session/teaching-flow';
import type { Scene } from '@/lib/types/stage';
import { makeEvidenceRecord } from './evidence-fixture';

const plan = lessonPlanSchema.parse({
  schemaVersion: 1,
  id: 'plan',
  courseId: 'course:algebra',
  stageId: 'stage-1',
  title: 'Lesson',
  version: 1,
  status: 'approved',
  createdAt: '2026-09-14T00:00:00.000Z',
  goals: [],
  nodes: [
    {
      id: 'last',
      sceneId: 'scene-last',
      title: 'Last',
      order: 2,
      type: 'instruction',
      goalIds: [],
    },
    {
      id: 'first',
      sceneId: 'scene-first',
      title: 'First',
      order: 0,
      type: 'instruction',
      goalIds: [],
    },
    { id: 'quiz', sceneId: 'scene-quiz', title: 'Quiz', order: 1, type: 'checkpoint', goalIds: [] },
  ],
});
const quiz: Scene = {
  id: 'scene-quiz',
  stageId: 'stage-1',
  order: 1,
  title: 'Quiz',
  type: 'quiz',
  content: {
    type: 'quiz',
    questions: [
      {
        id: 'q1',
        type: 'single',
        question: 'What is one plus one?',
        answer: ['B'],
        options: [{ value: 'B', label: 'Two' }],
        analysis: 'Adding one to one gives two.',
      },
      { id: 'q2', type: 'short_answer', question: 'Explain the operation.' },
    ],
  },
};

describe('classroom teaching flow', () => {
  it('continues in lesson order and stops at the last node, including checks', () => {
    expect(nextTeachingNode(plan, 'first')?.id).toBe('quiz');
    expect(nextTeachingNode(plan, 'quiz')?.id).toBe('last');
    expect(nextTeachingNode(plan, 'last')).toBeNull();
    expect(() => nextTeachingNode(plan, 'missing')).toThrow('Unknown');
  });

  it('uses the submitted errors for corrective feedback instead of inventing mastery', () => {
    const text = checkpointFeedbackText({
      result: {
        nodeId: 'quiz',
        sceneId: quiz.id,
        attemptId: 'attempt-1',
        score: 0.2,
        hasModelGradedItems: true,
        metadata: {
          results: [
            { questionId: 'q1', correct: false },
            {
              questionId: 'q2',
              correct: false,
              aiComment: 'Explain which quantities are being added.',
            },
          ],
        },
      },
      scene: quiz,
      language: 'en-US',
      passScore: 0.7,
    });
    expect(text).toContain('provisional');
    expect(text).toContain('20 percent');
    expect(text).toContain('Adding one to one gives two.');
    expect(text).toContain('Explain which quantities are being added.');
    expect(text).not.toContain('mastered');
  });

  it('rejects a feedback request for another scene', () => {
    expect(() =>
      checkpointFeedbackText({
        result: { nodeId: 'quiz', sceneId: 'other', attemptId: 'a1', score: 1 },
        scene: quiz,
        language: 'en-US',
        passScore: 0.7,
      }),
    ).toThrow('submitted quiz scene');
  });

  it('coalesces concurrent and completed attempts, but allows failure recovery', async () => {
    const submit = createCheckpointSubmissionCoordinator<string>();
    const fail = vi.fn(async () => {
      throw new Error('voice unavailable');
    });
    await expect(submit('attempt-1', fail)).rejects.toThrow('voice unavailable');
    const write = vi.fn(async () => 'evidence-1');
    const first = submit('attempt-1', write);
    const retry = submit('attempt-1', write);
    expect(first).toBe(retry);
    await expect(first).resolves.toBe('evidence-1');
    await expect(submit('attempt-1', write)).resolves.toBe('evidence-1');
    expect(write).toHaveBeenCalledOnce();
  });

  it('does not record or advance a checkpoint until feedback has succeeded', async () => {
    const submit = createCheckpointSubmissionCoordinator<void>();
    const events: string[] = [];
    const feedback = vi.fn<() => Promise<void>>(async () => {
      throw new Error('audio failed');
    });
    const run = () =>
      submit('attempt-1', async () => {
        await feedback();
        events.push('evidence', 'advance');
      });
    await expect(run()).rejects.toThrow('audio failed');
    expect(events).toEqual([]);
    feedback.mockImplementation(async () => {
      events.push('feedback');
    });
    await Promise.all([run(), run()]);
    expect(events).toEqual(['feedback', 'evidence', 'advance']);
  });

  it('finishes a model-assessed check without upgrading its mastery provenance', () => {
    const record = makeEvidenceRecord({
      status: 'pending_review',
      kind: 'rubric_score',
      evaluation: {
        method: 'model',
        modelId: 'quiz-grader',
        rubricVersion: 'v1',
        inputSummary: 'Submitted answer',
        confidence: 0,
        reviewStatus: 'pending',
      },
    });
    expect(isCompletedCheckpointEvidence(record)).toBe(true);
    expect(record.status).toBe('pending_review');
    const state = projectGoalState({
      courseId: record.courseId,
      learnerId: record.learnerId,
      goalId: record.goalId,
      rule: { version: 'v1', passScore: 0.7, minAcceptedEvidence: 1, minPassingEvidence: 1 },
      evidence: [record],
    });
    expect(state.acceptedEvidenceCount).toBe(0);
    expect(state.status).not.toBe('met');
    expect(isCompletedCheckpointEvidence(makeEvidenceRecord({ status: 'rejected' }))).toBe(false);
  });
});
