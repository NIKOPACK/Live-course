'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAssetUrls } from '@/lib/media/use-asset-url';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { resolveMediaTaskForRef } from '@/lib/media/media-task-resolution';
import {
  htmlMediaReferences,
  iframeSafeMediaUrl,
  isParentBlobUrl,
  replaceHtmlMediaReferences,
  UNRESOLVED_HTML_MEDIA_SRC,
} from './media';

function blobReplacementKey(urls: Readonly<Record<string, string>>): string {
  return Object.entries(urls)
    .filter(([, url]) => isParentBlobUrl(url))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, url]) => `${ref}\t${url}`)
    .join('\n');
}

function useIframeSafeMediaUrls(urls: Readonly<Record<string, string>>): Record<string, string> {
  const blobKey = blobReplacementKey(urls);
  const [inlined, setInlined] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!blobKey) {
      setInlined({});
      return;
    }
    let cancelled = false;
    const targets = blobKey.split('\n').map((line) => {
      const split = line.indexOf('\t');
      return [line.slice(0, split), line.slice(split + 1)] as const;
    });
    void Promise.all(
      targets.map(async ([ref, url]) => {
        try {
          return [ref, await iframeSafeMediaUrl(url)] as const;
        } catch {
          return [ref, UNRESOLVED_HTML_MEDIA_SRC] as const;
        }
      }),
    ).then((pairs) => {
      if (!cancelled) setInlined(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [blobKey]);

  if (!blobKey) return urls as Record<string, string>;
  const next = { ...urls };
  for (const [ref, url] of Object.entries(next)) {
    if (isParentBlobUrl(url)) next[ref] = inlined[ref] ?? UNRESOLVED_HTML_MEDIA_SRC;
  }
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
  const replacements = { ...urls };
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
  const iframeSafe = useIframeSafeMediaUrls(replacements);
  return replaceHtmlMediaReferences(html, iframeSafe);
}
