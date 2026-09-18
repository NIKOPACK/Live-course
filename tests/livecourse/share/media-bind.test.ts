import { describe, expect, it } from 'vitest';
import { bindShareMediaRefs, collectShareDocumentRefs } from '@/lib/livecourse/share/media';
import { shareMediaPlaceholder } from '@/lib/livecourse/share/schema';
import { htmlScene, htmlStage } from './fixtures';

describe('bindShareMediaRefs', () => {
  it('rewrites placeholder HTML without mutating the source document', () => {
    const stage = htmlStage({ coverAssetId: 'cover-1' });
    const scenes = [
      htmlScene('<img src="gen_img_1" alt="">', {
        actions: [{ type: 'speech', id: 's1', audioId: 'audio-1' }],
        whiteboards: [{ id: 'wb-1', elements: [{ type: 'image', id: 'el-1', src: 'pool-img' }] }],
      } as never),
    ];
    const replacements = new Map([
      ['gen_img_1', shareMediaPlaceholder('media/gen_img_1.png')],
      ['cover-1', shareMediaPlaceholder('media/cover-1.png')],
      ['audio-1', shareMediaPlaceholder('audio/audio-1.mp3')],
      ['pool-img', shareMediaPlaceholder('media/pool-img.png')],
    ]);

    const bound = bindShareMediaRefs({ stage, scenes, replacements });

    expect(scenes[0].content.type === 'interactive' && scenes[0].content.html).toContain('gen_img_1');
    expect(stage.coverAssetId).toBe('cover-1');
    expect(bound.scenes[0].content.type === 'interactive' && bound.scenes[0].content.html).toContain(
      '__SHARE_MEDIA__/media/gen_img_1.png',
    );
    expect(bound.stage.coverAssetId).toBe(shareMediaPlaceholder('media/cover-1.png'));
    expect(bound.scenes[0].actions?.[0]).toMatchObject({
      audioId: shareMediaPlaceholder('audio/audio-1.mp3'),
    });
    expect((bound.scenes[0].actions?.[0] as { audioUrl?: string }).audioUrl).toBeUndefined();
    expect(JSON.stringify(bound)).not.toContain('blob:');
    expect([...collectShareDocumentRefs(bound.stage, bound.scenes)]).toEqual(
      expect.arrayContaining([
        shareMediaPlaceholder('media/gen_img_1.png'),
        shareMediaPlaceholder('media/cover-1.png'),
        shareMediaPlaceholder('audio/audio-1.mp3'),
      ]),
    );
  });

  it('rewrites existing classroom-media URLs', () => {
    const stage = htmlStage();
    const scenes = [htmlScene('<img src="/api/classroom-media/stage-AAA/media/x.png" alt="">')];
    const replacements = new Map([
      ['/api/classroom-media/stage-AAA/media/x.png', shareMediaPlaceholder('media/x.png')],
    ]);
    const bound = bindShareMediaRefs({ stage, scenes, replacements });
    expect(scenes[0].content.type === 'interactive' && scenes[0].content.html).toContain(
      '/api/classroom-media/stage-AAA/media/x.png',
    );
    expect(bound.scenes[0].content.type === 'interactive' && bound.scenes[0].content.html).toContain(
      '__SHARE_MEDIA__/media/x.png',
    );
  });
});
