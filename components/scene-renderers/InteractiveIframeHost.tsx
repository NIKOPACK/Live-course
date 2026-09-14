'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import {
  useInteractiveIframePool,
  type IframePoolEntry,
} from '@/lib/store/interactive-iframe-pool';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';
import { useI18n } from '@/lib/hooks/use-i18n';

/**
 * Stable host for interactive scene iframes (#619).
 *
 * Mounted once at the `Stage` root — outside the mode-swap / scene subtree that
 * unmounts and remounts — so the iframe elements it renders survive Pro mode
 * toggles, scene switches, and any PlaybackChromeRoot remount. The in-tree
 * `InteractiveRenderer` is only a placeholder that registers content and reports
 * the on-screen rect; the actual iframes live here, portaled into a stable host
 * node and positioned over each scene's rect via `position: fixed`.
 *
 * Portal target follows `document.fullscreenElement` so the iframe stays inside
 * the fullscreen subtree during presentation mode (which calls requestFullscreen
 * on the playback stage, not on body); otherwise it lives on `document.body`.
 * A low z-index keeps it under Radix dialogs (e.g. the scene-switch confirm)
 * while still covering the canvas box during interactive playback AND Pro-mode
 * editing — the editor agent fixes interactive HTML, so the teacher must see the
 * live page while editing. Visibility is driven by the placeholder's ownership
 * (gone → hidden, never unmounted), so the document is preserved for a
 * zero-reload return.
 */
