import { describe, expect, test } from 'vitest';
import { generateSceneContent } from '@/lib/generation/scene-generator';
import type { SceneOutline } from '@/lib/types/generation';

describe('video manifest wiring', () => {
  test('does not generate slide video templates; HTML classroom content is required', async () => {
    const outline: SceneOutline = {
      id: 'scene_1',
      type: 'slide',
      title: 'Horse Motion',
      description: 'Show a happy horse running',
      keyPoints: ['horse gait'],
      order: 1,
    };
    await expect(generateSceneContent(outline, async () => '{}')).rejects.toMatchObject({
      name: 'ClassroomHtmlRequiredError',
    });
  });
});
