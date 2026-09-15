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
    expect(replaced).toContain(`const x = '<img src="gen_img_1">'`);
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
});

describe('iframeSafeMediaUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('inlines parent blob URLs as data URLs the sandboxed iframe can load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })),
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
    await expect(iframeSafeMediaUrl(UNRESOLVED_HTML_MEDIA_SRC)).resolves.toBe(UNRESOLVED_HTML_MEDIA_SRC);
  });
});
