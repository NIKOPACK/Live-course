'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useStageStore } from '@/lib/store';
import { isCurrentSceneEditable } from '@/lib/edit/stage-mode';
import { isLiveCourseEditorEnabled } from '@/lib/config/feature-flags';
import { EditChromeRoot } from '@/components/edit/EditChromeRoot';
import {
  PlaybackChromeRoot,
  type PlaybackChromeRootHandle,
} from '@/components/edit/PlaybackChromeRoot';
import { useEditModeLock } from '@/components/edit/use-edit-mode-lock';
import { MultiTabEditConflictPrompt } from '@/components/edit/MultiTabEditConflictPrompt';
import { InteractiveIframeHost } from '@/components/scene-renderers/InteractiveIframeHost';
import { CHROME_EASE } from '@/lib/edit/transitions';
import { preloadEditor } from '@/lib/edit/preload-editor';
import { createStagePresentationStore } from '@/lib/api/stage-api';
import type { StagePresentationStore } from '@/lib/api/stage-api';
import type { ReplayPresentationBridge } from '@/components/livecourse/ReplayPresentationBoundary';

/**
 * Stage — top-level classroom container. Dispatches between the two
 * chrome roots based on `useStageStore.mode`:
 *
 *   mode === 'edit'                → EditChromeRoot
 *   mode === 'playback' / 'autonomous' → PlaybackChromeRoot
 *
 * The two roots are wholly independent. Stage's only responsibilities
 * are: mode dispatch, edit-lock coordination (cross-tab), Pro Switch
 * toggle wiring (calls into PlaybackChromeRoot.teardown via ref before
 * flipping mode), and rendering the cross-tab conflict prompt (which
 * needs to be mountable from playback mode too, since the lock-conflict
 * dialog can surface when Pro Switch is clicked but acquire fails).
 */
