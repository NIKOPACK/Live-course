import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  htmlMediaReferences,
  iframeSafeMediaUrl,
  replaceHtmlMediaReferences,
  UNRESOLVED_HTML_MEDIA_SRC,
} from '@/lib/livecourse/html/media';
import { collectStageAssetRefs } from '@/lib/media/collect-stage-asset-refs';
import type { Scene } from '@/lib/types/stage';

describe('model HTML media references', () => {
  it('finds quoted and unquoted media attributes without rewriting prose or scripts', () => {
    const html = `<p>gen_img_1</p><script>const x = '<img src="gen_img_1">';</script>
      <!-- <img src="ignored"> --><IMG alt="a > b src='not-an-attribute'" src='gen_img_1'><video src=gen_vid_1 poster="poster-1"></video>`;
    expect(htmlMediaReferences(html).map(({ ref }) => ref)).toEqual([
      'gen_img_1',
      'gen_img_1',
      'gen_vid_1',
      'poster-1',
    ]);
    const replaced = replaceHtmlMediaReferences(html, {
      gen_img_1: 'asset-1',
      gen_vid_1: 'asset-2',
    });
    expect(replaced).toContain(`<IMG alt="a > b src='not-an-attribute'" src='asset-1'>`);
    expect(replaced).toContain('<video src=asset-2 poster="poster-1">');
    expect(replaced).toContain('<p>gen_img_1</p>');
    expect(replaced).toContain(`const x = '<img src="asset-1">'`);
  });

  it.each(['interactive', 'quiz'] as const)(
    'retains %s HTML media as owned document references',
    (type) => {
      const html = '<img src="asset-1"><video src="asset-2" poster="poster-1"></video>';
      const content = type === 'quiz' ? { type, questions: [], html } : { type, url: '', html };
      const scene = {
        id: 'scene',
        stageId: 'stage',
        title: 'HTML',
        order: 0,
        type,
        content,
      } as Scene;
      const refs = collectStageAssetRefs(
        { stage: { id: 'stage', name: 'Test', createdAt: 1, updatedAt: 1 }, scenes: [scene] },
        { mediaRows: [], audioRows: [] },
      );
      expect([...refs.referenced]).toEqual(['asset-1', 'asset-2', 'poster-1']);
      expect(refs.imageSrc.has('asset-1')).toBe(true);
      expect(refs.videoSrc.has('asset-2')).toBe(true);
      expect(refs.poster.has('poster-1')).toBe(true);
      expect(refs.referenceCounts.get('asset-1')).toBe(1);
    },
  );

  it('treats a stage cover as an owned document image reference', () => {
    const refs = collectStageAssetRefs(
      {
        stage: {
          id: 'stage',
          name: 'Test',
          createdAt: 1,
          updatedAt: 1,
          coverAssetId: 'cover-asset',
        },
        scenes: [],
      },
      { mediaRows: [], audioRows: [] },
    );
    expect(refs.referenced.has('cover-asset')).toBe(true);
    expect(refs.imageSrc.has('cover-asset')).toBe(true);
    expect(refs.referenceCounts.get('cover-asset')).toBe(1);
  });
});

describe('iframeSafeMediaUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('inlines parent blob URLs as data URLs the sandboxed iframe can load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
      ),
    );
    await expect(iframeSafeMediaUrl('blob:https://livecourse.nikopack.works/abc')).resolves.toBe(
      `data:image/png;base64,${btoa('\x01\x02\x03')}`,
    );
    expect(fetch).toHaveBeenCalledWith('blob:https://livecourse.nikopack.works/abc');
  });

  it('leaves https and data URLs unchanged', async () => {
    await expect(iframeSafeMediaUrl('https://cdn.example/a.png')).resolves.toBe(
      'https://cdn.example/a.png',
    );
    await expect(iframeSafeMediaUrl(UNRESOLVED_HTML_MEDIA_SRC)).resolves.toBe(
      UNRESOLVED_HTML_MEDIA_SRC,
    );
  });
});

describe('htmlMediaReferences CSS and parent blob URLs', () => {
  it('finds CSS url() asset ids and parent blob URLs without rewriting scripts for ids', () => {
    const html = `<style>.a{background-image:url(lesson_img_1)}</style>
      <div style="background-image:url('asset-1')"></div>
      <script>const x = 'url(lesson_img_1)';</script>
      <img src="blob:https://livecourse.nikopack.works/abc">`;
    expect(htmlMediaReferences(html).map(({ ref }) => ref)).toEqual([
      'lesson_img_1',
      'asset-1',
      'blob:https://livecourse.nikopack.works/abc',
    ]);
    const replaced = replaceHtmlMediaReferences(html, {
      lesson_img_1: 'data:image/png;base64,AAA',
      'asset-1': 'data:image/png;base64,BBB',
    });
    expect(replaced).toContain('url(data:image/png;base64,AAA)');
    expect(replaced).toContain("url('data:image/png;base64,BBB')");
    expect(replaced).toContain(`const x = 'url(lesson_img_1)'`);
  });

  it('finds SVG href and quoted script placeholders used as image sources', () => {
    const html = `<svg><image href="lesson_img_scene_2_1"></image>
      <image xlink:href='lesson_img_scene_2_1'></image></svg>
      <script>board.src = "lesson_img_scene_2_1";</script>
      <p>lesson_img_scene_2_1</p>`;
    expect(htmlMediaReferences(html).map(({ ref }) => ref)).toEqual([
      'lesson_img_scene_2_1',
      'lesson_img_scene_2_1',
      'lesson_img_scene_2_1',
    ]);
    const replaced = replaceHtmlMediaReferences(html, {
      lesson_img_scene_2_1: 'data:image/png;base64,AAA',
    });
    expect(replaced).toContain('href="data:image/png;base64,AAA"');
    expect(replaced).toContain("xlink:href='data:image/png;base64,AAA'");
    expect(replaced).toContain('board.src = "data:image/png;base64,AAA"');
    expect(replaced).toContain('<p>lesson_img_scene_2_1</p>');
  });

  it('owns CSS url() asset ids as document image references', () => {
    const scene = {
      id: 'scene',
      stageId: 'stage',
      title: 'HTML',
      order: 0,
      type: 'interactive',
      content: {
        type: 'interactive',
        url: '',
        html: '<div style="background-image:url(asset-bg)"></div>',
      },
    } as Scene;
    const refs = collectStageAssetRefs(
      { stage: { id: 'stage', name: 'Test', createdAt: 1, updatedAt: 1 }, scenes: [scene] },
      { mediaRows: [], audioRows: [] },
    );
    expect([...refs.referenced]).toEqual(['asset-bg']);
    expect(refs.imageSrc.has('asset-bg')).toBe(true);
  });

  it('owns JS-only lesson image placeholders so media generation is not skipped', () => {
    const scene = {
      id: 'scene_2',
      stageId: 'stage',
      title: 'HTML',
      order: 0,
      type: 'interactive',
      content: {
        type: 'interactive',
        url: '',
        html: '<script>board.src="lesson_img_scene_2_1"</script><p>lesson_img_scene_2_1</p>',
      },
    } as Scene;
    const refs = collectStageAssetRefs(
      { stage: { id: 'stage', name: 'Test', createdAt: 1, updatedAt: 1 }, scenes: [scene] },
      { mediaRows: [], audioRows: [] },
    );
    expect([...refs.referenced]).toEqual(['lesson_img_scene_2_1']);
    expect(refs.imageSrc.has('lesson_img_scene_2_1')).toBe(true);
  });
});
