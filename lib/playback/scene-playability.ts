import type { Scene } from '@/lib/types/stage';

/**
 * Whether a scene needs a local PlaybackEngine in the presentation surface.
 *
 * Any scene remains playable even when an older document omitted `actions`: the
 * playback cursor represents that case with its synthetic empty-scene dwell.
 * This matters to replay because the persisted taught range can contain a
 * quiz, interactive, or PBL node whose authored timeline is empty; skipping
 * its engine would leave replay W playing without a completion callback.
 */
export function hasPlayableSceneActions(
  scene: Pick<Scene, 'type' | 'actions'> | null | undefined,
): boolean {
  return scene !== null && scene !== undefined;
}
