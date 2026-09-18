import { describe, expect, it, vi } from 'vitest';
import {
  ClassroomQualityError,
  reviewLessonPlan,
  reviewTeaching,
  reviewUntilValid,
} from '@/lib/livecourse/lesson/quality-review';
import { buildLessonPlanSkeleton } from '@/lib/livecourse/lesson/skeleton';
import { withGenerationRetry } from '@/lib/generation/generation-retry';
import type { SceneOutline } from '@/lib/types/generation';

const pass = { checks: ['sin(2*pi*t) has period 1 and amplitude 1.'], issues: [] };
const rechecked = {
  checks: pass.checks,
  resolutions: [{ issueIndex: 0, fixed: true, evidence: 'The reported quantity is now correct.' }],
  regressions: [],
};
const error = {
  severity: 'blocking' as const,
  confidence: 'high' as const,
  target: 'node' as const,
  sceneId: 'first',
  evidence: 'The design says the amplitude is 0.707.',
  correction: 'The amplitude is 1; the L2 norm on [0,1] is 1/sqrt(2).',
};
const outlines: SceneOutline[] = [
  {
    id: 'first',
    title: 'Amplitude and norm',
    type: 'slide',
    order: 0,
    description: 'Distinguish the quantities.',
    keyPoints: ['Amplitude', 'Norm'],
  },
  {
    id: 'second',
    title: 'Projection',
    type: 'slide',
    order: 1,
    description: 'Explain projection.',
    keyPoints: ['Projection coefficient'],
  },
];
const input = { stageId: 'quality', requirement: 'Teach both topics fully.', outlines };
const correctDesign = {
  teachingPoints: ['Amplitude is 1.', 'Norm squared on [0,1] is 1/2.'],
  explanationPlan: 'Derive both quantities before comparing them.',
  examples: ['Evaluate the integral with explicit endpoints.'],
};
const makePlan = () => {
  const skeleton = buildLessonPlanSkeleton(input);
  return {
    ...skeleton,
    teachingBrief: { throughline: 'Distinguish function values from integrated quantities.' },
    nodes: skeleton.nodes.map((node) => ({
      ...node,
      design: { ...correctDesign, teachingPoints: ['An incorrect amplitude.'] },
    })),
  };
};

