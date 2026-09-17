/**
 * Browser execution for A5.2 course covers.
 * Calls `/api/generate/image`, stores the blob in the asset pool, and writes
 * `Stage.coverAssetId`. Failures are swallowed by the caller so generation continues.
 */

import { putAsset } from '@/lib/media/asset-pool';
import { markStagePersistenceDirty, useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { isStageWriteStale, stageDeletionEpoch } from '@/lib/utils/deleted-stages';
import { createLogger } from '@/lib/logger';
import {
  COURSE_COVER_ASPECT_RATIO,
  resolveCoverPrompt,
  shouldGenerateCourseCover,
} from './course-cover';

const log = createLogger('CourseCover');

export async function generateAndPersistCourseCover(options: {
  stageId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { stageId, signal } = options;
  const settings = useSettingsStore.getState();
  const state = useStageStore.getState();
  if (state.stage?.id !== stageId) return;
  if (
    !shouldGenerateCourseCover({
      imageGenerationEnabled: settings.imageGenerationEnabled === true,
      coverAssetId: state.stage.coverAssetId,
    })
  ) {
    return;
  }

  const visualStyle = state.lessonPlan?.presentation?.visualStyle?.trim() ?? '';
  const prompt = resolveCoverPrompt(state.lessonPlan?.presentation?.coverPrompt, {
    courseTitle: state.stage.name,
    visualStyle,
    language: state.stage.languageDirective,
  });
  if (!prompt || signal?.aborted) return;

  const capturedEpoch = stageDeletionEpoch(stageId);
  const blob = await requestCoverImage(prompt, signal);
  if (signal?.aborted || isStageWriteStale(stageId, capturedEpoch)) return;

  const assetId = await putAsset(blob, {
    contentType: blob.type || 'image/png',
    mediaType: 'image',
    prompt,
    params: { aspectRatio: COURSE_COVER_ASPECT_RATIO },
  });
  if (signal?.aborted || isStageWriteStale(stageId, capturedEpoch)) return;

  const current = useStageStore.getState();
  if (current.stage?.id !== stageId || current.stage.coverAssetId) return;
  useStageStore.setState({
    stage: {
      ...current.stage,
      coverAssetId: assetId,
      coverPrompt: prompt,
      updatedAt: Date.now(),
    },
  });
  markStagePersistenceDirty([{ kind: 'stage' }]);
  log.info(`Stored course cover for ${stageId}`);
}

async function requestCoverImage(prompt: string, signal?: AbortSignal): Promise<Blob> {
  const settings = useSettingsStore.getState();
  const providerConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
  const response = await fetch('/api/generate/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-image-provider': settings.imageProviderId || '',
      'x-image-model': settings.imageModelId || '',
      'x-api-key': providerConfig?.apiKey || '',
      'x-base-url': providerConfig?.baseUrl || '',
    },
    body: JSON.stringify({
      prompt,
      aspectRatio: COURSE_COVER_ASPECT_RATIO,
    }),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    result?: { url?: string; base64?: string };
  };
  if (!response.ok || !data.success) {
    throw new Error(data.error || `Image API returned ${response.status}`);
  }
  const url =
    data.result?.url || (data.result?.base64 ? `data:image/png;base64,${data.result.base64}` : '');
  if (!url) throw new Error('No image URL in cover generation response');
  return fetchCoverBlob(url);
}

async function fetchCoverBlob(url: string): Promise<Blob> {
  if (url.startsWith('data:')) {
    const res = await fetch(url);
    return res.blob();
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetch('/api/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Proxy fetch failed: ${res.status}`);
    }
    return res.blob();
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch cover blob: ${res.status}`);
  return res.blob();
}
