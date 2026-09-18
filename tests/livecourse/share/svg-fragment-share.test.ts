import { describe, expect, it, vi } from 'vitest';
import { buildShareSnapshot } from '@/lib/livecourse/share/build-snapshot';
import { htmlLessonPlan, htmlScene, htmlStage } from './fixtures';

const SVG_FRAGMENT_HTML = `<style>
  .wave { fill: url(#wave-grad); }
  .ink { mask: url("#ink-mask"); }
</style>
<svg viewBox="0 0 100 100">
  <defs>
    <linearGradient id="wave-grad"><stop offset="0" stop-color="#123"/></linearGradient>
  </defs>
  <rect class="wave" width="100" height="100"/>
</svg>
<img src="gen_img_1" alt="">`;

describe('course share snapshot vs generated HTML fragments', () => {
  it('shares a page that uses SVG url(#id) without treating fragments as missing media', async () => {
    const resolveBytes = vi.fn(async ({ ref }: { ref: string }) => {
      if (ref === 'gen_img_1') {
        return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
      }
      throw new Error(`unexpected media ref ${ref}`);
    });

    const { snapshot, files } = await buildShareSnapshot({
      token: 'sharetoken11111111',
      stage: htmlStage(),
      scenes: [htmlScene(SVG_FRAGMENT_HTML)],
      lessonPlan: htmlLessonPlan(),
      resolveBytes,
    });

    expect(files).toHaveLength(1);
    expect(snapshot.mediaManifest.map((entry) => entry.sourceRef)).toEqual(['gen_img_1']);
    expect(JSON.stringify(snapshot.scenes)).toContain('url(#wave-grad)');
    expect(resolveBytes).toHaveBeenCalledTimes(1);
  });

  it('still fails when a real generated image has no bytes', async () => {
    await expect(
      buildShareSnapshot({
        token: 'sharetoken11111111',
        stage: htmlStage(),
        scenes: [htmlScene('<img src="gen_img_1" alt="">')],
        lessonPlan: htmlLessonPlan(),
        resolveBytes: async () => {
          throw new Error('Missing media bytes for gen_img_1');
        },
      }),
    ).rejects.toThrow(/gen_img_1/);
  });
});
