import type { SlideTheme } from '@livecourse/dsl';
import type { SceneOutline } from '../../../lib/types/generation';
import { mockOutlines } from './scene-outlines';

/** Default theme matching @livecourse/dsl SlideTheme */
const defaultTheme: SlideTheme = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Microsoft Yahei',
};

/** Build a response whose identifiers follow the requested outline. */
export function createMockSceneContentResponse(outline: SceneOutline = mockOutlines[0]) {
  const index = outline.order;

  return {
    success: true,
    content: {
      type: 'slide' as const,
      canvas: {
        id: `slide-${index}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: defaultTheme,
        elements: [
          {
            type: 'text' as const,
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
    effectiveOutline: outline,
  };
}

/** Default mock response for tests that do not inspect the request. */
export const mockSceneContentResponse = createMockSceneContentResponse();

export { defaultTheme };
