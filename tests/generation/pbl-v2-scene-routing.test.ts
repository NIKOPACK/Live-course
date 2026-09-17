import { describe, expect, it, vi } from 'vitest';
import { generateSceneContent } from '@/lib/generation/scene-generator';
import type { SceneOutline } from '@/lib/types/generation';

describe('PBL v2 scene routing', () => {
  it('does not generate PBL scenes; HTML classroom content is required', async () => {
    const outline: SceneOutline = {
      id: 'pbl-1',
      type: 'pbl',
      title: 'Project',
      description: 'A project scene',
      keyPoints: ['skill'],
      order: 0,
    };
    await expect(
      generateSceneContent(outline, vi.fn(), { languageModel: {} as never }),
    ).rejects.toMatchObject({
      name: 'ClassroomHtmlRequiredError',
    });
  });
});
