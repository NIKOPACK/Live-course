'use client';

import { useMemo } from 'react';
import { useAssetUrls } from '@/lib/media/use-asset-url';
import { isConcreteMediaAddress } from '@/lib/media/resolve-media-ref';
import { useMediaStageId } from '@/lib/contexts/media-stage-context';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { resolveMediaTaskForRef } from '@/lib/media/media-task-resolution';
import { htmlMediaReferences, replaceHtmlMediaReferences } from './media';

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
    const task = resolveMediaTaskForRef(tasks, ref, stageId);
    if (!replacements[ref] && task?.status === 'done' && task.objectUrl) {
      replacements[ref] = task.objectUrl;
    }
  }
  return replaceHtmlMediaReferences(html, replacements);
}
