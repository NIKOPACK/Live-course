import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCanvasAPI, createCanvasPresentationOwner } from '@/lib/api/stage-api-canvas';
import { createStagePresentationStore } from '@/lib/api/stage-api';
import { useCanvasStore } from '@/lib/store/canvas';

const stageStore = {
  getState: () => ({
    stage: null,
    scenes: [],
    currentSceneId: null,
    mode: 'playback' as const,
  }),
  setState: vi.fn(),
  subscribe: () => () => {},
};

const ownerDisposalOrders = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

const ownerTimerPatterns = [
  { label: 'none timed', timers: [false, false, false] },
  { label: 'outer timed', timers: [true, false, false] },
  { label: 'alternating timers', timers: [true, false, true] },
  { label: 'all timed', timers: [true, true, true] },
] as const;

const ownerDisposalCases = ownerTimerPatterns.flatMap((pattern) =>
  ownerDisposalOrders.map((order) => ({ ...pattern, order })),
);

const alternatingOwnerCases = Array.from({ length: 16 }, (_, mask) =>
  Array.from({ length: 4 }, (__, index) => ((mask >> index) & 1) as 0 | 1),
).filter((owners) => new Set(owners).size === 2);

const alternatingTimerCases = Array.from({ length: 16 }, (_, mask) =>
  Array.from({ length: 4 }, (__, index) => Boolean((mask >> index) & 1)),
);