export function InteractiveIframeHost() {
  const entries = useInteractiveIframePool((s) => s.entries);
  const activeSceneId = useInteractiveIframePool((s) => s.activeSceneId);
  const reset = useInteractiveIframePool((s) => s.reset);
  const setActiveScene = useWidgetIframeStore((s) => s.setActiveScene);

  // Portal into the fullscreen element when one is active (presentation mode
  // fullscreens the stage, and a body-portaled iframe would not be part of that
  // subtree, so it would vanish). Falls back to body otherwise.
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  useEffect(() => {
    const sync = () => setPortalTarget(document.fullscreenElement ?? document.body);
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // Keep the messaging store's active scene in lock-step (its legacy fallback
  // path resolves the current widget by active scene when no id is passed).
  useEffect(() => {
    setActiveScene(activeSceneId);
  }, [activeSceneId, setActiveScene]);

  // The host is mounted once per classroom (inside Stage). When it unmounts —
  // e.g. on classroom switch — drop the pool so a new classroom doesn't briefly
  // render the previous one's stale iframes.
  useEffect(() => reset, [reset]);

  if (!portalTarget) return null;

  return createPortal(
    <>
      {Object.entries(entries).map(([sceneId, entry]) => (
        <PooledIframe
          key={sceneId}
          sceneId={sceneId}
          entry={entry}
          visible={entry.owner !== null && sceneId === activeSceneId}
        />
      ))}
    </>,
    portalTarget,
  );
}

interface PooledIframeProps {
  readonly sceneId: string;
  readonly entry: IframePoolEntry;
  readonly visible: boolean;
}

/**
 * One persisted iframe. Stays mounted as long as its pool entry exists (only
 * evicted by LRU), so its document is preserved across scene/mode changes.
 * `srcDoc` / `src` come straight from the entry and only change when the
 * content changes — that is the single intended reload path.
 *
 * Security: the sandbox intentionally omits `allow-same-origin`.
 * Combining `allow-scripts` with `allow-same-origin` on a srcDoc iframe
 * effectively negates sandbox protections — the embedded document is treated
 * as same-origin with the parent and can access cookies, localStorage, and
 * the parent DOM. Since the HTML may originate from LLM output or imported
 * classroom JSON, keeping the iframe in a unique (null) origin prevents
 * any embedded script from reaching the host application's state.
 * postMessage communication (the only parent↔iframe channel used here)
 * works correctly with a null origin because the host sends with
 * targetOrigin='*'.
 */
function PooledIframe({ sceneId, entry, visible }: PooledIframeProps) {
  const { t } = useI18n();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const runtimeError = useSceneRuntimeErrors((state) => state.errors[sceneId]?.[0]);
  const registerIframe = useWidgetIframeStore((s) => s.registerIframe);

  // Register the postMessage callback for this scene (moved here from the
  // placeholder, since the iframe now lives in the host). Stable per scene:
  // the callback reads contentWindow lazily at send time.
  useEffect(() => {
    if (!entry.interactionEnabled) {
      // Do not expose a command channel to replayed widgets. This keeps any
      // presentation-only consumer from sending parent actions even if it
      // accidentally asks the legacy widget store for a callback.
      registerIframe(sceneId, null);
      return;
    }
    const send = (type: string, payload: Record<string, unknown>) => {
      iframeRef.current?.contentWindow?.postMessage({ type, ...payload }, '*');
    };
    registerIframe(sceneId, send);
    return () => registerIframe(sceneId, null);
  }, [entry.interactionEnabled, sceneId, registerIframe]);

  // Capture runtime errors the iframe's error shim posts out (see iframe.ts), so
  // the editor agent can diagnose a blank/broken page. Matched to THIS iframe by
  // event.source (sandboxed null-origin iframes still postMessage to the parent).
  //
  // The errors that matter most (a JSON.parse that aborts setup) fire while srcDoc
  // parses — possibly BEFORE this passive effect subscribes. The shim buffers every
  // error and re-emits it on request, so after subscribing we ask for a replay to
  // recover anything posted pre-subscription. Re-subscribed per document version
  // (entry.srcDoc) so each fresh page gets its own replay request; addError dedups
  // the live + replayed copies. iframeRef is read lazily, so the handler is stable.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as
        | {
            __livecourseInteractive?: boolean;
            kind?: string;
            errorKind?: string;
            message?: unknown;
          }
        | undefined;
      if (!d || d.__livecourseInteractive !== true || d.kind !== 'runtime-error') return;
      const kind = typeof d.errorKind === 'string' ? d.errorKind : 'error';
      const msg = typeof d.message === 'string' ? d.message : String(d.message ?? '');
      useSceneRuntimeErrors.getState().addError(sceneId, `[${kind}] ${msg}`);
    };
    window.addEventListener('message', onMessage);
    iframeRef.current?.contentWindow?.postMessage({ __livecourseErrorReplayRequest: true }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [sceneId, entry.srcDoc, reloadVersion]);

  // A replay can reuse an iframe that was interactive during teaching. Blur it
  // when switching to presentation-only mode so a previously focused embedded
  // control cannot continue receiving keyboard input while pointer events are
  // disabled.
  useEffect(() => {
    if (!entry.interactionEnabled && document.activeElement === iframeRef.current) {
      iframeRef.current?.blur();
    }
  }, [entry.interactionEnabled]);

  // A content change reloads the iframe; drop the previous render's errors so the
  // captured set reflects the CURRENT page (e.g. after the agent applies a fix).
  useEffect(() => {
    useSceneRuntimeErrors.getState().clearScene(sceneId);
  }, [sceneId, entry.srcDoc, reloadVersion]);

  const rect = entry.rect;
  // Require a real measured box before showing — a null or zero-size rect means
  // the slot hasn't laid out yet; showing then would flash a 0x0 iframe pinned
  // at the viewport origin.
  const shown = visible && rect !== null && rect.width > 0 && rect.height > 0;
  const style: CSSProperties = {
    position: 'fixed',
    left: rect?.left ?? 0,
    top: rect?.top ?? 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    border: 0,
    borderRadius: '0.5rem', // matches the canvas box's rounded-lg
    overflow: 'hidden',
    zIndex: 1,
    // visibility (not display) — display:none can drop the document on re-show.
    visibility: shown ? 'visible' : 'hidden',
    pointerEvents: shown && entry.interactionEnabled ? 'auto' : 'none',
  };

  return (
    <>
      <iframe
        key={reloadVersion}
        ref={iframeRef}
        srcDoc={entry.srcDoc}
        src={entry.srcDoc ? undefined : entry.src}
        style={style}
        title={`Interactive Scene ${sceneId}`}
        aria-hidden={!entry.interactionEnabled}
        inert={!entry.interactionEnabled}
        tabIndex={entry.interactionEnabled ? undefined : -1}
        sandbox="allow-scripts"
        onLoad={() =>
          iframeRef.current?.contentWindow?.postMessage(
            { __livecourseErrorReplayRequest: true },
            '*',
          )
        }
      />
      {shown && runtimeError ? (
        <div
          role="alert"
          className="rounded-lg border bg-background p-3 text-sm shadow"
          style={{
            ...style,
            height: 'auto',
            maxHeight: rect?.height,
            overflow: 'auto',
            zIndex: 2,
            pointerEvents: 'auto',
          }}
        >
          <p>{t('htmlClassroom.runtimeFailed')}</p>
          <p className="break-words text-xs text-muted-foreground">{runtimeError}</p>
          <button
            type="button"
            className="underline"
            onClick={() => setReloadVersion((value) => value + 1)}
          >
            {t('htmlClassroom.retryPage')}
          </button>
        </div>
      ) : null}
    </>
  );
}
