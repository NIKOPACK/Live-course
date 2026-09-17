import type { Scene, Stage } from '@/lib/types/stage';

import { lessonPlanSchema, type LessonNode, type LessonPlan } from './schemas';

const DEFAULT_GOAL_RULE = Object.freeze({
  version: 'livecourse-quiz-mastery-v1',
  passScore: 0.7,
  minAcceptedEvidence: 1,
  minPassingEvidence: 1,
});

function nodeType(scene: Scene): LessonNode['type'] {
  switch (scene.type) {
    case 'quiz':
      return 'checkpoint';
    case 'interactive':
      return 'interactive';
    case 'pbl':
      return 'project';
    default:
      return 'instruction';
  }
}

export function goalIdForScene(sceneId: string): string {
  return `goal:${sceneId}`;
}

export function nodeIdForScene(sceneId: string): string {
  return `node:${sceneId}`;
}

const NODE_ID_PREFIX = 'node:';

export function sceneIdFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith(NODE_ID_PREFIX) ? nodeId.slice(NODE_ID_PREFIX.length) : null;
}

/**
 * Designer/skeleton plans key nodes by outline id. Generated scenes get a
 * fresh nanoid plus `outlineId`. Teaching writes `node:<sceneNanoid>` into C.
 * Rebind so continue/recovery can look up the generated scene.
 */
export function bindLessonPlanToGeneratedScenes(
  plan: LessonPlan,
  scenes: readonly Scene[],
): LessonPlan {
  const nodes = bindLessonNodesToGeneratedScenes(plan.nodes, scenes);
  return nodes === plan.nodes ? plan : { ...plan, nodes };
}

export function bindLessonNodesToGeneratedScenes(
  nodes: LessonNode[],
  scenes: readonly Scene[],
): LessonNode[] {
  if (scenes.length === 0) return nodes;

  const scenesById = new Map<string, Scene>();
  const scenesByOutlineId = new Map<string, Scene>();
  for (const scene of scenes) {
    scenesById.set(scene.id, scene);
    const outlineId = scene.outlineId?.trim();
    if (!outlineId) continue;
    const existing = scenesByOutlineId.get(outlineId);
    if (existing && existing.id !== scene.id) {
      throw new Error(`Generated scenes share outlineId ${JSON.stringify(outlineId)}`);
    }
    scenesByOutlineId.set(outlineId, scene);
  }

  let changed = false;
  const boundSceneIds = new Set<string>();
  const boundNodes = nodes.map((node) => {
    const boundScene = scenesById.get(node.sceneId) ?? scenesByOutlineId.get(node.sceneId);
    if (!boundScene) return node;
    if (boundSceneIds.has(boundScene.id)) {
      throw new Error(
        `Cannot bind lesson nodes ${JSON.stringify(node.id)} and another node to scene ${JSON.stringify(boundScene.id)}`,
      );
    }
    boundSceneIds.add(boundScene.id);
    const nextId = nodeIdForScene(boundScene.id);
    if (node.id === nextId && node.sceneId === boundScene.id) return node;
    changed = true;
    return { ...node, id: nextId, sceneId: boundScene.id };
  });

  return changed ? boundNodes : nodes;
}

export function deriveLessonPlanFromStage(input: {
  stage: Stage;
  scenes: readonly Scene[];
  now?: string;
}): LessonPlan {
  const orderedScenes = [...input.scenes].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  const quizScenes = orderedScenes.filter((scene) => scene.type === 'quiz');
  const fallbackGoalId = `goal:${input.stage.id}:lesson`;
  const goals =
    quizScenes.length > 0
      ? quizScenes.map((scene) => ({
          id: goalIdForScene(scene.id),
          title: scene.title || '课堂检查点',
          description: `通过课堂节点“${scene.title || scene.id}”的可审计结果判断掌握状态。`,
          rule: DEFAULT_GOAL_RULE,
        }))
      : [
          {
            id: fallbackGoalId,
            title: input.stage.name || '本课学习目标',
            description: '等待课堂检查点或教师复核证据。',
            rule: DEFAULT_GOAL_RULE,
          },
        ];
  const goalIds = new Set(goals.map((goal) => goal.id));

  return lessonPlanSchema.parse({
    schemaVersion: 1,
    id: `lesson-plan:${input.stage.id}`,
    courseId: input.stage.id,
    stageId: input.stage.id,
    title: input.stage.name || 'LiveCourse Lesson',
    version: 1,
    status: 'approved',
    createdAt: input.now ?? new Date(input.stage.createdAt).toISOString(),
    goals,
    nodes: orderedScenes.map((scene) => {
      const sceneGoalId = goalIdForScene(scene.id);
      return {
        id: nodeIdForScene(scene.id),
        sceneId: scene.id,
        title: scene.title || `Scene ${scene.order + 1}`,
        type: nodeType(scene),
        order: scene.order,
        goalIds: goalIds.has(sceneGoalId)
          ? [sceneGoalId]
          : [fallbackGoalId].filter((id) => goalIds.has(id)),
      };
    }),
  });
}