describe('independent quality reports', () => {
  it('requires concrete checks and preserves legitimate empty issues', async () => {
    expect(await reviewTeaching(async () => JSON.stringify(pass), '', {}, ['node'])).toEqual(pass);
  });

  it('provides the actual host protocols during focused rechecks too', async () => {
    const call = vi.fn().mockResolvedValue(JSON.stringify(rechecked));
    await reviewTeaching(call, '', {}, ['html', 'actions', 'questions'], undefined, [
      { ...error, target: 'html' },
    ]);
    expect(call.mock.calls[0][0]).toContain('does NOT call window.__reveal');
    expect(call.mock.calls[0][0]).toContain('result.answer is the CORRECT ANSWER KEY');
    expect(call.mock.calls[0][0]).toContain('ONLY on');
  });
  it('accepts checks followed by a complete report without another model call', async () => {
    const call = vi
      .fn()
      .mockResolvedValue(
        `${JSON.stringify({ checks: ['Independently computed the outputs.'] })}\n${JSON.stringify(pass)}`,
      );
    expect(await reviewTeaching(call, '', {}, ['node'])).toEqual({
      checks: ['Independently computed the outputs.', ...pass.checks],
      issues: [],
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'never discards blocking findings in another report fragment (%s)',
    async (first) => {
      const blocked = JSON.stringify({ ...pass, issues: [error] });
      const clear = JSON.stringify(pass);
      const raw = first ? `${blocked}\n${clear}` : `${clear}\n${blocked}`;
      const result = await reviewTeaching(async () => raw, '', {}, ['node'], new Set(['first']));
      expect(result.issues).toEqual([error]);
    },
  );

  it('does not let jsonrepair turn a truncated issues array into a pass', async () => {
    await expect(
      reviewTeaching(async () => '{"checks":["ok"],"issues":[', '', {}, ['html']),
    ).rejects.toBeInstanceOf(ClassroomQualityError);
  });

  it.each([
    '{"checks":["Checked, but no verdict."]}\n{"checks":["Still no verdict."]}',
    '{"checks":["ok"],"issues":[]}\n{"issues":"none"}',
    '{"checks":["ok"],"issues":[]}\n{"verdict":"a serious error"}',
  ])('does not turn missing or malformed multipart verdicts into a pass (%s)', async (raw) => {
    await expect(reviewTeaching(async () => raw, '', {}, ['html'])).rejects.toBeInstanceOf(
      ClassroomQualityError,
    );
  });

  it('ignores harmless report metadata instead of interrupting generation', async () => {
    expect(
      await reviewTeaching(
        async () =>
          JSON.stringify({
            ...pass,
            summary: 'No important issue.',
          }),
        '',
        {},
        ['html'],
      ),
    ).toEqual(pass);
  });

  it('requires a focused resolution for each original issue, without a new open-ended audit', async () => {
    const call = vi.fn().mockResolvedValue(JSON.stringify(rechecked));
    const report = await reviewTeaching(
      call,
      'Inspect the material.',
      { repairFocus: [error] },
      ['node'],
      new Set(['first']),
      [error],
    );
    expect(report.issues).toEqual([]);
    expect(call.mock.calls[0][0]).toContain('single focused recheck');
    expect(call.mock.calls[0][0]).not.toContain('Inspect the material.');
  });

  it.each([
    { resolutions: [] },
    { resolutions: [{ issueIndex: 1, fixed: true, evidence: 'Wrong index.' }] },
    {
      resolutions: [
        { issueIndex: 0, fixed: true, evidence: 'One.' },
        { issueIndex: 0, fixed: true, evidence: 'Duplicate.' },
      ],
    },
  ])('rejects incomplete or duplicated focused resolutions (%j)', async ({ resolutions }) => {
    await expect(
      reviewTeaching(
        async () => JSON.stringify({ ...rechecked, resolutions }),
        '',
        { repairFocus: [error] },
        ['node'],
        new Set(['first']),
        [error],
      ),
    ).rejects.toBeInstanceOf(ClassroomQualityError);
  });

  it('retains the original repair target when its reported error is still present', async () => {
    const report = await reviewTeaching(
      async () =>
        JSON.stringify({
          ...rechecked,
          resolutions: [{ issueIndex: 0, fixed: false, evidence: 'The amplitude is still wrong.' }],
        }),
      '',
      { repairFocus: [error] },
      ['node'],
      new Set(['first']),
      [error],
    );
    expect(report.issues).toEqual([{ ...error, evidence: 'The amplitude is still wrong.' }]);
  });

  it.each([
    '{}',
    '{"pass":true}',
    '{"checks":[],"issues":[]}',
    '{"checks":["ok"],"issues":"none"}',
    '{"checks":["ok"],"issues":[{"target":"html","evidence":"wrong","correction":"fix"}]}',
    JSON.stringify({ ...pass, issues: [{ ...error, sceneId: 'another-course' }] }),
    JSON.stringify({ ...pass, issues: [{ target: 'node', evidence: 'wrong', correction: 'fix' }] }),
  ])('fails closed for malformed or incorrectly targeted reports (%s)', async (raw) => {
    await expect(
      reviewTeaching(async () => raw, '', {}, ['node'], new Set(['first'])),
    ).rejects.toBeInstanceOf(ClassroomQualityError);
  });

  it('checks cancellation after a reviewer returns instead of accepting a late pass', async () => {
    const controller = new AbortController();
    const repair = vi.fn();
    await expect(
      reviewUntilValid('draft', {
        label: 'test',
        signal: controller.signal,
        review: async () => {
          controller.abort();
          return pass;
        },
        repair,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(repair).not.toHaveBeenCalled();
  });

  it('does not multiply exhausted repairs through the general retry wrapper', async () => {
    const review = vi.fn().mockResolvedValue({ ...pass, issues: [error] });
    const repair = vi.fn().mockResolvedValue('still incorrect');
    const sleep = vi.fn();
    await expect(
      withGenerationRetry(() => reviewUntilValid('incorrect', { label: 'test', review, repair }), {
        label: 'outer',
        maxRetries: 5,
        sleep,
      }),
    ).rejects.toMatchObject({ isRetryable: false });
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledWith('incorrect', [error], pass.checks);
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[1][1]).toEqual([error]);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('lesson design review and targeted repair', () => {
  it('re-reviews the corrected design without modifying identity or unaffected nodes', async () => {
    const plan = makePlan();
    const original = structuredClone(plan);
    const reviewCall = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ ...pass, issues: [error] }))
      .mockResolvedValueOnce(JSON.stringify(rechecked));
    const repairCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        nodes: [{ sceneId: 'first', design: correctDesign }],
      }),
    );
    const result = await reviewLessonPlan(plan, input, reviewCall, repairCall);
    expect(result.nodes[0]).toEqual({ ...plan.nodes[0], design: correctDesign });
    expect(result.nodes[1]).toEqual(plan.nodes[1]);
    expect(result.goals).toEqual(plan.goals);
    expect(plan).toEqual(original);
    expect(JSON.parse(reviewCall.mock.calls[1][1]).nodes[0].design).toEqual(correctDesign);
    expect(reviewCall).toHaveBeenCalledTimes(2);
    expect(repairCall).toHaveBeenCalledTimes(1);
  });

  it('can correct the brief alone without replacing node designs', async () => {
    const plan = makePlan();
    const review = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          ...pass,
          issues: [
            {
              severity: 'blocking',
              confidence: 'high',
              target: 'brief',
              evidence: 'The shared definition is wrong.',
              correction: 'State the correct definition.',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(JSON.stringify(rechecked));
    const teachingBrief = { throughline: 'Use correct definitions and a consistent example.' };
    const result = await reviewLessonPlan(plan, input, review, async () =>
      JSON.stringify({ teachingBrief, nodes: [] }),
    );
    expect(result.teachingBrief).toEqual(teachingBrief);
    expect(result.nodes).toEqual(plan.nodes);
  });

  it.each([
    { ...error, severity: 'advisory' },
    { ...error, confidence: 'medium' },
    { ...error, confidence: 'low' },
  ])(
    'accepts minor or uncertain observations without additional generation (%j)',
    async (observation) => {
      const plan = makePlan();
      const review = vi.fn().mockResolvedValue(JSON.stringify({ ...pass, issues: [observation] }));
      const repair = vi.fn();
      expect(await reviewLessonPlan(plan, input, review, repair)).toEqual(plan);
      expect(review).toHaveBeenCalledTimes(1);
      expect(repair).not.toHaveBeenCalled();
    },
  );

  it.each([
    { nodes: [] },
    { nodes: [{ sceneId: 'second', design: correctDesign }] },
    {
      nodes: [
        { sceneId: 'first', design: correctDesign },
        { sceneId: 'first', design: correctDesign },
      ],
    },
    {
      nodes: [{ sceneId: 'first', design: correctDesign }],
      teachingBrief: { throughline: 'Unrequested change.' },
    },
  ])('rejects missing, duplicated or out-of-scope repair targets (%j)', async (patch) => {
    await expect(
      reviewLessonPlan(
        makePlan(),
        input,
        async () => JSON.stringify({ ...pass, issues: [error] }),
        async () => JSON.stringify(patch),
      ),
    ).rejects.toBeInstanceOf(ClassroomQualityError);
  });
});
