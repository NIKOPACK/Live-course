/**
 * Teacher Avatar Settings Store
 *
 * Persists the 3D teacher (AIRI VRM) preferences through the
 * `@livecourse/storage` KVStore in the `device` scope: which model renders and
 * how it reacts to the pointer is a property of this machine's display, not of
 * the learner's account.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createKVPersistStorage, purgeLegacyPersistKey } from '@/lib/store/kv-persist';
import type { AiriTrackingMode } from '@/lib/livecourse/avatar/vendor/airi/eye-tracking';

/**
 * Bound after the store exists; see `onWriteRefused` for why it is not inlined.
 * The explicit annotation is what breaks the type cycle — inferring this from
 * the store would put the store back in its own definition.
 */
const recovery: { rehydrate?: () => void | Promise<void> } = {};

export const AVATAR_TRACKING_MODES: readonly AiriTrackingMode[] = ['none', 'camera', 'mouse'];

export interface AvatarSettingsState {
  /** Master switch: when false the 3D teacher is not loaded at all. */
  enabled: boolean;
  /** Custom VRM model URL; empty keeps the built-in teacher model. */
  modelUrl: string;
  /** Custom idle animation (.vrma) URL; empty keeps the vendored AIRI idle loop. */
  idleAnimationUrl: string;
  /** Where the teacher's eyes track: nothing, the camera, or the cursor. */
  trackingMode: AiriTrackingMode;
  /** AIRI bone colliders: tap head/feet/arms to trigger emotion reactions. */
  interactionsEnabled: boolean;
  setEnabled: (enabled: boolean) => void;
  setModelUrl: (modelUrl: string) => void;
  setIdleAnimationUrl: (idleAnimationUrl: string) => void;
  setTrackingMode: (trackingMode: AiriTrackingMode) => void;
  setInteractionsEnabled: (interactionsEnabled: boolean) => void;
}

export const useAvatarSettingsStore = create<AvatarSettingsState>()(
  persist(
    (set) => ({
      enabled: true,
      modelUrl: '',
      idleAnimationUrl: '',
      trackingMode: 'none',
      interactionsEnabled: true,
      setEnabled: (enabled) => set({ enabled }),
      setModelUrl: (modelUrl) => set({ modelUrl: modelUrl.trim() }),
      setIdleAnimationUrl: (idleAnimationUrl) => set({ idleAnimationUrl: idleAnimationUrl.trim() }),
      setTrackingMode: (trackingMode) =>
        set({ trackingMode: AVATAR_TRACKING_MODES.includes(trackingMode) ? trackingMode : 'none' }),
      setInteractionsEnabled: (interactionsEnabled) => set({ interactionsEnabled }),
    }),
    {
      name: 'avatar-settings-storage',
      storage: createKVPersistStorage<AvatarSettingsState>('device', {
        // One recovery attempt when a write is refused because hydration never
        // succeeded — the backend may have come back since. Routed through a
        // variable assigned below rather than naming the store directly: a
        // self-reference here would make the store's own type circular and
        // silently widen every selector to `any`.
        onWriteRefused: () => recovery.rehydrate?.(),
      }),
    },
  ),
);

// Bound after the store exists so the `onWriteRefused` hook above stays free of
// a self-reference (see the comment there).
recovery.rehydrate = () => useAvatarSettingsStore.persist.rehydrate();

// Best-effort, fire-and-forget: drop the pre-cutover raw `localStorage` blob.
// It is never read (this store does not migrate legacy data), so a leftover is
// only garbage. No correctness depends on it.
purgeLegacyPersistKey('avatar-settings-storage');
