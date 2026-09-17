'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAssetUrls } from '@/lib/media/use-asset-url';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { resolveMediaTaskForRef } from '@/lib/media/media-task-resolution';
import { createLogger } from '@/lib/logger';
import {
  htmlMediaReferences,
  iframeSafeMediaUrl,
  isParentBlobUrl,
  parentBlobUrlsInHtml,
  replaceHtmlMediaReferences,
  UNRESOLVED_HTML_MEDIA_SRC,
} from './media';

const log = createLogger('HtmlMedia');

function blobReplacementKey(urls: Readonly<Record<string, string>>): string {
  return Object.entries(urls)
    .filter(([, url]) => isParentBlobUrl(url))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, url]) => `${ref}\t${url}`)
    .join('\n');
}

function useIframeSafeMediaUrls(
  urls: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const blobKey = blobReplacementKey(urls);
  const [inlined, setInlined] = useState<Record<string, { source: string; url: string }>>({});
  const settled = useRef<Readonly<Record<string, string>> | null>(null);

  useEffect(() => {
    if (!blobKey) return;
    let cancelled = false;
    const targets = blobKey.split('\n').map((line) => {
      const split = line.indexOf('\t');
      return [line.slice(0, split), line.slice(split + 1)] as const;
    });
    void Promise.all(
      targets.map(async ([ref, url]) => {
        try {
          return [ref, { source: url, url: await iframeSafeMediaUrl(url) }] as const;
        } catch (error) {
          log.warn('Could not resolve media for the classroom iframe:', error);
          return [ref, { source: url, url: UNRESOLVED_HTML_MEDIA_SRC }] as const;
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setInlined(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [blobKey]);

  if (!blobKey) {
    settled.current = null;
    return urls;
  }
  const next = { ...urls };
  let pending = false;
  for (const [ref, url] of Object.entries(next)) {
    if (!isParentBlobUrl(url)) continue;
    if (inlined[ref]?.source === url) next[ref] = inlined[ref].url;
    else pending = true;
  }
  // A placeholder srcDoc reloads the keep-alive iframe and drops in-flight
  // HIGHLIGHT/REVEAL/ANNOTATE. Hold the last iframe-safe mapping until bytes
  // inline; first paint leaves blob: URLs so the host can withhold mount.
  if (pending) return settled.current ?? urls;
  settled.current = next;
  return next;
}

export function useResolvedHtml(html: string, explicitStageId?: string): string {
  const contextStageId = useMediaStageId();
  const stageId = explicitStageId ?? contextStageId;
  const tasks = useMediaGenerationStore((state) => state.tasks);
  const refs = useMemo(
    () =>
      [...new Set(htmlMediaReferences(html).map(({ ref }) => ref))].filter(
        (ref) => !isConcreteMediaAddress(ref),
      ),
    [html],
  );
  const urls = useAssetUrls(refs);
  const replacements: Record<string, string> = { ...urls };
  for (const ref of refs) {
    if (replacements[ref]) continue;
    const task = resolveMediaTaskForRef(tasks, ref, stageId);
    if (task?.status === 'done' && task.objectUrl) {
      replacements[ref] = task.objectUrl;
      continue;
    }
    // Opaque ids must not become `/classroom/<id>` network requests.
    replacements[ref] = UNRESOLVED_HTML_MEDIA_SRC;
  }
  // Parent blob: URLs are origin-locked. Identity-map them so the iframe-safe
  // pass inlines bytes as data: URLs, including copies sitting in CSS/JS.
  for (const blob of parentBlobUrlsInHtml(html)) {
    if (!replacements[blob]) replacements[blob] = blob;
  }
  const iframeSafe = useIframeSafeMediaUrls(replacements);
  let result = replaceHtmlMediaReferences(html, iframeSafe);
  for (const blob of parentBlobUrlsInHtml(html)) {
    const next = iframeSafe[blob];
    if (next && next !== blob) result = result.split(blob).join(next);
  }
  return result;
}
