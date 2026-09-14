import type { CompleteTeachingNodeInput } from './controller';

/**
 * Build the authoritative lesson-completion command from playback lifecycle
 * facts. A cursor reaching the end is insufficient: both committed teacher
 * speech boundaries must be present before the controller can validate and
 * persist `lesson.complete_node`.
 */
export function buildPlaybackCompletionInput(input: {
  nodeId: string;
  idempotencyKey: string;
  speechStartActionId?: string;
  speechEndActionId?: string;
  actionIds?: readonly string[];
}): CompleteTeachingNodeInput | null {
  if (!input.speechStartActionId || !input.speechEndActionId) return null;
  // The controller requires at least one committed action reference.  When a
  // scene has no additional visual effects, the two speech boundary actions
  // are still the authoritative actions that prove the node was taught.
  const actionIds =
    input.actionIds && input.actionIds.length > 0
      ? [...input.actionIds]
      : [input.speechStartActionId, input.speechEndActionId];
  return {
    nodeId: input.nodeId,
    idempotencyKey: input.idempotencyKey,
    speech: {
      startActionId: input.speechStartActionId,
      endActionId: input.speechEndActionId,
    },
    actionIds,
  };
}
