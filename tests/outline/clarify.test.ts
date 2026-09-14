import { describe, expect, test } from 'vitest';
import { normalizeClarifyResult, runClarifier } from '@/lib/livecourse/outline/clarify';
import type { ClarifyResult } from '@/lib/livecourse/outline/types';

const needsClarificationJson = JSON.stringify({
  status: 'needs_clarification',
  questions: [
    {
      id: 'q1',
      question: '你想覆盖高等数学的哪些部分？',
      multiSelect: true,
      options: [
        { id: 'limits', label: '极限与连续' },
        { id: 'diff', label: '一元微分' },
        { id: 'int', label: '一元积分' },
        { id: 'multi', label: '多元微积分' },
      ],
    },
    {
      id: 'q2',
      question: '你的目标是什么？',
      multiSelect: false,
      options: [
        { id: 'beginner', label: '零基础入门' },
        { id: 'exam', label: '备考复习' },
        { id: 'refresh', label: '查漏补缺' },
      ],
    },
  ],
});

describe('runClarifier', () => {
  test('parses needs_clarification with questions and options', async () => {
    const result = await runClarifier('我想学高数', '', async () => needsClarificationJson);

    expect(result.status).toBe('needs_clarification');
    if (result.status !== 'needs_clarification') throw new Error('unreachable');
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0].multiSelect).toBe(true);
    expect(result.questions[0].options.map((o) => o.label)).toEqual([
      '极限与连续',
      '一元微分',
      '一元积分',
      '多元微积分',
    ]);
    expect(result.questions[1].multiSelect).toBe(false);
  });

  test('instructs the model not to re-ask known methods and to allow a level question for a concrete topic', async () => {
    let system = '';
    let user = '';
    await runClarifier(
      '用图示、少公式教我链式法则',
      'pace: 慢一点',
      async (systemPrompt, userPrompt) => {
        system = systemPrompt;
        user = userPrompt;
        return JSON.stringify({
          status: 'ready',
          reason: 'method and topic are known; level can be inferred',
        });
      },
    );

    expect(system).toMatch(/Do NOT ask about anything already stated/i);
    expect(system).toMatch(/chain rule|链式法则/i);
    expect(system).toMatch(/NOT automatically ready/i);
    expect(user).toContain('用图示、少公式教我链式法则');
    expect(user).toContain('pace: 慢一点');
  });

  test('parses ready verdict', async () => {
    const result = await runClarifier(
      '用中文给我讲一节课：牛顿第二定律，面向高中生',
      '',
      async () => JSON.stringify({ status: 'ready', reason: 'scope and level are clear' }),
    );

    expect(result).toEqual({ status: 'ready', reason: 'scope and level are clear' });
  });

  test('strips markdown fences around JSON', async () => {
    const result = await runClarifier(
      '我想学高数',
      '',
      async () => '```json\n' + needsClarificationJson + '\n```',
    );
    expect(result.status).toBe('needs_clarification');
  });

  test('degrades to ready on garbage output', async () => {
    const result = await runClarifier('我想学高数', '', async () => '抱歉，我无法回答这个问题');
    expect(result).toEqual({ status: 'ready' });
  });

  test('degrades to ready when questions array is empty/invalid', async () => {
    const result = await runClarifier('我想学高数', '', async () =>
      JSON.stringify({ status: 'needs_clarification', questions: [] }),
    );
    expect(result).toEqual({ status: 'ready' });
  });

  test('degrades to ready when aiCall throws', async () => {
    const result = await runClarifier('我想学高数', '', async () => {
      throw new Error('upstream down');
    });
    expect(result).toEqual({ status: 'ready' });
  });

  test('drops questions with fewer than 2 usable options and fills missing ids', async () => {
    const result = await runClarifier('我想学高数', '', async () =>
      JSON.stringify({
        status: 'needs_clarification',
        questions: [
          { question: '坏题', multiSelect: true, options: [{ label: '只有一个' }] },
          {
            question: '你的基础如何？',
            multiSelect: 'yes',
            options: [{ label: '零基础' }, { label: '学过一点' }, { label: '扎实' }],
          },
        ],
      }),
    );

    expect(result.status).toBe('needs_clarification');
    if (result.status !== 'needs_clarification') throw new Error('unreachable');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].id).toBe('q_2');
    expect(result.questions[0].multiSelect).toBe(false); // non-boolean coerced
    expect(result.questions[0].options[0].id).toBe('opt_1');
  });
});

describe('normalizeClarifyResult', () => {
  test('rejects non-object and unknown status', () => {
    expect(normalizeClarifyResult(null)).toBeNull();
    expect(normalizeClarifyResult('ready')).toBeNull();
    expect(normalizeClarifyResult({ status: 'maybe' })).toBeNull();
  });

  test('caps questions at 3 and options at 6', () => {
    const question = (n: number) => ({
      id: `q${n}`,
      question: `问题 ${n}`,
      multiSelect: false,
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C' },
        { id: 'd', label: 'D' },
        { id: 'e', label: 'E' },
        { id: 'f', label: 'F' },
        { id: 'g', label: 'G' },
      ],
    });
    const result = normalizeClarifyResult({
      status: 'needs_clarification',
      questions: [question(1), question(2), question(3), question(4)],
    }) as Extract<ClarifyResult, { status: 'needs_clarification' }>;

    expect(result.questions).toHaveLength(3);
    expect(result.questions[0].options).toHaveLength(6);
  });
});
