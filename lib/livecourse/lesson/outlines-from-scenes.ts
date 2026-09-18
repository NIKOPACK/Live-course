import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

/** Preview segments key off store outlines. A loaded classroom must project them. */
export function outlinesFromClassroomScenes(scenes: readonly Scene[]): SceneOutline[] {
  return scenes.map((scene, index) => {
    const type: SceneOutline['type'] =
      scene.type === 'quiz' || scene.type === 'interactive' || scene.type === 'pbl'
        ? scene.type
        : 'slide';
    return {
      id: scene.outlineId || scene.id,
      type,
      title: scene.title,
      description: scene.title,
      keyPoints: [],
      order: typeof scene.order === 'number' ? scene.order : index,
    };
  });
}
