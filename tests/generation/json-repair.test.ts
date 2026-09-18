import { describe, expect, it } from 'vitest';

import { extractBalancedJsonText, parseJsonResponse } from '@/lib/generation/json-repair';

describe('json-repair targeted fixes', () => {
  it('repairs quoted key-value fragments such as "height: 76"', () => {
    const raw = `{
  "background": {
    "type": "solid",
    "color": "#ffffff"
  },
  "elements": [
    {
      "id": "code_text",
      "type": "text",
      "left": 80,
      "top": 420,
      "width": 840,
      "height: 76",
      "content": "<p style=\\"font-size: 22px;\\">age = 25</p>",
      "defaultFontName": "",
      "defaultColor": "#333333"
    }
  ]
}`;

    const parsed = parseJsonResponse<{
      elements: Array<{ height: number; content: string }>;
    }>(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.elements[0]?.height).toBe(76);
    expect(parsed?.elements[0]?.content).toContain('age = 25');
  });

  it('repairs boolean property fragments without touching valid string values', () => {
    const raw = `{
  "elements": [
    {
      "id": "shape_1",
      "fixedRatio: false",
      "height: 58",
      "content": "<p>literal text: height: 58</p>"
    }
  ]
}`;

    const parsed = parseJsonResponse<{
      elements: Array<{ fixedRatio: boolean; height: number; content: string }>;
    }>(raw);

    expect(parsed).not.toBeNull();
    expect(parsed?.elements[0]?.fixedRatio).toBe(false);
    expect(parsed?.elements[0]?.height).toBe(58);
    expect(parsed?.elements[0]?.content).toBe('<p>literal text: height: 58</p>');
  });

  it('strips reasoning prefix ending with an unpaired closing think tag before JSON', () => {
    const raw = `reasoning prose with {not json} and [not json] </think>
{"ok": true}`;

    const parsed = parseJsonResponse<{ ok: boolean }>(raw);

    expect(parsed).toEqual({ ok: true });
  });

  it('prefers the final payload after an unpaired closing tag with parseable draft JSON', () => {
    const raw = `reasoning draft {"draft": true} </think>
{"ok": true}`;

    const parsed = parseJsonResponse<{ ok: boolean }>(raw);

    expect(parsed).toEqual({ ok: true });
  });

  it('prefers the final payload after a reasoning block with parseable draft JSON', () => {
    const raw = `<think>{"draft": true}</think>
{"ok": true}`;

    const parsed = parseJsonResponse<{ ok: boolean }>(raw);

    expect(parsed).toEqual({ ok: true });
  });

  it('prefers the final payload after a reasoning block with fenced draft JSON', () => {
    const raw = `<think>
\`\`\`json
{"draft": true}
\`\`\`
</think>
{"ok": true}`;

    const parsed = parseJsonResponse<{ ok: boolean }>(raw);

    expect(parsed).toEqual({ ok: true });
  });

  it('preserves literal think tags inside valid JSON strings', () => {
    const raw = '{"text":"literal <think>keep me</think>"}';

    const parsed = parseJsonResponse<{ text: string }>(raw);

    expect(parsed).toEqual({ text: 'literal <think>keep me</think>' });
  });

  it('repairs a stray quote and period between a closed array and the next key', () => {
    const extraQuoteAndPeriod =
      '{"teachingPoints":["幅度谱。","时域与频域。"]"."explanationPlan":"开场。","examples":["矩形脉冲"]}';
    const periodInsteadOfComma =
      '{"teachingPoints":["幅度谱。","时域与频域。"]."explanationPlan":"开场。","examples":["矩形脉冲"]}';
    const expected = {
      teachingPoints: ['幅度谱。', '时域与频域。'],
      explanationPlan: '开场。',
      examples: ['矩形脉冲'],
    };

    expect(parseJsonResponse(extraQuoteAndPeriod)).toEqual(expected);
    expect(parseJsonResponse(periodInsteadOfComma)).toEqual(expected);
  });

  it('repairs a stray quote-comma between a closed array and the next key', () => {
    const raw = '{"teachingPoints":["a","b"]","explanationPlan":"c"}';

    const parsed = parseJsonResponse<{ teachingPoints: string[]; explanationPlan: string }>(raw);

    expect(parsed).toEqual({ teachingPoints: ['a', 'b'], explanationPlan: 'c' });
  });

  it('inserts a missing comma after a closed array without touching valid JSON', () => {
    const raw = '{"teachingPoints":["a"]"explanationPlan":"c"}';
    const valid = '{"teachingPoints":["a"],"explanationPlan":"c"}';

    expect(parseJsonResponse(raw)).toEqual({ teachingPoints: ['a'], explanationPlan: 'c' });
    expect(parseJsonResponse(valid)).toEqual({ teachingPoints: ['a'], explanationPlan: 'c' });
  });
});

describe('extractBalancedJsonText', () => {
  it('returns a complete JSON object embedded in prose', () => {
    expect(extractBalancedJsonText('The plan is {"nodes":[]}')).toBe('{"nodes":[]}');
  });

  it('does not close a truncated array', () => {
    expect(extractBalancedJsonText('{"checks":["ok"],"issues":[')).toBeUndefined();
  });
});