export function Stage({
  onRetryOutline,
  presentationOnly = false,
  presentationStore: providedPresentationStore,
  replayBridge,
}: {
  onRetryOutline?: (outlineId: string) => Promise<void>;
  /** Route playback mutations through a non-persisting presentation adapter. */
  presentationOnly?: boolean;
  /** Shared adapter owned by the replay boundary (keeps all surfaces on one journal). */
  presentationStore?: StagePresentationStore;
  replayBridge?: ReplayPresentationBridge;
}) {
  const { mode, setMode, scenes, currentSceneId, generatingOutlines, stage } = useStageStore();
  const currentScene = useStageStore((s) => s.getCurrentScene());

  // Predicate for "can the user enter Pro mode for the current scene?".
  // Single source of truth feeds the Header's Pro Switch state and the
  // auto-exit effect below; keeping them in lock-step prevents an
  // edit-mode entry that would immediately auto-exit.
  const isEditable = isCurrentSceneEditable({
    currentSceneId,
    sceneCount: scenes.length,
    generatingOutlineCount: generatingOutlines.length,
    hasCurrentScene: !!currentScene,
  });

  // Cross-tab edit lock (#571). Lives at this layer because entry must
  // be refused BEFORE the live session is torn down; PlaybackChromeRoot
  // can't own this since it can't refuse its own unmount path.
  const editLock = useEditModeLock(stage?.id);

  const playbackRef = useRef<PlaybackChromeRootHandle>(null);
  const ownedPresentationStore = useMemo<StagePresentationStore | undefined>(
    // This adapter is created during render and a concurrent render may be
    // abandoned. Replay normally passes a boundary-owned adapter; the lazy
    // fallback keeps standalone presentation callers safe without acquiring a
    // persistence lease until their first mutation.
    () =>
      presentationOnly && !providedPresentationStore
        ? createStagePresentationStore({ fence: 'lazy' })
        : undefined,
    [presentationOnly, providedPresentationStore],
  );
  const presentationStore = providedPresentationStore ?? ownedPresentationStore;

  // The replay boundary owns a shared adapter and disposes it after the Host
  // has torn down its controller. Only dispose the private fallback here.
  // Cleanup is deferred through a microtask and guarded by both adapter
  // identity and an effect generation. This handles a real prop transition
  // (old fallback → new fallback/provided store) as well as React StrictMode's
  // synthetic setup→cleanup→setup without leaking or disposing the replacement.
  const ownedPresentationStoreRef = useRef<StagePresentationStore | null>(null);
  const ownedPresentationEffectGenerationRef = useRef(0);
  useEffect(() => {
    const generation = ++ownedPresentationEffectGenerationRef.current;
    const store = ownedPresentationStore;
    ownedPresentationStoreRef.current = store ?? null;
    if (!store) return;
    return () => {
      queueMicrotask(() => {
        const sameStore = ownedPresentationStoreRef.current === store;
        // The latest generation is intentionally read at cleanup time: a
        // changed value is the signal that StrictMode re-installed this same
        // adapter and that this cleanup is synthetic.
        const isCurrentEffect =
          sameStore &&
          // eslint-disable-next-line react-hooks/exhaustive-deps
          ownedPresentationEffectGenerationRef.current === generation;
        // If a different fallback has already been installed, this store is
        // unquestionably abandoned and must be released immediately. If the
        // same store was re-installed by StrictMode, the generation changed
        // and the synthetic cleanup is ignored.
        if ((!sameStore || isCurrentEffect) && !store.presentation.isDisposed()) {
          store.presentation.dispose();
          if (isCurrentEffect) ownedPresentationStoreRef.current = null;
        }
      });
    };
  }, [ownedPresentationStore]);

  // Pro Switch handler. Edit→playback is a plain flip (PlaybackChromeRoot
  // will mount fresh; its engine effect re-inits). Playback→edit must
  // (1) refuse on lock conflict, (2) await SSE / engine / TTS teardown
  // so PlaybackChromeRoot is quiescent before it unmounts.
  const handleToggleEditMode = useCallback(async () => {
    if (presentationOnly) return;
    if (mode === 'edit') {
      setMode('playback');
      return;
    }
    if (!editLock.acquire()) return;
    // Load the editor chunk (fonts + slide surface) BEFORE flipping mode,
    // so the edit chrome animates in with its content already present and
    // the slide surface registered — no mid-animation pop-in / NOOP flash.
    // Runs concurrently with teardown; the import is promise-cached so it's
    // a no-op on subsequent toggles.
    const editorLoad = preloadEditor();
    try {
      await Promise.all([playbackRef.current?.teardown(), editorLoad]);
    } catch (err) {
      // Teardown failed after the cross-tab lock was acquired but before we
      // flipped into edit mode. Release the lock we just took: otherwise it
      // stays HELD while mode stays 'playback', and the release effect (keyed
      // on `mode`) never re-fires, stranding the lock until tab close and
      // blocking this and every other tab from Pro mode. Stay in playback so
      // the failure surfaces rather than half-entering edit mode.
      editLock.release();
      console.error('[Stage] Pro mode entry failed during teardown', err);
      return;
    }
    setMode('edit');
  }, [editLock, mode, presentationOnly, setMode]);

  // Auto-exit edit mode when the current scene becomes uneditable
  // (pending generation, no scenes, currently generating).
  useEffect(() => {
    if (mode === 'edit' && (presentationOnly || !isEditable)) {
      setMode('playback');
    }
  }, [mode, isEditable, presentationOnly, setMode]);

  // Release the lock whenever we're not in edit mode (covers manual
  // exit, auto-exit, scene becomes uneditable). The hook also self-
  // releases on unmount / tab close.
  const releaseEditLock = editLock.release;
  useEffect(() => {
    if (mode !== 'edit') releaseEditLock();
  }, [mode, releaseEditLock]);

  const editorEnabled = isLiveCourseEditorEnabled();
  const toggleHandler = editorEnabled && !presentationOnly ? handleToggleEditMode : undefined;
  const showEditChrome = !presentationOnly && editorEnabled && mode === 'edit' && !!currentScene;

  // Mode swap choreography — a clean opacity cross-fade. Both roots layer
  // via `absolute inset-0` so they coexist for the ~280ms window without
  // one popping out before the other arrives. The outgoing root keeps
  // rendering its canvas during exit so `canvasStore` (the shared scale
  // writer) doesn't briefly read zero.
  //
  // Deliberately NO transform (translateY) on these layers: the edit
  // chrome hosts the Pro Switch / settings pill, which morph across the
  // swap via `layoutId`. A transform on this ancestor distorts motion's
  // layout measurement (the pill visibly drifts) and the blurred chrome
  // would repaint its backdrop-filter every frame while translating. A
  // pure fade keeps layout static so the shared elements land precisely.
  return (
    <div className="relative flex flex-1 overflow-hidden">
      <AnimatePresence initial={false}>
        {showEditChrome ? (
          <motion.div
            key="edit"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: CHROME_EASE }}
            className="absolute inset-0 flex"
          >
            <EditChromeRoot
              scene={currentScene}
              isEditable={isEditable}
              onToggleEditMode={toggleHandler}
            />
          </motion.div>
        ) : (
          <motion.div
            key="playback"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: CHROME_EASE }}
            className="absolute inset-0 flex"
          >
            <PlaybackChromeRoot
              ref={playbackRef}
              onRetryOutline={onRetryOutline}
              presentationOnly={presentationOnly}
              presentationStore={presentationStore}
              replayBridge={replayBridge}
              canEnterProMode={isEditable && !presentationOnly}
              onEnterProMode={toggleHandler}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <MultiTabEditConflictPrompt
        open={editLock.conflictOpen}
        onDismiss={editLock.dismissConflict}
      />
      {/* Keep-alive host for interactive scene iframes (#619). Lives here, above
          the mode-swap subtree, so its iframes survive Pro mode toggles and
          scene switches instead of reloading on every remount. */}
      <InteractiveIframeHost />
    </div>
  );
}
