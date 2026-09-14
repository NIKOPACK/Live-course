import { migrateScene } from '@/lib/edit/slide-schema';
import {
  hydratePBLScenesFromRuntime,
  type HydratePBLProjectArgs,
} from '@/lib/pbl/v2/runtime/hydration';
import { isCurrentStageSceneLoadToken, type StageSceneLoadToken } from '@/lib/store/stage';
import type { ChatSession } from '@/lib/types/chat';
import type { Scene, Stage } from '@/lib/types/stage';
import type { CoursePlan } from '@/lib/livecourse/domain/course-plan';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import {
  loadChatSessions,
  type ChatStorageReadOptions,
  type ChatStorageSnapshot,
} from '@/lib/utils/chat-storage';

export async function hydrateClassroomFallbackScenes(
  stageId: string,
  scenes: readonly Scene[],
  options: Pick<HydratePBLProjectArgs, 'store' | 'kv' | 'learnerKey' | 'readOnly'> = {},
): Promise<Scene[]> {
  return hydratePBLScenesFromRuntime(stageId, scenes.map(migrateScene), options);
}

export interface ClassroomFallbackChatState {
  chats: ChatSession[];
  chatSnapshot: ChatStorageSnapshot;
  /** Optional course metadata returned by a server fallback. */
  coursePlan?: CoursePlan;
  lessonPlan?: LessonPlan;
  /** Do not write the fallback document when this is a replay load. */
  persist?: boolean;
}

export async function hydrateClassroomFallbackChats(
  stageId: string,
  options: ChatStorageReadOptions = {},
): Promise<ClassroomFallbackChatState> {
  let chatSnapshot: ChatStorageSnapshot = { sessions: [], restoreMarker: undefined };
  try {
    const chats = await loadChatSessions(stageId, {
      ...options,
      onSnapshot: (snapshot) => {
        chatSnapshot = snapshot;
        options.onSnapshot?.(snapshot);
      },
    });
    return { chats, chatSnapshot };
  } catch (error) {
    console.warn(`Failed to hydrate runtime chats for server fallback stage ${stageId}:`, error);
    return { chats: [], chatSnapshot };
  }
}

export interface ApplyHydratedClassroomFallbackScenesArgs {
  loadToken: StageSceneLoadToken;
  isCurrent?: () => boolean;
  stage: Stage;
  scenes: readonly Scene[];
  coursePlan?: CoursePlan;
  lessonPlan?: LessonPlan;
  /**
   * Presentation-only fallback loads must not repair PBL runtime state or
   * persist the server payload back into the canonical document.
   */
  readOnly?: boolean;
  hydrateScenes?: (
    stageId: string,
    scenes: readonly Scene[],
    options?: Pick<HydratePBLProjectArgs, 'store' | 'kv' | 'learnerKey' | 'readOnly'>,
  ) => Promise<Scene[]>;
  hydrateChats?: (stageId: string) => Promise<ClassroomFallbackChatState>;
  applyStageAndScenes: (stage: Stage, scenes: Scene[], options: ClassroomFallbackChatState) => void;
}

export async function applyHydratedClassroomFallbackScenes({
  loadToken,
  isCurrent = () => true,
  stage,
  scenes,
  coursePlan,
  lessonPlan,
  readOnly = false,
  hydrateScenes = hydrateClassroomFallbackScenes,
  hydrateChats = async () => ({
    chats: [],
    chatSnapshot: { sessions: [], restoreMarker: null },
  }),
  applyStageAndScenes,
}: ApplyHydratedClassroomFallbackScenesArgs): Promise<boolean> {
  const [hydrated, chatState] = await Promise.all([
    readOnly
      ? hydrateScenes(stage.id, scenes, { readOnly: true })
      : hydrateScenes(stage.id, scenes),
    hydrateChats(stage.id),
  ]);
  if (!isCurrent() || !isCurrentStageSceneLoadToken(loadToken)) {
    return false;
  }
  const fallbackState = {
    ...chatState,
    ...(coursePlan === undefined ? {} : { coursePlan }),
    ...(lessonPlan === undefined ? {} : { lessonPlan }),
  };
  applyStageAndScenes(stage, hydrated, {
    ...fallbackState,
    ...(readOnly ? { persist: false } : {}),
  });
  return true;
}
