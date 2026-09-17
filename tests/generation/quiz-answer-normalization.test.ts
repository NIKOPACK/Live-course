import { describe, expect, it, vi } from 'vitest';
import { generateSceneContent } from '@/lib/generation/scene-generator';
import { migrateScene } from '@/lib/edit/slide-schema';
import type { SceneOutline } from '@/lib/types/generation';
import type { QuizQuestion, Scene } from '@/lib/types/stage';

const outline: SceneOutline = {
  id: 'check',
  type: 'quiz',
  title: 'Addition',
  description: 'Check addition.',
  keyPoints: ['Addition'],
  order: 1,
  quizConfig: { questionCount: 1, difficulty: 'easy', questionTypes: ['single'] },
};
const presentation = { mode: 'html' as const, visualStyle: 'Simple mathematical diagrams.' };
const html = '<!doctype html><html><body><main id="check">Addition</main></body></html>';
const question: QuizQuestion = {
  id: 'q1',
  type: 'single',
  question: '1 + 1 = ?',
  options: [
    { value: 'A', label: '1' },
    { value: 'B', label: '2' },
    { value: 'C', label: '3' },
  ],
  answer: ['2'],
};

describe('quiz answer normalization boundaries', () => {
  it.each(['answer', 'correctAnswer', 'correct_answer'])(
    'normalizes generated %s labels before generating the HTML',
    async (field) => {
      const { answer: _answer, ...withoutAnswer } = question;
      const aiCall = vi
        .fn()
        .mockResolvedValueOnce(JSON.stringify([{ ...withoutAnswer, [field]: '2' }]))
        .mockResolvedValueOnce(html);
      const content = await generateSceneContent(outline, aiCall, { presentation });
      expect(content).toMatchObject({ questions: [{ answer: ['B'], hasAnswer: true }] });
      expect(aiCall).toHaveBeenCalledTimes(2);
      expect(aiCall.mock.calls[1][1]).not.toContain('"answer"');
    },
  );

  it('preserves a numeric zero answer from the model', async () => {
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify([{ ...question, options: ['0', '1'], answer: 0 }]))
      .mockResolvedValueOnce(html);
    await expect(generateSceneContent(outline, aiCall, { presentation })).resolves.toMatchObject({
      questions: [{ answer: ['A'] }],
    });
  });

  it.each([{ answer: undefined }, { answer: [] }, { answer: ['unknown'] }])(
    'fails generation for unusable key $answer before generating HTML',
    async ({ answer }) => {
      const aiCall = vi.fn().mockResolvedValue(JSON.stringify([{ ...question, answer }]));
      await expect(generateSceneContent(outline, aiCall, { presentation })).rejects.toThrow(
        /answer/i,
      );
      expect(aiCall).toHaveBeenCalledTimes(1);
    },
  );

  it('normalizes legacy scene content for both display and grading, purely and idempotently', () => {
    const scene: Scene = {
      id: 'scene-check',
      stageId: 'stage',
      type: 'quiz',
      title: 'Addition',
      order: 1,
      content: { type: 'quiz', questions: [question] },
      actions: [],
    };
    const normalized = migrateScene(scene);
    expect(normalized.content).toMatchObject({ questions: [{ answer: ['B'] }] });
    expect(scene.content).toMatchObject({ questions: [{ answer: ['2'] }] });
    expect(migrateScene(normalized)).toBe(normalized);
  });
});
