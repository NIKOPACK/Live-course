import { describe, expect, it } from 'vitest';
import { htmlMediaReferences, replaceHtmlMediaReferences } from '@/lib/livecourse/html/media';
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
