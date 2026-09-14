import type { SceneOutline } from '../../../lib/types/generation';
import { defaultTheme } from './scene-content';
import { mockOutlines } from './scene-outlines';

/** Mock response for POST /api/generate/scene-actions */
export function createMockSceneActionsResponse(
  stageId: string,
  outline: SceneOutline = mockOutlines[0],
) {
  const index = outline.order;

  return {
    success: true,
    scene: {
      id: `scene-${index}`,
      outlineId: outline.id,
      stageId,
      type: 'slide',
      title: outline.title,
      order: index,
      content: {
        type: 'slide',
        canvas: {
          id: `slide-${index}`,
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: defaultTheme,
          elements: [
            {
              type: 'text',
              id: `title-el-${index}`,
              content: outline.title,
              left: 50,
              top: 50,
              width: 900,
              height: 100,
            },
          ],
        },
      },
      actions: [
        {
          id: 'action-0',
          type: 'speech',
          agent: 'teacher',
          text: `今天我们来学习${outline.title}。`,
        },
      ],
    },
    previousSpeeches: [],
  };
}
