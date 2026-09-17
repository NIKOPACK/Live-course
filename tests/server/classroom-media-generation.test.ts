import { describe, expect, test } from 'vitest';
import { replaceMediaPlaceholders } from '@/lib/server/classroom-media-generation';
import type { Scene } from '@/lib/types/stage';

function slideScene(
  elements: Array<{ id: string; type: string; src?: string; mediaRef?: string }>,
) {
  return {
    id: 'scene_1',
    stageId: 'stage_1',
    type: 'slide',
    title: 'Scene',
    order: 1,
    content: {
      type: 'slide',
      canvas: {
        id: 'canvas_1',
        elements,
      },
    },
  } as unknown as Scene;
}

describe('classroom media placeholder replacement', () => {
  test.each(['interactive', 'quiz'] as const)(
    'reconciles generated-after-page images and video in %s HTML without changing its content facts',
    (type) => {
      const html = `<html><head><script>const example = '<img src="gen_img_1">';</script></head><body>
        <p>gen_img_1</p><img src="gen_img_1"><video poster='gen_img_1'><source src=gen_vid_1></video>
        <img src="https://source.test/original.png"><img src="gen_img_pending"></body></html>`;
      const questions = [
        { id: 'q1', type: 'short_answer' as const, question: 'Describe the scene.', points: 2 },
      ];
      const content = type === 'quiz' ? { type, questions, html } : { type, url: '', html };
      const scene = {
        id: 'scene_html',
        stageId: 'stage_1',
        title: 'HTML page',
        type,
        content,
        order: 0,
      } as Scene;
      const mediaMap = {
        gen_img_1: 'https://host.test/api/classroom-media/stage_1/media/gen_img_1.png',
        gen_vid_1: 'https://host.test/api/classroom-media/stage_1/media/gen_vid_1.mp4',
        'https://source.test/original.png': 'https://ignored.test/not-a-placeholder.png',
      };

      replaceMediaPlaceholders([scene], mediaMap);

      if (scene.content.type !== 'quiz' && scene.content.type !== 'interactive')
        throw new Error('Unexpected scene kind');
      const replaced = scene.content.html!;
      expect(replaced).toContain(`<img src="${mediaMap.gen_img_1}">`);
      expect(replaced).toContain(`<video poster='${mediaMap.gen_img_1}'>`);
      expect(replaced).toContain(`<source src=${mediaMap.gen_vid_1}>`);
      expect(replaced).toContain('<p>gen_img_1</p>');
      expect(replaced).toContain(`const example = '<img src="${mediaMap.gen_img_1}">'`);
      expect(replaced).toContain('<img src="https://source.test/original.png">');
      expect(replaced).toContain('<img src="gen_img_pending">');
      if (scene.content.type === 'quiz') expect(scene.content.questions).toBe(questions);

      replaceMediaPlaceholders([scene], mediaMap);
      expect(scene.content.html).toBe(replaced);
    },
  );

  test('leaves legacy quiz content untouched when no HTML presentation exists', () => {
    const content = { type: 'quiz' as const, questions: [] };
    const scene: Scene = {
      id: 'legacy',
      stageId: 'stage_1',
      title: 'Legacy quiz',
      type: 'quiz',
      content,
      order: 0,
    };
    replaceMediaPlaceholders([scene], { gen_img_1: 'https://host.test/generated.png' });
    expect(scene.content).toBe(content);
    expect(scene.content).not.toHaveProperty('html');
  });

  test('preserves direct video src when mediaRef is also present', () => {
    const scene = slideScene([
      {
        id: 'video_1',
        type: 'video',
        src: 'https://example.com/direct.mp4',
        mediaRef: 'gen_vid_real123',
      },
    ]);

    replaceMediaPlaceholders([scene], {
      gen_vid_real123: 'https://cdn.example.com/generated.mp4',
    });

    const content = scene.content as {
      canvas: { elements: Array<{ src?: string }> };
    };
    const video = content.canvas.elements[0];
    expect(video.src).toBe('https://example.com/direct.mp4');
  });

  test('preserves an author-supplied non-URL src when mediaRef is also present', () => {
    const scene = slideScene([
      {
        id: 'video_1',
        type: 'video',
        src: 'lesson-intro.mp4',
        mediaRef: 'gen_vid_real123',
      },
    ]);

    replaceMediaPlaceholders([scene], {
      gen_vid_real123: 'https://cdn.example.com/generated.mp4',
    });

    const content = scene.content as {
      canvas: { elements: Array<{ src?: string }> };
    };
    expect(content.canvas.elements[0].src).toBe('lesson-intro.mp4');
  });

  test('does not treat an image placeholder as the video-manifest overwrite guard', () => {
    const scene = slideScene([
      {
        id: 'video_1',
        type: 'video',
        src: 'gen_img_preview123',
        mediaRef: 'gen_vid_real123',
      },
    ]);

    replaceMediaPlaceholders([scene], {
      gen_vid_real123: 'https://cdn.example.com/generated.mp4',
    });

    const content = scene.content as {
      canvas: { elements: Array<{ src?: string }> };
    };
    expect(content.canvas.elements[0].src).toBe('gen_img_preview123');
  });
});
