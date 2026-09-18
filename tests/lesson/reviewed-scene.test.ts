import { describe, expect, it, vi } from 'vitest';
import { generateReviewedTeachingMaterial } from '@/lib/generation/reviewed-scene';
import { ClassroomQualityError } from '@/lib/livecourse/lesson/quality-review';
import { attachHtmlTeacherBridge } from '@/lib/livecourse/html/teacher-bridge';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { SceneOutline } from '@/lib/types/generation';

const outline: SceneOutline = {
  id: 'wave',
  type: 'slide',
  title: 'Wave',
  order: 0,
  description: 'Distinguish amplitude and norm.',
  keyPoints: ['Amplitude is 1.'],
};
const html = (text: string) =>
  `<!DOCTYPE html><html><head></head><body><p id="plot">${text}</p></body></html>`;
const speech = (text: string) =>
  JSON.stringify([
    { type: 'action', name: 'widget_highlight', params: { target: '#plot' } },
    { type: 'text', content: text },
  ]);
const pass = JSON.stringify({ checks: ['Verified the definition and display.'], issues: [] });
const rechecked = JSON.stringify({
  checks: ['The reported error is fixed.'],
  resolutions: [
    { issueIndex: 0, fixed: true, evidence: 'The repaired material states the correct value.' },
  ],
  regressions: [],
});
const patch = (oldText: string, newText: string) =>
  JSON.stringify({ edits: [{ oldText, newText }] });
const issue = (target: 'html' | 'actions' | 'questions') =>
  JSON.stringify({
    checks: ['The peak is 1, not the L2 norm.'],
    issues: [
      {
        severity: 'blocking',
        confidence: 'high',
        target,
        evidence: 'Amplitude is stated as 0.707.',
        correction: 'Amplitude is 1.',
      },
    ],
  });

