/**
 * Widget iframe messaging store.
 * Tracks iframe postMessage callbacks per scene to prevent race conditions
 * when switching between interactive scenes.
 */

import { create } from 'zustand';
import type { WidgetMessageCallback } from '@/lib/action/engine';

interface WidgetIframeState {
  /** Callbacks keyed by sceneId for targeted postMessage communication */
  sendMessageByScene: Record<string, WidgetMessageCallback>;
  /** Currently active scene ID (used for fallback/legacy support) */
  activeSceneId: string | null;
  /** Register an iframe callback for a specific scene */
  registerIframe: (sceneId: string, callback: WidgetMessageCallback | null) => void;
  /** Set the active scene ID */
  setActiveScene: (sceneId: string | null) => void;
  /** Get sendMessage callback for a specific scene (or current active scene) */
  getSendMessage: (sceneId?: string) => WidgetMessageCallback | null;
}

export const useWidgetIframeStore = create<WidgetIframeState>((set, get) => ({
  sendMessageByScene: {},
  activeSceneId: null,
  registerIframe: (sceneId, callback) =>
    set((state) => {
      if (callback === null) {
        // Unregister: remove from map
        const updated = { ...state.sendMessageByScene };
        delete updated[sceneId];
        return { sendMessageByScene: updated };
      }
      // Register: add to map
      return {
        sendMessageByScene: { ...state.sendMessageByScene, [sceneId]: callback },
      };
    }),
  setActiveScene: (sceneId) => set({ activeSceneId: sceneId }),
  getSendMessage: (sceneId) => {
    const state = get();
    const targetId = sceneId ?? state.activeSceneId;
    if (!targetId) return null;
    return state.sendMessageByScene[targetId] ?? null;
  },
}));

/** Scene registration may happen a React commit after playback starts. */
export async function sendWidgetMessage(
  sceneId: string,
  type: string,
  payload: Record<string, unknown>,
  { signal }: { signal?: AbortSignal } = {},
): Promise<void> {
  if (signal?.aborted) throw new DOMException('Widget action cancelled', 'AbortError');
  const registered = useWidgetIframeStore.getState().getSendMessage(sceneId);
  const send =
    registered ??
    (await new Promise<WidgetMessageCallback>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException('Widget action cancelled', 'AbortError'));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Classroom page is not ready: ${sceneId}`));
      }, 10_000);
      const unsubscribe = useWidgetIframeStore.subscribe((state) => {
        const callback = state.getSendMessage(sceneId);
        if (!callback) return;
        cleanup();
        resolve(callback);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    }));
  if (signal?.aborted) throw new DOMException('Widget action cancelled', 'AbortError');
  await send(type, payload, { signal });
}
