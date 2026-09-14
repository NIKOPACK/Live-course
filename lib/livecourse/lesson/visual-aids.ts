/**
 * 教案配图意图 → 大纲媒体请求（docs/spec/04-detailed-design.md §5/§7，A5）。
 *
 * 声明与执行分离：教案设计 Agent 只在节点 design 上声明 visualAids；本模块
 * 在逐段内容生成前把它们合并进对应 outline 的 mediaGenerations。执行仍走
 * 既有 media-orchestrator / `/api/generate/image` 与 lib/media 适配器矩阵，
 * 本模块不发起任何图片生成调用。
 *
 * 幂等：已存在于 outline.mediaGenerations 的 elementId 不重复追加；没有
 * visualAids 的节点原样保留。输入 outlines 不被修改（返回新数组）。
 */

import type { LessonPlan, LessonVisualAid } from '@/lib/livecourse/domain/schemas';
import type { MediaGenerationRequest } from '@/lib/media/types';
import type { SceneOutline } from '@/lib/types/generation';

/** 节点 design.visualAids → mediaGenerations 条目（image 类型）。 */
export function visualAidToMediaRequest(aid: LessonVisualAid): MediaGenerationRequest {
  return {
    type: 'image',
    prompt: aid.prompt,
    elementId: aid.id,
    ...(aid.aspectRatio ? { aspectRatio: aid.aspectRatio } : {}),
  };
}

/**
 * 把教案各节点的配图意图合并进对应 outline 的 mediaGenerations。
 * lessonPlan 为空或全部节点无 visualAids 时原样返回输入数组。
 */
export function applyVisualAidsToOutlines(
  lessonPlan: LessonPlan | null | undefined,
  outlines: SceneOutline[],
): SceneOutline[] {
  if (!lessonPlan) return outlines;

  const aidsBySceneId = new Map<string, LessonVisualAid[]>();
  for (const node of lessonPlan.nodes) {
    const aids = node.design?.visualAids;
    if (aids?.length) aidsBySceneId.set(node.sceneId, aids);
  }
  if (aidsBySceneId.size === 0) return outlines;

  return outlines.map((outline) => {
    const aids = aidsBySceneId.get(outline.id);
    if (!aids?.length) return outline;
    const existingIds = new Set((outline.mediaGenerations ?? []).map((mg) => mg.elementId));
    const additions = aids.filter((aid) => !existingIds.has(aid.id)).map(visualAidToMediaRequest);
    if (additions.length === 0) return outline;
    return {
      ...outline,
      mediaGenerations: [...(outline.mediaGenerations ?? []), ...additions],
    };
  });
}