describe('reviewed classroom material', () => {
  it('accepts a substantial correct lecture without a rewrite or content quota', async () => {
    const text = 'Complete derivation. '.repeat(300);
    const content = { html: html('Amplitude is 1.'), htmlPresentation: true as const };
    const author = vi.fn().mockResolvedValue(speech(text));
    const repairHtmlCall = vi.fn();
    const result = await generateReviewedTeachingMaterial(
      outline,
      content,
      author,
      {},
      {
        reviewCall: async () => pass,
        repairHtmlCall,
      },
    );
    expect(result.content).toBe(content);
    expect(
      result.actions
        .filter((action) => action.type === 'speech')
        .map((action) => action.text)
        .join(''),
    ).toBe(text.trim());
    expect(author).toHaveBeenCalledTimes(1);
    expect(repairHtmlCall).not.toHaveBeenCalled();
  });

  it('repairs HTML, regenerates narration from that HTML, and reviews the final pair', async () => {
    const content = { html: html('Amplitude is 0.707.'), htmlPresentation: true as const };
    const author = vi
      .fn()
      .mockResolvedValueOnce(speech('Amplitude is 0.707.'))
      .mockResolvedValueOnce(speech('Amplitude is 1.'));
    const reviewCall = vi
      .fn()
      .mockResolvedValueOnce(issue('html'))
      .mockResolvedValueOnce(rechecked);
    const repairHtmlCall = vi
      .fn()
      .mockResolvedValue(patch('Amplitude is 0.707.', 'Amplitude is 1.'));
    const result = await generateReviewedTeachingMaterial(
      outline,
      content,
      author,
      {},
      { reviewCall, repairHtmlCall },
    );
    expect('html' in result.content && result.content.html).toContain('Amplitude is 1.');
    expect(content.html).toContain('Amplitude is 0.707.');
    expect(author.mock.calls[1][1]).toContain('Amplitude is 1.');
    expect(author.mock.calls[1][1]).toContain('"type":"text","content":"Amplitude is 0.707."');
    expect(author.mock.calls[1][1]).not.toContain('"type":"speech"');
    expect(author.mock.calls[1][1]).toContain('The peak is 1, not the L2 norm.');
    const reviewed = JSON.parse(reviewCall.mock.calls[1][1]);
    expect(reviewed).not.toHaveProperty('design');
    expect(reviewed.content.html).toContain('Amplitude is 1.');
    expect(
      reviewed.actions.some((action: { text?: string }) => action.text === 'Amplitude is 1.'),
    ).toBe(true);
    expect(repairHtmlCall).toHaveBeenCalledTimes(1);
  });

  it('repairs only narration when the page is already correct', async () => {
    const content = { html: html('Amplitude is 1.'), htmlPresentation: true as const };
    const author = vi
      .fn()
      .mockResolvedValueOnce(speech('Amplitude is 0.707.'))
      .mockResolvedValueOnce(speech('Amplitude is 1.'));
    const reviewCall = vi
      .fn()
      .mockResolvedValueOnce(issue('actions'))
      .mockResolvedValueOnce(rechecked);
    const repairHtmlCall = vi.fn();
    const result = await generateReviewedTeachingMaterial(
      outline,
      content,
      author,
      {},
      { reviewCall, repairHtmlCall },
    );
    expect(result.content).toBe(content);
    expect(repairHtmlCall).not.toHaveBeenCalled();
    expect(author).toHaveBeenCalledTimes(2);
  });

  it('does not audit or modify the trusted host bridge', async () => {
    const content = {
      html: attachHtmlTeacherBridge(html('Amplitude is 1.')),
      htmlPresentation: true as const,
    };
    const reviewCall = vi.fn().mockResolvedValue(pass);
    const result = await generateReviewedTeachingMaterial(
      outline,
      content,
      async () => speech('Amplitude is 1.'),
      {},
      {
        reviewCall,
        repairHtmlCall: vi.fn(),
      },
    );
    expect(JSON.parse(reviewCall.mock.calls[0][1]).content.html).not.toContain(
      'data-livecourse-teacher-bridge',
    );
    expect('html' in result.content && result.content.html).toContain(
      'data-livecourse-teacher-bridge',
    );
  });

  it('rejects an unappliable patch without publishing partially edited material', async () => {
    const content = { html: html('Amplitude is 0.707.'), htmlPresentation: true as const };
    const original = content.html;
    const author = vi.fn().mockResolvedValue(speech('Amplitude is 0.707.'));
    await expect(
      generateReviewedTeachingMaterial(
        outline,
        content,
        author,
        {},
        {
          reviewCall: async () => issue('html'),
          repairHtmlCall: async () =>
            JSON.stringify({
              edits: [
                { oldText: 'Amplitude is 0.707.', newText: 'Amplitude is 1.' },
                { oldText: 'An anchor that does not exist.', newText: 'A second correction.' },
              ],
            }),
        },
      ),
    ).rejects.toMatchObject({ name: 'ClassroomQualityError', isRetryable: false });
    expect(content.html).toBe(original);
    expect(author).toHaveBeenCalledTimes(1);
  });

  it('corrects an ambiguous edit anchor once against the untouched original page', async () => {
    const content = { html: html('Amplitude 0.707; norm 0.707.'), htmlPresentation: true as const };
    const repairHtmlCall = vi
      .fn()
      .mockResolvedValueOnce(patch('0.707', '1'))
      .mockResolvedValueOnce(patch('Amplitude 0.707', 'Amplitude 1'));
    const reviewCall = vi
      .fn()
      .mockResolvedValueOnce(issue('html'))
      .mockResolvedValueOnce(rechecked);
    const author = vi
      .fn()
      .mockResolvedValueOnce(speech('Amplitude 0.707.'))
      .mockResolvedValueOnce(speech('Amplitude 1.'));
    const result = await generateReviewedTeachingMaterial(
      outline,
      content,
      author,
      {},
      { repairHtmlCall, reviewCall },
    );
    expect(repairHtmlCall).toHaveBeenCalledTimes(2);
    expect(repairHtmlCall.mock.calls[1][1]).toContain('Found 2 occurrences');
    expect(JSON.parse(repairHtmlCall.mock.calls[1][1]).html).toBe(content.html);
    expect('html' in result.content && result.content.html).toContain('Amplitude 1; norm 0.707.');
    expect(reviewCall).toHaveBeenCalledTimes(2);
  });

  it('fails instead of accepting a malformed HTML repair', async () => {
    await expect(
      generateReviewedTeachingMaterial(
        outline,
        { html: html('Bad'), htmlPresentation: true },
        async () => speech('Bad'),
        {},
        {
          reviewCall: async () => issue('html'),
          repairHtmlCall: async () => patch('</body>', '<script>const broken = ;</script></body>'),
        },
      ),
    ).rejects.toMatchObject({ name: 'ClassroomQualityError', isRetryable: false });
  });

  it('does not rewrite authoritative checkpoint questions or grading keys', async () => {
    const question = {
      id: 'q1',
      type: 'single' as const,
      question: 'What is the amplitude?',
      options: [{ label: 'One', value: 'one' }],
      answer: ['one'],
      explanation: 'The peak is 1.',
    };
    const content = { html: html('Question'), questions: [question] };
    const repairHtmlCall = vi.fn();
    await expect(
      generateReviewedTeachingMaterial(
        { ...outline, type: 'quiz' },
        content,
        async () => '[]',
        {},
        {
          reviewCall: async () => issue('questions'),
          repairHtmlCall,
        },
      ),
    ).rejects.toBeInstanceOf(ClassroomQualityError);
    expect(content.questions).toEqual([question]);
    expect(repairHtmlCall).not.toHaveBeenCalled();
  });

  it('does not start repairs after cancellation', async () => {
    const controller = new AbortController();
    const reviewCall: AICallFn = async () => {
      controller.abort();
      return issue('html');
    };
    const repairHtmlCall = vi.fn();
    await expect(
      generateReviewedTeachingMaterial(
        outline,
        { html: html('Bad'), htmlPresentation: true },
        async () => speech('Bad'),
        {},
        {
          reviewCall,
          repairHtmlCall,
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(repairHtmlCall).not.toHaveBeenCalled();
  });
});
