/**
 * Live Caption Store
 *
 * Holds the realtime classroom caption (docs/spec/02-product-manual.md 课堂).
 * Captions stream in per transport delta, far too fast for the LiveCourse
 * session context's main state — a dedicated store keeps re-renders scoped to
 * the caption overlay. Captions are a read-only projection of teacher audio /
 * learner speech recognition: never persisted, never evidence.
 */

import { create } from 'zustand';

export interface LiveCaption {
  speaker: 'teacher' | 'student';
  text: string;
  /** Epoch ms of the latest update; drives the overlay's staleness fade. */
  at: number;
}

interface LiveCaptionState {
  caption: LiveCaption | null;
  /**
   * Authored / transport speech still in flight. The overlay must not treat a
   * single caption snapshot as silence while the teacher is still reading it.
   */
  holdCount: number;
  setCaption: (caption: { speaker: LiveCaption['speaker']; text: string }) => void;
  holdCaption: () => void;
  releaseCaption: () => void;
  clearCaption: () => void;
}

export const useLiveCaptionStore = create<LiveCaptionState>()((set) => ({
  caption: null,
  holdCount: 0,
  setCaption: ({ speaker, text }) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set({ caption: { speaker, text: trimmed, at: Date.now() } });
  },
  holdCaption: () => set((state) => ({ holdCount: state.holdCount + 1 })),
  releaseCaption: () => set((state) => ({ holdCount: Math.max(0, state.holdCount - 1) })),
  clearCaption: () => set({ caption: null, holdCount: 0 }),
}));
