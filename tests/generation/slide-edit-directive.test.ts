import { describe, expect, it } from 'vitest';
import { generateSceneContent } from '@/lib/generation/scene-generator';
import type { SceneOutline } from '@/lib/types/generation';

describe('slide content edit-mode directive', () => {
  it('does not generate slide templates; HTML classroom content is required', async () => {
    const outline: SceneOutline = {
      id: 'scene-1',
      type: 'slide',
      title: 'Test Scene',
      description: 'A scene for testing edit-mode threading.',
      keyPoints: ['point a'],
      order: 0,
    };
    await expect(
      generateSceneContent(outline, async () => '', {
        editDirective: 'make it concise',
      }),
    ).rejects.toMatchObject({ name: 'ClassroomHtmlRequiredError' });
  });
});