describe('Canvas presentation ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCanvasStore.getState().resetCanvasState();
  });

  afterEach(() => {
    useCanvasStore.getState().resetCanvasState();
    vi.useRealTimers();
  });

  it('restores a changed timer even when the visual overlay is identical', () => {
    const owner = createCanvasPresentationOwner();
    const api = createCanvasAPI(stageStore, { presentationOwner: owner });

    try {
      const before = owner.capture();
      expect(api.highlight('scene-1', 'element-1', { duration: 1_000 })).toEqual({
        success: true,
        data: true,
      });
      const expected = owner.capture();

      // The action's overlay is visible, but the transaction must be able to
      // compensate the timer resource as well as the pixels/state.
      expect(expected.highlightedElementIds).toEqual(['element-1']);
      expect(expected.timerRemainingMs.highlight).toBeDefined();
      expect(owner.restoreIfCurrent(before, expected)).toBe(true);

      const restored = owner.capture();
      expect(restored.highlightedElementIds).toEqual([]);
      expect(restored.highlightOptions).toBeNull();
      expect(restored.timerRemainingMs.highlight).toBeUndefined();

      vi.advanceTimersByTime(1_000);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      owner.dispose();
    }
  });

  it('restores an in-process timer callback once after an overwrite', () => {
    const owner = createCanvasPresentationOwner({ trackBaseline: false });
    let clearCount = 0;

    try {
      owner.claim('highlight');
      useCanvasStore.getState().setHighlight(['original']);
      owner.schedule('highlight', 100, () => {
        clearCount += 1;
        useCanvasStore.getState().clearHighlight();
      });
      const captured = owner.capture();

      owner.claim('highlight');
      useCanvasStore.getState().setHighlight(['replacement']);
      owner.restore(captured);

      vi.advanceTimersByTime(100);
      expect(clearCount).toBe(1);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);

      // A stale snapshot can still be restored, but a settled callback must
      // not run a second time.
      owner.restore(captured);
      expect(clearCount).toBe(1);
    } finally {
      owner.dispose();
    }
  });

  it('uses generic clearing when a snapshot crosses a structured-clone boundary', () => {
    const owner = createCanvasPresentationOwner({ trackBaseline: false });
    let clearCount = 0;

    try {
      owner.claim('highlight');
      useCanvasStore.getState().setHighlight(['serialized']);
      owner.schedule('highlight', 100, () => {
        clearCount += 1;
        useCanvasStore.getState().clearHighlight();
      });
      const cloned = structuredClone(owner.capture());

      owner.cancel('highlight');
      owner.restore(cloned);
      vi.advanceTimersByTime(100);

      expect(clearCount).toBe(0);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      owner.dispose();
    }
  });

  it('uses generic clearing when runtime timer identity is missing', () => {
    const owner = createCanvasPresentationOwner({ trackBaseline: false });
    let clearCount = 0;

    try {
      owner.claim('highlight');
      useCanvasStore.getState().setHighlight(['captured']);
      owner.schedule('highlight', 100, () => {
        clearCount += 1;
        useCanvasStore.getState().clearHighlight();
      });
      const captured = owner.capture();
      delete captured.timerGenerations?.highlight;

      owner.cancel('highlight');
      owner.restore(captured);
      vi.advanceTimersByTime(100);

      expect(clearCount).toBe(0);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      owner.dispose();
    }
  });

  it('does not let an expired timer from an older owner clear a newer overlay', () => {
    const oldOwner = createCanvasPresentationOwner();
    const newOwner = createCanvasPresentationOwner();
    const oldApi = createCanvasAPI(stageStore, { presentationOwner: oldOwner });
    const newApi = createCanvasAPI(stageStore, { presentationOwner: newOwner });

    try {
      expect(oldApi.highlight('scene-1', 'old', { duration: 100 })).toMatchObject({
        success: true,
      });
      vi.advanceTimersByTime(50);

      expect(newApi.highlight('scene-1', 'new', { duration: 1_000 })).toMatchObject({
        success: true,
      });
      vi.advanceTimersByTime(50);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['new']);

      // Cleanup of the superseded owner must not cancel the new owner's
      // process-wide channel or its timer lease.
      oldOwner.cancel('highlight');
      oldOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['new']);
      vi.advanceTimersByTime(950);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      newOwner.dispose();
      oldOwner.dispose();
    }
  });

  it('hands a covered baseline timer back after a nested owner is disposed', () => {
    const outerOwner = createCanvasPresentationOwner();
    const innerOwner = createCanvasPresentationOwner();
    const outerApi = createCanvasAPI(stageStore, { presentationOwner: outerOwner });
    const innerApi = createCanvasAPI(stageStore, { presentationOwner: innerOwner });

    try {
      expect(outerApi.highlight('scene-1', 'outer', { duration: 100 })).toMatchObject({
        success: true,
      });
      vi.advanceTimersByTime(20);

      // A short-lived presentation (for example a nested replay surface)
      // temporarily covers the outer projection. Its cleanup must preserve
      // the outer timer's original deadline and clear callback.
      expect(innerApi.highlight('scene-1', 'inner')).toMatchObject({ success: true });
      innerOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['outer']);

      vi.advanceTimersByTime(79);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['outer']);
      vi.advanceTimersByTime(1);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      innerOwner.dispose();
      outerOwner.dispose();
    }
  });

  it('hands timers back through multiple nested owners in LIFO order', () => {
    const outerOwner = createCanvasPresentationOwner();
    const middleOwner = createCanvasPresentationOwner();
    const innerOwner = createCanvasPresentationOwner();
    const outerApi = createCanvasAPI(stageStore, { presentationOwner: outerOwner });
    const middleApi = createCanvasAPI(stageStore, { presentationOwner: middleOwner });
    const innerApi = createCanvasAPI(stageStore, { presentationOwner: innerOwner });

    try {
      outerApi.highlight('scene-1', 'outer', { duration: 100 });
      vi.advanceTimersByTime(10);
      middleApi.highlight('scene-1', 'middle', { duration: 200 });
      vi.advanceTimersByTime(10);
      innerApi.highlight('scene-1', 'inner');
      vi.advanceTimersByTime(10);

      innerOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['middle']);
      vi.advanceTimersByTime(10);
      middleOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['outer']);

      vi.advanceTimersByTime(59);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['outer']);
      vi.advanceTimersByTime(1);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      innerOwner.dispose();
      middleOwner.dispose();
      outerOwner.dispose();
    }
  });

  it('hands ownership back through an untimed middle owner', () => {
    const outerOwner = createCanvasPresentationOwner();
    const middleOwner = createCanvasPresentationOwner();
    const innerOwner = createCanvasPresentationOwner();
    const middleApi = createCanvasAPI(stageStore, { presentationOwner: middleOwner });
    const innerApi = createCanvasAPI(stageStore, { presentationOwner: innerOwner });
    let outerClearCount = 0;

    try {
      outerOwner.claim('highlight');
      useCanvasStore.getState().setHighlight(['outer']);
      outerOwner.schedule('highlight', 100, () => {
        outerClearCount += 1;
        useCanvasStore.getState().clearHighlight();
      });
      vi.advanceTimersByTime(10);
      expect(middleApi.highlight('scene-1', 'middle')).toMatchObject({ success: true });
      vi.advanceTimersByTime(10);
      expect(innerApi.highlight('scene-1', 'inner', { duration: 200 })).toMatchObject({
        success: true,
      });
      vi.advanceTimersByTime(10);

      innerOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['middle']);

      vi.advanceTimersByTime(10);
      middleOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['outer']);

      vi.advanceTimersByTime(59);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['outer']);
      vi.advanceTimersByTime(1);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      expect(outerClearCount).toBe(1);
    } finally {
      innerOwner.dispose();
      middleOwner.dispose();
      outerOwner.dispose();
    }
  });

  it.each(ownerDisposalCases)(
    'keeps the newest live overlay for $label with disposal order $order',
    ({ timers, order }) => {
      const owners = [
        createCanvasPresentationOwner(),
        createCanvasPresentationOwner(),
        createCanvasPresentationOwner(),
      ];
      const apis = owners.map((presentationOwner) =>
        createCanvasAPI(stageStore, { presentationOwner }),
      );
      const liveOwners = new Set([0, 1, 2]);

      try {
        for (const [index, api] of apis.entries()) {
          expect(
            api.highlight('scene-1', `owner-${index}`, timers[index] ? { duration: 60_000 } : {}),
          ).toMatchObject({ success: true });
        }

        for (const ownerIndex of order) {
          owners[ownerIndex].dispose();
          liveOwners.delete(ownerIndex);
          const newestLiveOwner = [...liveOwners].at(-1);
          expect(useCanvasStore.getState().highlightedElementIds).toEqual(
            newestLiveOwner === undefined ? [] : [`owner-${newestLiveOwner}`],
          );
        }

        vi.advanceTimersByTime(60_000);
        expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      } finally {
        for (const owner of owners) owner.dispose();
      }
    },
  );

  it('rebases a covering owner when the covered owner is disposed first', () => {
    const outerOwner = createCanvasPresentationOwner();
    const innerOwner = createCanvasPresentationOwner();
    const outerApi = createCanvasAPI(stageStore, { presentationOwner: outerOwner });
    const innerApi = createCanvasAPI(stageStore, { presentationOwner: innerOwner });

    try {
      expect(outerApi.highlight('scene-1', 'outer', { duration: 1_000 })).toMatchObject({
        success: true,
      });
      expect(innerApi.highlight('scene-1', 'inner')).toMatchObject({ success: true });

      outerOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['inner']);

      innerOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      innerOwner.dispose();
      outerOwner.dispose();
    }
  });

  it('preserves the timer chain when a covered middle owner is disposed first', () => {
    const outerOwner = createCanvasPresentationOwner();
    const middleOwner = createCanvasPresentationOwner();
    const innerOwner = createCanvasPresentationOwner();
    const outerApi = createCanvasAPI(stageStore, { presentationOwner: outerOwner });
    const middleApi = createCanvasAPI(stageStore, { presentationOwner: middleOwner });
    const innerApi = createCanvasAPI(stageStore, { presentationOwner: innerOwner });

    try {
      expect(outerApi.highlight('scene-1', 'outer', { duration: 100 })).toMatchObject({
        success: true,
      });
      vi.advanceTimersByTime(10);
      expect(middleApi.highlight('scene-1', 'middle', { duration: 200 })).toMatchObject({
        success: true,
      });
      vi.advanceTimersByTime(10);
      expect(innerApi.highlight('scene-1', 'inner')).toMatchObject({ success: true });
      vi.advanceTimersByTime(10);

      middleOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['inner']);

      vi.advanceTimersByTime(10);
      innerOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['outer']);

      vi.advanceTimersByTime(59);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['outer']);
      vi.advanceTimersByTime(1);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      innerOwner.dispose();
      middleOwner.dispose();
      outerOwner.dispose();
    }
  });

  it('preserves a baseline callback through a non-LIFO owner rebase', () => {
    const coveredOwner = createCanvasPresentationOwner();
    const coveringOwner = createCanvasPresentationOwner();
    const coveredApi = createCanvasAPI(stageStore, { presentationOwner: coveredOwner });
    const coveringApi = createCanvasAPI(stageStore, { presentationOwner: coveringOwner });
    let baselineClearCount = 0;

    try {
      coveredOwner.claim('highlight');
      useCanvasStore.getState().setHighlight(['baseline']);
      coveredOwner.schedule('highlight', 100, () => {
        baselineClearCount += 1;
        useCanvasStore.getState().clearHighlight();
      });
      vi.advanceTimersByTime(10);

      coveredOwner.beginMutation();
      expect(coveredApi.highlight('scene-1', 'covered')).toMatchObject({ success: true });
      vi.advanceTimersByTime(10);
      expect(coveringApi.highlight('scene-1', 'covering')).toMatchObject({ success: true });
      vi.advanceTimersByTime(10);

      coveredOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['covering']);

      coveringOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['baseline']);
      vi.advanceTimersByTime(69);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['baseline']);
      vi.advanceTimersByTime(1);
      expect(baselineClearCount).toBe(1);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      coveringOwner.dispose();
      coveredOwner.dispose();
    }
  });

  it('hands channel ownership back after owners alternately reclaim a timer channel', () => {
    const ownerA = createCanvasPresentationOwner();
    const ownerB = createCanvasPresentationOwner();
    const apiA = createCanvasAPI(stageStore, { presentationOwner: ownerA });
    const apiB = createCanvasAPI(stageStore, { presentationOwner: ownerB });

    try {
      expect(apiA.highlight('scene-1', 'a1', { duration: 1_000 })).toMatchObject({
        success: true,
      });
      expect(apiB.highlight('scene-1', 'b1', { duration: 1_000 })).toMatchObject({
        success: true,
      });
      expect(apiA.highlight('scene-1', 'a2')).toMatchObject({ success: true });
      expect(apiB.highlight('scene-1', 'b2', { duration: 1_000 })).toMatchObject({
        success: true,
      });

      ownerB.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['a1']);
      ownerA.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);

      vi.advanceTimersByTime(1_000);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      ownerB.dispose();
      ownerA.dispose();
    }
  });

  it('restores the initial image across alternating owner/timer write combinations', () => {
    const disposalOrders = [
      [0, 1],
      [1, 0],
    ] as const;
    const elapsedBeforeDisposeCases = [0, 60_000] as const;

    for (const writerIndexes of alternatingOwnerCases) {
      for (const timerPattern of alternatingTimerCases) {
        for (const disposalOrder of disposalOrders) {
          for (const elapsedBeforeDispose of elapsedBeforeDisposeCases) {
            const owners = [createCanvasPresentationOwner(), createCanvasPresentationOwner()];
            const apis = owners.map((presentationOwner) =>
              createCanvasAPI(stageStore, { presentationOwner }),
            );

            try {
              for (const [writeIndex, ownerIndex] of writerIndexes.entries()) {
                expect(
                  apis[ownerIndex].highlight(
                    'scene-1',
                    `owner-${ownerIndex}-write-${writeIndex}`,
                    timerPattern[writeIndex] ? { duration: 60_000 } : {},
                  ),
                ).toMatchObject({ success: true });
              }

              vi.advanceTimersByTime(elapsedBeforeDispose);
              for (const ownerIndex of disposalOrder) owners[ownerIndex].dispose();
              expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
              vi.advanceTimersByTime(60_000);
              expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
            } finally {
              for (const owner of owners) owner.dispose();
              vi.clearAllTimers();
              useCanvasStore.getState().resetCanvasState();
            }
          }
        }
      }
    }
  });

  it('does not restart an expired timer when rolling back the same owner', () => {
    const owner = createCanvasPresentationOwner();
    const api = createCanvasAPI(stageStore, { presentationOwner: owner });
    let clearCount = 0;

    try {
      owner.claim('highlight');
      useCanvasStore.getState().setHighlight(['baseline']);
      owner.schedule('highlight', 40, () => {
        clearCount += 1;
        useCanvasStore.getState().clearHighlight();
      });
      const before = owner.capture();

      vi.advanceTimersByTime(10);
      expect(api.highlight('scene-1', 'temporary')).toMatchObject({ success: true });
      const expected = owner.capture();
      vi.advanceTimersByTime(40);

      const transitions: string[][] = [];
      const unsubscribe = useCanvasStore.subscribe((state, previous) => {
        if (state.highlightedElementIds !== previous.highlightedElementIds) {
          transitions.push([...state.highlightedElementIds]);
        }
      });
      try {
        expect(owner.restoreIfCurrent(before, expected)).toBe(true);
      } finally {
        unsubscribe();
      }

      expect(transitions).toEqual([[]]);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      expect(clearCount).toBe(1);
    } finally {
      owner.dispose();
    }
  });

  it('does not flash an expired timer when a covering owner is disposed', () => {
    const outerOwner = createCanvasPresentationOwner();
    const innerOwner = createCanvasPresentationOwner();
    const outerApi = createCanvasAPI(stageStore, { presentationOwner: outerOwner });
    const innerApi = createCanvasAPI(stageStore, { presentationOwner: innerOwner });

    try {
      expect(outerApi.highlight('scene-1', 'outer', { duration: 40 })).toMatchObject({
        success: true,
      });
      vi.advanceTimersByTime(10);
      expect(innerApi.highlight('scene-1', 'inner')).toMatchObject({ success: true });
      vi.advanceTimersByTime(40);

      const transitions: string[][] = [];
      const unsubscribe = useCanvasStore.subscribe((state, previous) => {
        if (state.highlightedElementIds !== previous.highlightedElementIds) {
          transitions.push([...state.highlightedElementIds]);
        }
      });
      try {
        innerOwner.dispose();
      } finally {
        unsubscribe();
      }

      expect(transitions).toEqual([[]]);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      innerOwner.dispose();
      outerOwner.dispose();
    }
  });

  it('clears a channel whose foreign baseline timer expired before it was covered', () => {
    const timedOwner = createCanvasPresentationOwner();
    const coveringOwner = createCanvasPresentationOwner();
    const timedApi = createCanvasAPI(stageStore, { presentationOwner: timedOwner });
    const coveringApi = createCanvasAPI(stageStore, { presentationOwner: coveringOwner });
    const geometry = { x: 0, y: 0, w: 0, h: 0, centerX: 0, centerY: 0 };

    try {
      expect(timedApi.highlight('scene-1', 'timed', { duration: 40 })).toMatchObject({
        success: true,
      });
      expect(coveringApi.setZoom('scene-1', 'zoomed', geometry, 2)).toMatchObject({
        success: true,
      });

      vi.advanceTimersByTime(40);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      expect(coveringApi.highlight('scene-1', 'covering')).toMatchObject({ success: true });

      coveringOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      timedOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      coveringOwner.dispose();
      timedOwner.dispose();
    }
  });

  it('rejects timer snapshots that omit the absolute deadline', () => {
    const owner = createCanvasPresentationOwner();

    try {
      owner.claim('highlight');
      useCanvasStore.getState().setHighlight(['baseline']);
      owner.schedule('highlight', 100, () => useCanvasStore.getState().clearHighlight());
      const invalidSnapshot = owner.capture();
      delete invalidSnapshot.timerDeadlines?.highlight;

      expect(() => owner.restore(invalidSnapshot)).toThrow(
        'Canvas highlight timer snapshot is missing an absolute deadline',
      );
    } finally {
      owner.dispose();
    }
  });

  it('can cover and resume a retained timer after its owner is disposed', () => {
    const canonicalOwner = createCanvasPresentationOwner();
    const temporaryOwner = createCanvasPresentationOwner();
    const canonicalApi = createCanvasAPI(stageStore, { presentationOwner: canonicalOwner });
    const temporaryApi = createCanvasAPI(stageStore, { presentationOwner: temporaryOwner });

    try {
      canonicalOwner.claim('highlight');
      useCanvasStore.getState().setHighlight(['canonical']);
      canonicalOwner.schedule('highlight', 100, () => useCanvasStore.getState().clearHighlight());
      vi.advanceTimersByTime(10);
      canonicalOwner.beginMutation();
      canonicalApi.highlight('scene-1', 'owner-temporary');
      canonicalOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['canonical']);

      vi.advanceTimersByTime(10);
      temporaryApi.highlight('scene-1', 'nested-temporary');
      temporaryOwner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['canonical']);

      vi.advanceTimersByTime(79);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['canonical']);
      vi.advanceTimersByTime(1);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      temporaryOwner.dispose();
      canonicalOwner.dispose();
    }
  });

  it('captures direct Stage API canvas writes in the presentation baseline', () => {
    const presentationStore = createStagePresentationStore({ fence: false });
    const api = createCanvasAPI(presentationStore, {
      presentationOwner: presentationStore.presentation.canvas,
    });

    try {
      expect(api.highlight('scene-1', 'element-1')).toMatchObject({ success: true });
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['element-1']);

      presentationStore.presentation.restore();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      expect(useCanvasStore.getState().highlightOptions).toBeNull();
    } finally {
      presentationStore.presentation.dispose();
    }
  });

  it('settles the owner image when an auto-clear callback throws', () => {
    const owner = createCanvasPresentationOwner();
    const before = owner.capture();

    try {
      owner.beginMutation();
      owner.claim('highlight');
      useCanvasStore.getState().setHighlight(['element-1']);
      owner.schedule('highlight', 100, () => {
        throw new Error('clear failed');
      });
      owner.endMutation();

      expect(() => vi.advanceTimersByTime(100)).toThrow('clear failed');
      // The timer slot is removed even though the clear operation failed;
      // dispose must therefore still be able to compensate the visible image.
      expect(owner.capture().timerRemainingMs.highlight).toBeUndefined();

      owner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(before.highlightedElementIds);
      expect(useCanvasStore.getState().highlightOptions).toEqual(before.highlightOptions);
    } finally {
      owner.dispose();
    }
  });

  it('does not cancel another owner timer during a stage-only restore', () => {
    const externalOwner = createCanvasPresentationOwner();
    const externalApi = createCanvasAPI(stageStore, { presentationOwner: externalOwner });
    const presentationStore = createStagePresentationStore({ fence: false });

    try {
      expect(externalApi.highlight('scene-1', 'external', { duration: 1_000 })).toMatchObject({
        success: true,
      });

      // A stage-only action still opens the shared presentation transaction,
      // but does not own the already-running highlight channel.
      presentationStore.presentation.canvas.beginMutation();
      presentationStore.presentation.canvas.endMutation();
      presentationStore.setState({ currentSceneId: 'presentation-scene' });
      presentationStore.presentation.restore();

      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['external']);
      vi.advanceTimersByTime(1_000);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
    } finally {
      presentationStore.presentation.dispose();
      externalOwner.dispose();
    }
  });

  it('tracks zoom ownership and keeps editor pick mode outside presentation cleanup', () => {
    const owner = createCanvasPresentationOwner();
    const api = createCanvasAPI(stageStore, { presentationOwner: owner });
    const pickTarget = { sceneId: 'scene-1', actionId: 'action-1', cueType: 'highlight' };

    try {
      useCanvasStore.getState().setPickTarget(pickTarget);
      expect(
        api.setZoom('scene-1', 'element-1', { x: 0, y: 0, w: 0, h: 0, centerX: 0, centerY: 0 }, 2),
      ).toMatchObject({ success: true });
      expect(useCanvasStore.getState().zoomTarget).toEqual({ elementId: 'element-1', scale: 2 });

      expect(api.clearAllEffects('scene-1')).toMatchObject({ success: true });
      expect(useCanvasStore.getState().zoomTarget).toBeNull();
      expect(useCanvasStore.getState().pickTarget).toEqual(pickTarget);
    } finally {
      owner.dispose();
    }
  });

  it('keeps the laser channel when clearing highlights', () => {
    const owner = createCanvasPresentationOwner();
    const api = createCanvasAPI(stageStore, { presentationOwner: owner });
    const geometry = { x: 0, y: 0, w: 0, h: 0, centerX: 0, centerY: 0 };

    try {
      expect(api.highlight('scene-1', 'highlight')).toMatchObject({ success: true });
      expect(api.spotlight('scene-1', 'spotlight')).toMatchObject({ success: true });
      expect(api.setLaser('scene-1', 'laser', geometry)).toMatchObject({ success: true });

      expect(api.clearHighlights('scene-1')).toMatchObject({ success: true });
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      expect(useCanvasStore.getState().spotlightElementId).toBe('');
      expect(useCanvasStore.getState().laserElementId).toBe('laser');
    } finally {
      owner.dispose();
    }
  });

  it('restores video and whiteboard presentation channels independently', () => {
    const owner = createCanvasPresentationOwner();
    const before = owner.capture();

    try {
      owner.beginMutation();
      owner.claim('video');
      useCanvasStore.setState({ playingVideoElementId: 'video-1' });
      owner.claim('whiteboard');
      useCanvasStore.setState({ whiteboardOpen: true, whiteboardClearing: true });
      owner.endMutation();
      const expected = owner.capture();

      expect(expected.playingVideoElementId).toBe('video-1');
      expect(expected.whiteboardOpen).toBe(true);
      expect(expected.whiteboardClearing).toBe(true);
      expect(owner.restoreIfCurrent(before, expected)).toBe(true);
      expect(useCanvasStore.getState().playingVideoElementId).toBe(before.playingVideoElementId);
      expect(useCanvasStore.getState().whiteboardOpen).toBe(before.whiteboardOpen);
      expect(useCanvasStore.getState().whiteboardClearing).toBe(before.whiteboardClearing);
    } finally {
      owner.dispose();
    }
  });

  it('rejects a stale CAS when a newer owner writes the same zoom image', () => {
    const oldOwner = createCanvasPresentationOwner();
    const newOwner = createCanvasPresentationOwner();
    const before = oldOwner.capture();

    try {
      oldOwner.beginMutation();
      oldOwner.claim('zoom');
      useCanvasStore.getState().setZoom('same-element', 2);
      oldOwner.endMutation();
      const expected = oldOwner.capture();

      newOwner.beginMutation();
      newOwner.claim('zoom');
      useCanvasStore.getState().setZoom('same-element', 2);
      newOwner.endMutation();

      expect(oldOwner.restoreIfCurrent(before, expected)).toBe(false);
      expect(useCanvasStore.getState().zoomTarget).toEqual({ elementId: 'same-element', scale: 2 });
    } finally {
      oldOwner.dispose();
      newOwner.dispose();
    }
  });

  it('restores only its own channel when another owner changes a different channel', () => {
    const owner = createCanvasPresentationOwner();
    const otherOwner = createCanvasPresentationOwner();
    const api = createCanvasAPI(stageStore, { presentationOwner: owner });
    const otherApi = createCanvasAPI(stageStore, { presentationOwner: otherOwner });
    const before = owner.capture();

    try {
      expect(api.highlight('scene-1', 'owned')).toMatchObject({ success: true });
      const expected = owner.capture();
      expect(
        otherApi.setZoom('scene-1', 'other', { x: 0, y: 0, w: 0, h: 0, centerX: 0, centerY: 0 }, 2),
      ).toMatchObject({ success: true });

      expect(owner.restoreIfCurrent(before, expected)).toBe(true);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      expect(useCanvasStore.getState().zoomTarget).toEqual({ elementId: 'other', scale: 2 });
    } finally {
      owner.dispose();
      otherOwner.dispose();
    }
  });

  it('does not absorb a newer channel image into expected state during later mutations', () => {
    const oldOwner = createCanvasPresentationOwner();
    const newOwner = createCanvasPresentationOwner();
    const oldApi = createCanvasAPI(stageStore, { presentationOwner: oldOwner });
    const newApi = createCanvasAPI(stageStore, { presentationOwner: newOwner });

    try {
      expect(oldApi.highlight('scene-1', 'old')).toMatchObject({ success: true });
      expect(newApi.highlight('scene-1', 'new')).toMatchObject({ success: true });

      // The superseded owner later mutates a different channel. Its expected
      // image must not learn the newer spotlight/highlight image as a side
      // effect of that mutation.
      oldOwner.beginMutation();
      oldOwner.claim('video');
      useCanvasStore.setState({ playingVideoElementId: 'old-video' });
      oldOwner.endMutation();
      oldOwner.dispose();

      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['new']);
      expect(useCanvasStore.getState().playingVideoElementId).toBe('');
    } finally {
      oldOwner.dispose();
      newOwner.dispose();
    }
  });

  it('keeps a restored baseline timer alive after the temporary owner is disposed', () => {
    const owner = createCanvasPresentationOwner();
    const api = createCanvasAPI(stageStore, { presentationOwner: owner });
    let clearCount = 0;

    try {
      // Seed a timer before the baseline is captured. This models a retained
      // canonical presentation image that must continue auto-clearing after
      // the temporary owner hands it back and is disposed.
      owner.claim('highlight');
      useCanvasStore.getState().setHighlight(['baseline']);
      owner.schedule('highlight', 1_000, () => {
        clearCount += 1;
        useCanvasStore.getState().clearHighlight();
      });
      vi.advanceTimersByTime(100);
      owner.beginMutation();
      expect(api.highlight('scene-1', 'temporary')).toMatchObject({ success: true });

      owner.dispose();
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['baseline']);

      vi.advanceTimersByTime(899);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual(['baseline']);
      vi.advanceTimersByTime(1);
      expect(useCanvasStore.getState().highlightedElementIds).toEqual([]);
      expect(clearCount).toBe(1);
    } finally {
      owner.dispose();
    }
  });
});
