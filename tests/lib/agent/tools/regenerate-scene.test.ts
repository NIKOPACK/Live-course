import { describe, expect, it, vi } from 'vitest';

import { makeRegenerateSceneTool } from '@/lib/agent/tools/regenerate-scene';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';
import type { SceneOutline } from '@/lib/types/generation';
import type { SceneContent } from '@/lib/types/stage';
import type { PPTElement } from '@livecourse/dsl';

function slideOutline(id: string): SceneOutline {
  return { id, type: 'slide', title: 'Slide Title', description: 'd', keyPoints: ['a'], order: 0 };
}

function slideContent(extraElements: PPTElement[] = []): SceneContent {
  return {
    type: 'slide',
    canvas: {
      id: 'cv',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [
        {
          id: 'text_old',
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          content: '<p>OLD-BASELINE-SENTINEL</p>',
          defaultFontName: '',
          defaultColor: '#000',
          rotate: 0,
        },
        ...extraElements,
      ],
    },
  } as unknown as SceneContent;
}

function slideCtx(id: string, extraElements: PPTElement[] = []): SceneContext {
  return {
    outline: slideOutline(id),
    allOutlines: [slideOutline(id)],
    content: slideContent(extraElements),
    stageId: 'stage-1',
  };
}

const NEW_SLIDE_JSON = JSON.stringify({
  elements: [
    {
      id: 'text_new',
      type: 'text',
      left: 0,
      top: 0,
      width: 100,
      height: 40,
      content: '<p>NEW-CONTENT</p>',
      defaultFontName: '',
      defaultColor: '#000',
    },
  ],
  background: null,
  remark: '',
});

describe('regenerate_scene tool', () => {
  it('rejects legacy slide regeneration without calling a model or changing its baseline', async () => {
    const aiCall = vi.fn(async () => NEW_SLIDE_JSON);
    const context = slideCtx('s1');
    const baseline = structuredClone(context);

    const tool = makeRegenerateSceneTool({
      aiCall,
      getSceneContext: (id) => (id === 's1' ? context : undefined),
    });

    await expect(
      tool.execute('call-1', {
        sceneId: 's1',
        instruction: '<<REGEN-INSTRUCTION-SENTINEL>>',
      }),
    ).rejects.toMatchObject({ name: 'ClassroomHtmlRequiredError' });
    expect(aiCall).not.toHaveBeenCalled();
    expect(context).toEqual(baseline);
  });

  it('leaves legacy images intact when the HTML prerequisite rejects regeneration', async () => {
    const aiCall = vi.fn(async () => NEW_SLIDE_JSON);

    const dataSrc = `data:image/png;base64,${'Z'.repeat(2000)}`;
    const imageEl = {
      id: 'image_old',
      type: 'image',
      left: 0,
      top: 0,
      width: 120,
      height: 80,
      src: dataSrc,
      fixedRatio: true,
      rotate: 0,
    } as unknown as PPTElement;

    const context = slideCtx('s1', [imageEl]);
    const baseline = structuredClone(context);
    const tool = makeRegenerateSceneTool({
      aiCall,
      getSceneContext: (id) => (id === 's1' ? context : undefined),
    });

    await expect(
      tool.execute('call-1', { sceneId: 's1', instruction: 'tweak it' }),
    ).rejects.toMatchObject({ name: 'ClassroomHtmlRequiredError' });
    expect(aiCall).not.toHaveBeenCalled();
    expect(context).toEqual(baseline);
  });

  it('refuses slides containing a video without generating anything', async () => {
    const aiCall = vi.fn(async () => NEW_SLIDE_JSON);
    const videoEl = {
      id: 'video_1',
      type: 'video',
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      src: 'data:video/mp4;base64,VVVV',
      autoplay: false,
      rotate: 0,
    } as unknown as PPTElement;

    const tool = makeRegenerateSceneTool({
      aiCall,
      getSceneContext: () => slideCtx('s1', [videoEl]),
    });

    const res = await tool.execute('call-1', { sceneId: 's1', instruction: 'x' });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('video');
    expect(res.details).toEqual({ sceneId: 's1', content: null, actions: [] });
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('refuses slides with a slide-level image background without generating anything', async () => {
    const aiCall = vi.fn(async () => NEW_SLIDE_JSON);
    const ctx = slideCtx('s1');
    (ctx.content as unknown as { canvas: { background: unknown } }).canvas.background = {
      type: 'image',
      image: { src: 'data:image/png;base64,IIII', size: 'cover' },
    };

    const tool = makeRegenerateSceneTool({
      aiCall,
      getSceneContext: () => ctx,
    });

    const res = await tool.execute('call-1', { sceneId: 's1', instruction: 'x' });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('image background');
    expect(res.details).toEqual({ sceneId: 's1', content: null, actions: [] });
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('refuses non-slide scenes without generating anything', async () => {
    const aiCall = vi.fn(async () => NEW_SLIDE_JSON);
    const quizCtx: SceneContext = {
      outline: { id: 'q1', type: 'quiz', title: 'Quiz', description: '', keyPoints: [], order: 0 },
      allOutlines: [],
      content: { type: 'quiz', questions: [] } as unknown as SceneContent,
      stageId: 'stage-1',
    };
    const tool = makeRegenerateSceneTool({ aiCall, getSceneContext: () => quizCtx });

    const res = await tool.execute('call-1', { sceneId: 'q1' });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('errors when the scene context is missing', async () => {
    const aiCall = vi.fn(async () => NEW_SLIDE_JSON);
    const tool = makeRegenerateSceneTool({ aiCall, getSceneContext: () => undefined });
    const res = await tool.execute('call-1', { sceneId: 'nope' });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(aiCall).not.toHaveBeenCalled();
  });
});
