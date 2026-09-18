import { describe, expect, it } from 'vitest';
import { buildShareSnapshot } from '@/lib/livecourse/share/build-snapshot';
import { rewriteShareMaterials } from '@/lib/livecourse/share/rewrite';
import { htmlLessonPlan, htmlScene, htmlStage } from './fixtures';

describe('rewriteShareMaterials', () => {
  it('keeps source ids on the snapshot and mints two distinct identities on redeem', async () => {
    const stage = htmlStage();
    const scenes = [htmlScene('<img src="gen_img_1" alt="">')];
    const { snapshot } = await buildShareSnapshot({
      token: 'sharetoken11111111',
      stage,
      scenes,
      lessonPlan: htmlLessonPlan(),
      resolveBytes: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    });

    expect((snapshot.stage as { id: string }).id).toBe('stage-AAA');
    expect((snapshot.lessonPlan as { courseId: string }).courseId).toBe('course-AAA');
    expect(JSON.stringify(snapshot)).toContain('__SHARE_MEDIA__/');
    expect(scenes[0].content.type === 'interactive' && scenes[0].content.html).toContain('gen_img_1');

    const first = rewriteShareMaterials({
      snapshot,
      newSeed: 'seed-one',
      token: snapshot.token,
      origin: 'https://host.test',
    });
    const second = rewriteShareMaterials({
      snapshot,
      newSeed: 'seed-two',
      token: snapshot.token,
      origin: 'https://host.test',
    });

    expect(first.identity.stageId).not.toBe(second.identity.stageId);
    expect(first.identity.courseId).not.toBe(second.identity.courseId);
    expect(first.identity.lessonId).not.toBe(second.identity.lessonId);
    expect(first.identity.stageId).not.toBe(snapshot.token);
    expect(first.stage.id).toBe(first.identity.stageId);
    expect(first.scenes[0].id).toBe('scene-1');
    expect(first.lessonPlan.courseId).toBe(first.identity.courseId);
    expect(first.scenes[0].content.type === 'interactive' && first.scenes[0].content.html).toContain(
      `https://host.test/api/classroom-media/${first.identity.stageId}/`,
    );
  });

  it('sets speech audioUrl to the origin classroom-media URL', async () => {
    const { snapshot } = await buildShareSnapshot({
      token: 'sharetoken11111111',
      stage: htmlStage(),
      scenes: [
        htmlScene('<p>plain</p>', {
          actions: [{ type: 'speech', id: 's1', text: 'Hello', audioId: 'audio-1' }],
        } as never),
      ],
      lessonPlan: htmlLessonPlan(),
      resolveBytes: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
    });
    const rewritten = rewriteShareMaterials({
      snapshot,
      newSeed: 'seed-audio',
      token: snapshot.token,
      origin: 'https://host.test',
    });
    expect(rewritten.scenes[0].actions?.[0]).toMatchObject({
      audioUrl: expect.stringMatching(
        /^https:\/\/host\.test\/api\/classroom-media\/stage-.*\/audio\//,
      ),
    });
  });

  it('rejects using the token as the identity seed', async () => {
    const { snapshot } = await buildShareSnapshot({
      token: 'sharetoken11111111',
      stage: htmlStage(),
      scenes: [htmlScene('<p>no media</p>')],
      lessonPlan: htmlLessonPlan(),
    });
    expect(() =>
      rewriteShareMaterials({
        snapshot,
        newSeed: snapshot.token,
        token: snapshot.token,
        origin: 'https://host.test',
      }),
    ).toThrow(/token/i);
  });
});
