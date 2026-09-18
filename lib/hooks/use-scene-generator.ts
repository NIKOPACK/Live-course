'use client';

import { useCallback, useRef } from 'react';
import { markStagePersistenceDirty, useStageStore } from '@/lib/store/stage';
import { isSceneEditLocked } from '@/lib/edit/regen-lock';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { useSettingsStore } from '@/lib/store/settings';
import { db } from '@/lib/utils/database';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  UserRequirements,
} from '@/lib/types/generation';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type { LessonNodeDesign, LessonPresentation } from '@/lib/livecourse/domain/schemas';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';
import { measureAudioDuration } from '@/lib/audio/audio-duration';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { isLiveCourseTTSEnabled } from '@/lib/config/feature-flags';
import { resolveAgentVoiceOptions, pickNarratorAgent } from '@/lib/audio/agent-voice';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  generateMediaForOutlines,
  reconcileCompletedMediaForScene,
} from '@/lib/media/media-orchestrator';
import { generateAndPersistCourseCover } from '@/lib/livecourse/lesson/course-cover-runtime';
import { putAsset, removeAsset, replaceAsset } from '@/lib/media/asset-pool';
import { lazyBoundedMap } from '@/lib/utils/concurrency';
import { createLogger } from '@/lib/logger';
import {
  isAbortError,
  withGenerationRetry,
  type GenerationRetryOptions,
} from '@/lib/generation/generation-retry';

const log = createLogger('SceneGenerator');

function addGeneratedScene(scene: Scene): void {
  const state = useStageStore.getState();
  if (!state.stage || scene.stageId !== state.stage.id) {
    state.addScene(scene);
    return;
  }
  const reconciled = reconcileCompletedMediaForScene(scene, state.stage);
  if (reconciled.stage !== state.stage) {
    useStageStore.setState({ stage: reconciled.stage });
    markStagePersistenceDirty([{ kind: 'stage' }]);
  }
  useStageStore.getState().addScene(reconciled.scene);
}

/**
 * A1：从持久化教案里取该大纲节点的讲授设计（docs/spec/04 §5：逐段内容生成
 * 以教案节点为输入，不再只看大纲条目）。按 sceneId 匹配，order 兜底；没有
 * 教案的旧流程返回 undefined，内容生成只读大纲。
 */
function lessonNodeDesignForOutline(outline: SceneOutline): LessonNodeDesign | undefined {
  const lessonPlan = useStageStore.getState().lessonPlan;
  return lessonPlan?.nodes.find(
    (node) => node.sceneId === outline.id || node.order === outline.order,
  )?.design;
}

interface SceneContentResult {
  success: boolean;
  content?: unknown;
  effectiveOutline?: SceneOutline;
  error?: string;
  errorCode?: string;
  statusCode?: number;
  isRetryable?: boolean;
}

interface SceneActionsResult {
  success: boolean;
  scene?: Scene;
  previousSpeeches?: string[];
  error?: string;
  errorCode?: string;
  statusCode?: number;
}

type ClientRetryOptions<T> = Partial<
  Omit<GenerationRetryOptions<T>, 'label' | 'shouldRetryResult' | 'signal'>
>;

function getApiHeaders(): HeadersInit {
  const config = getCurrentModelConfig();
  const settings = useSettingsStore.getState();
  const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
  const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];

  return {
    'Content-Type': 'application/json',
    'x-model': config.modelString || '',
    'x-api-key': config.apiKey || '',
    'x-base-url': config.baseUrl || '',
    'x-provider-type': config.providerType || '',
    // Image generation provider
    'x-image-provider': settings.imageProviderId || '',
    'x-image-model': settings.imageModelId || '',
    'x-image-api-key': imageProviderConfig?.apiKey || '',
    'x-image-base-url': imageProviderConfig?.baseUrl || '',
    // Video generation provider
    'x-video-provider': settings.videoProviderId || '',
    'x-video-model': settings.videoModelId || '',
    'x-video-api-key': videoProviderConfig?.apiKey || '',
    'x-video-base-url': videoProviderConfig?.baseUrl || '',
    // Media generation toggles
    'x-image-generation-enabled': String(settings.imageGenerationEnabled ?? false),
    'x-video-generation-enabled': String(settings.videoGenerationEnabled ?? false),
  };
}

function withThinkingConfig<T extends Record<string, unknown>>(body: T): T {
  const { thinkingConfig } = getCurrentModelConfig();
  return thinkingConfig ? ({ ...body, thinkingConfig } as T) : body;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({
    error: response.statusText || 'Request failed',
  }));
}

function createHttpError(
  response: Response,
  data: { details?: unknown; error?: unknown; errorCode?: unknown; isRetryable?: unknown },
  fallback: string,
): Error & Pick<SceneContentResult, 'errorCode' | 'statusCode' | 'isRetryable'> {
  const message =
    typeof data.details === 'string'
      ? data.details
      : typeof data.error === 'string'
        ? data.error
        : `${fallback}: HTTP ${response.status}`;
  const error = new Error(message) as Error &
    Pick<SceneContentResult, 'errorCode' | 'statusCode' | 'isRetryable'>;
  if (typeof data.errorCode === 'string') {
    error.errorCode = data.errorCode;
  }
  error.statusCode = response.status;
  if (typeof data.isRetryable === 'boolean') error.isRetryable = data.isRetryable;
  return error;
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function errorMeta(
  error: unknown,
): Pick<SceneContentResult, 'errorCode' | 'statusCode' | 'isRetryable'> {
  if (!error || typeof error !== 'object') return {};
  const record = error as { errorCode?: unknown; statusCode?: unknown; isRetryable?: unknown };
  return {
    ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
    ...(typeof record.isRetryable === 'boolean' ? { isRetryable: record.isRetryable } : {}),
  };
}

/** Call POST /api/generate/scene-content (step 1) */
export async function fetchSceneContent(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    stageId: string;
    pdfImages?: PdfImage[];
    imageMapping?: ImageMapping;
    stageInfo: {
      name: string;
      description?: string;
      language?: string;
      style?: string;
    };
    agents?: AgentInfo[];
    languageDirective?: string;
    requirements?: UserRequirements;
    /** A1：该大纲对应教案节点的讲授设计（docs/spec/04 §5 逐段内容以教案节点为输入）。 */
    lessonNodeDesign?: LessonNodeDesign;
    presentation?: LessonPresentation;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneContentResult>,
): Promise<SceneContentResult> {
  if (params.presentation?.mode !== 'html') {
    return {
      success: false,
      error: 'HTML classroom visual direction is required',
    };
  }
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-content', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene content request failed');
        }

        return data as unknown as SceneContentResult;
      },
      {
        label: `scene content "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.content,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      success: false,
      error: messageFromError(error, 'Content generation failed'),
      ...errorMeta(error),
    };
  }
}

/** Call POST /api/generate/scene-actions (step 2) */
export async function fetchSceneActions(
  params: {
    outline: SceneOutline;
    allOutlines: SceneOutline[];
    content: unknown;
    stageId: string;
    agents?: AgentInfo[];
    previousSpeeches?: string[];
    userProfile?: string;
    languageDirective?: string;
    lessonNodeDesign?: LessonNodeDesign;
  },
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<SceneActionsResult>,
): Promise<SceneActionsResult> {
  try {
    return await withGenerationRetry(
      async () => {
        const response = await fetch('/api/generate/scene-actions', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(withThinkingConfig(params)),
          signal,
        });

        const data = await readJsonResponse(response);
        if (!response.ok) {
          throw createHttpError(response, data, 'Scene actions request failed');
        }

        return data as unknown as SceneActionsResult;
      },
      {
        label: `scene actions "${params.outline.title}"`,
        shouldRetryResult: (result) => !result.success || !result.scene,
        ...retryOptions,
        signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      success: false,
      error: messageFromError(error, 'Actions generation failed'),
      ...errorMeta(error),
    };
  }
}

interface TTSApiResponse {
  success?: boolean;
  base64?: string;
  format?: string;
  error?: string;
  details?: string;
}

/** Generate TTS for one speech action and return its allocated asset reference. */
export async function generateAndStoreTTS(
  requestId: string,
  text: string,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
  replaceAssetId?: string,
  stageId?: string,
): Promise<string | null> {
  if (!isLiveCourseTTSEnabled()) return null;
  const settings = useSettingsStore.getState();
  if (settings.ttsProviderId === 'browser-native-tts') return null;
  // Don't server-generate against a disabled/unconfigured provider (#665).
  if (
    !isTTSProviderEnabled(
      settings.ttsProviderId,
      settings.ttsProvidersConfig?.[settings.ttsProviderId],
    )
  )
    return null;

  const ttsProviderConfig = settings.ttsProvidersConfig?.[settings.ttsProviderId];
  // Narration is the teacher's voice — resolve it from the teacher agent profile
  // through the single resolver (registers + references by id for stable timbre).
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const providerOptions = await resolveAgentVoiceOptions(teacher, {
    providerId: settings.ttsProviderId,
    providerConfig: ttsProviderConfig,
    voiceId: settings.ttsVoice,
    language,
  });
  const data = await withGenerationRetry(
    async () => {
      const response = await fetch('/api/generate/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          audioId: requestId,
          ttsProviderId: settings.ttsProviderId,
          ttsModelId: ttsProviderConfig?.modelId,
          ttsVoice: settings.ttsVoice,
          ttsSpeed: settings.ttsSpeed,
          ttsApiKey: ttsProviderConfig?.apiKey || undefined,
          // Managed providers resolve their base URL server-side; only send the
          // client's own base URL (custom providers).
          ttsBaseUrl:
            ttsProviderConfig?.baseUrl || ttsProviderConfig?.customDefaultBaseUrl || undefined,
          ttsProviderOptions: providerOptions,
        }),
        signal,
      });

      const data = (await readJsonResponse(response)) as TTSApiResponse;
      if (!response.ok) {
        throw createHttpError(response, data, 'TTS request failed');
      }
      return data;
    },
    {
      label: `tts "${requestId}"`,
      shouldRetryResult: (result) => !result.success || !result.base64 || !result.format,
      ...retryOptions,
      signal,
    },
  );
  if (!data.success || !data.base64 || !data.format) {
    const err = new Error(
      data.details || data.error || 'TTS request failed: invalid response payload',
    );
    log.warn('TTS failed for', requestId, ':', err);
    throw err;
  }

  const binary = atob(data.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: `audio/${data.format}` });
  // Measure duration once at store time so video export (#854) can map this
  // clip onto a timeline without re-decoding. null → leave undefined; the audio
  // still persists and plays.
  const duration = measureAudioDuration(bytes, data.format) ?? undefined;
  // Crash-safety invariant: allocate and persist pool bytes first, keep the
  // Part 2 Dexie compatibility copy second, and let the caller stamp audioId
  // last. A failure therefore cannot leave an action pointing at missing data.
  const assetMeta = {
    contentType: blob.type,
    mediaType: 'audio',
    text,
    voice: settings.ttsVoice,
    duration,
    language,
    provider: {
      id: settings.ttsProviderId,
      model: ttsProviderConfig?.modelId,
    },
  } as const;
  const assetId = replaceAssetId ?? (await putAsset(blob, assetMeta));
  if (replaceAssetId) await replaceAsset(replaceAssetId, blob, assetMeta);
  // Dexie remains a deliberate double-write until Part 3 converges exporters,
  // playback, thumbnails, and import/export onto the shared asset pool.
  try {
    await db.audioFiles.put({
      id: assetId,
      stageId,
      blob,
      duration,
      format: data.format,
      text,
      voice: settings.ttsVoice,
      createdAt: Date.now(),
    });
  } catch (error) {
    if (!replaceAssetId) await removeAsset(assetId).catch(() => undefined);
    throw error;
  }
  return assetId;
}

export async function removeFreshTtsAllocations(assetIds: readonly string[]): Promise<void> {
  for (const assetId of new Set(assetIds)) {
    try {
      await removeAsset(assetId);
    } catch {
      // Continue to the compatibility row and later allocations.
    }
    await db.audioFiles.delete(assetId).catch(() => undefined);
  }
}

function speechAllocationIds(scene: Scene): string[] {
  return (scene.actions ?? []).flatMap((action) =>
    action.type === 'speech' && action.audioId ? [action.audioId] : [],
  );
}

/** Generate TTS for all speech actions in a scene. Returns result. */
export async function generateTTSForScene(
  scene: Scene,
  language?: string,
  signal?: AbortSignal,
  retryOptions?: ClientRetryOptions<TTSApiResponse>,
): Promise<{ success: boolean; failedCount: number; error?: string }> {
  const providerId = useSettingsStore.getState().ttsProviderId;
  scene.actions = splitLongSpeechActions(scene.actions || [], providerId);
  const speechActions = scene.actions.filter(
    (a): a is SpeechAction => a.type === 'speech' && !!a.text,
  );
  if (speechActions.length === 0) return { success: true, failedCount: 0 };

  let failedCount = 0;
  let lastError: string | undefined;
  const freshAllocations: string[] = [];

  // Scene order keeps the provider request correlation label unique. Storage
  // identity is allocated by the pool and is never derived from this value.
  const sceneOrder = scene.order;

  // Generate + store one action's audio. Failures are counted, not thrown, so
  // one bad clip never aborts the rest of the scene.
  const generateOne = async (action: SpeechAction) => {
    const requestId = `tts_s${sceneOrder}_${action.id}`;
    try {
      const assetId = await generateAndStoreTTS(
        requestId,
        action.text,
        language,
        signal,
        retryOptions,
        undefined,
        scene.stageId,
      );
      if (assetId) {
        action.audioId = assetId;
        freshAllocations.push(assetId);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;

      failedCount++;
      lastError = error instanceof Error ? error.message : `TTS failed for action ${action.id}`;
      log.warn('TTS generation failed:', {
        providerId,
        actionId: action.id,
        sceneOrder,
        requestId,
        textLength: action.text.length,
        error: lastError,
      });
    }
  };

  // #660 follow-up: speech actions within a scene are independent — each renders
  // its own audio under its own audioId, with no cross-action ordering — so when
  // the server opts into parallel generation, render them with bounded
  // concurrency (reusing the PARALLEL_SCENE_CONCURRENCY knob) instead of one at a
  // time. Default (0 / unset) keeps the original strictly-serial behaviour.
  const ttsConcurrency = Math.max(
    0,
    Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
  );
  try {
    if (ttsConcurrency > 1 && speechActions.length > 1) {
      const settled = await Promise.allSettled(
        lazyBoundedMap(speechActions, ttsConcurrency, generateOne),
      );
      const rejected = settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (rejected) throw rejected.reason;
    } else {
      for (const action of speechActions) {
        await generateOne(action);
      }
    }
  } catch (error) {
    await removeFreshTtsAllocations(freshAllocations);
    for (const action of speechActions) delete action.audioId;
    throw error;
  }

  if (failedCount > 0) {
    await removeFreshTtsAllocations(freshAllocations);
    for (const action of speechActions) delete action.audioId;
  }

  return {
    success: failedCount === 0,
    failedCount,
    error: lastError,
  };
}

export interface UseSceneGeneratorOptions {
  onSceneGenerated?: (scene: Scene, index: number) => void;
  onSceneFailed?: (outline: SceneOutline, error: string) => void;
  onPhaseChange?: (phase: 'content' | 'actions', outline: SceneOutline) => void;
  onComplete?: () => void;
}

export interface GenerationParams {
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  stageInfo: {
    name: string;
    description?: string;
    language?: string;
    style?: string;
  };
  agents?: AgentInfo[];
  userProfile?: string;
  languageDirective?: string;
}

export function useSceneGenerator(options: UseSceneGeneratorOptions = {}) {
  const generatingRef = useRef(false);
  const mediaAbortRef = useRef<AbortController | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const activeRunRef = useRef<{ stageId: string; epoch: number } | null>(null);
  const lastParamsRef = useRef<GenerationParams | null>(null);

  const store = useStageStore;

  const runGeneration = useCallback(
    async (params: GenerationParams, retryOutlineId?: string): Promise<boolean> => {
      if (generatingRef.current) return false;
      const state = store.getState();
      const { outlines, scenes, stage } = state;
      if (!stage || outlines.length === 0) return false;

      lastParamsRef.current = params;
      generatingRef.current = true;
      const run = { stageId: stage.id, epoch: state.generationEpoch };
      activeRunRef.current = run;
      const controller = new AbortController();
      fetchAbortRef.current = controller;
      const signal = controller.signal;
      const ownsStage = () =>
        activeRunRef.current === run &&
        store.getState().stage?.id === run.stageId &&
        store.getState().generationEpoch === run.epoch;
      const isCurrentRun = () => ownsStage() && !signal.aborted;
      const removeGeneratingOutline = (outlineId: string) => {
        const current = store.getState().generatingOutlines;
        if (!current.some((o) => o.id === outlineId)) return;
        store.getState().setGeneratingOutlines(current.filter((o) => o.id !== outlineId));
      };
      const failOutline = (outline: SceneOutline, error: string) => {
        log.warn('Scene generation failed:', { outlineId: outline.id, error });
        store.getState().addFailedOutline(outline);
        removeGeneratingOutline(outline.id);
        options.onSceneFailed?.(outline, error);
      };

      store.getState().setGenerationStatus('generating');

      // Determine pending outlines
      const completedOrders = new Set(scenes.map((s) => s.order));
      const failedIds = new Set(state.failedOutlines.map((outline) => outline.id));
      const pending = outlines
        .filter(
          (outline) =>
            !completedOrders.has(outline.order) &&
            (retryOutlineId ? outline.id === retryOutlineId : !failedIds.has(outline.id)),
        )
        .sort((a, b) => a.order - b.order);

      if (retryOutlineId) store.getState().retryFailedOutline(retryOutlineId);
      store.getState().setGeneratingOutlines(pending);

      // Launch media generation in parallel — does not block content/action generation
      if (!retryOutlineId) {
        mediaAbortRef.current?.abort();
        mediaAbortRef.current = new AbortController();
        const mediaSignal = mediaAbortRef.current.signal;
        if (pending.length > 0) {
          generateMediaForOutlines(outlines, stage.id, mediaSignal).catch((err) => {
            log.warn('Media generation error:', err);
          });
        }
        generateAndPersistCourseCover({ stageId: stage.id, signal: mediaSignal }).catch((err) => {
          log.warn('Course cover generation error:', err);
        });
      }

      // #572: opt-in parallel content fetch. Concurrency is server-configured
      // (PARALLEL_SCENE_CONCURRENCY), default 0 = off, so out-of-box behaviour is
      // unchanged.
      const parallelConcurrency = Math.max(
        0,
        // Belt-and-suspenders: the value is already clamped server-side and again
        // in the settings store; re-clamp here so a stale/garbage store value can
        // never spawn an unbounded fetch fan-out.
        Math.floor(useSettingsStore.getState().parallelSceneConcurrency ?? 0),
      );
      const useParallelContent = parallelConcurrency > 1 && pending.length > 1;

      // Pipelined generation loop (#572). When parallelism is on, scene *content*
      // fetches are kicked off up front with bounded concurrency (lazyBoundedMap)
      // but CONSUMED IN ORDER inside the serial loop below — there is no barrier.
      // So the first scene paints after content(1)+actions(1)+TTS(1) (same as
      // serial) while later content fetches run hidden behind earlier scenes'
      // actions/TTS. Content has no cross-scene dependency, so running it ahead is
      // safe; actions + TTS stay strictly serial to preserve previousSpeeches
      // threading and the pause-on-failure UX. With parallelism off this is exactly
      // the original one-at-a-time loop.
      let currentOutline: SceneOutline | undefined;
      let succeeded = true;
      try {
        const fetchContent = (outline: SceneOutline) =>
          fetchSceneContent(
            {
              outline,
              allOutlines: outlines,
              stageId: stage.id,
              pdfImages: params.pdfImages,
              imageMapping: params.imageMapping,
              stageInfo: params.stageInfo,
              agents: params.agents,
              languageDirective: params.languageDirective,
              lessonNodeDesign: lessonNodeDesignForOutline(outline),
              presentation: state.lessonPlan?.presentation,
            },
            signal,
          );

        // Pre-warm content fetches (<= parallelConcurrency in flight), keyed by
        // outline id. Each promise resolves to a result and never rejects, so an
        // unexpected throw routes through the same mark-failed path as the serial
        // loop instead of taking sibling fetches down with it.
        const contentPromises = useParallelContent
          ? new Map(
              lazyBoundedMap(
                pending,
                parallelConcurrency,
                async (outline): Promise<SceneContentResult> => {
                  options.onPhaseChange?.('content', outline);
                  try {
                    return await fetchContent(outline);
                  } catch (err) {
                    return {
                      success: false,
                      error: err instanceof Error ? err.message : 'Content generation failed',
                    };
                  }
                },
                {
                  shouldContinue: isCurrentRun,
                },
              ).map((promise, i) => [pending[i].id, promise] as const),
            )
          : null;

        for (const outline of pending) {
          if (!isCurrentRun()) return false;

          currentOutline = outline;
          store.getState().setCurrentGeneratingOrder(outline.order);

          // Step 1: content — await this outline's pre-warmed fetch (parallel),
          // which usually resolved while the previous scene's actions/TTS ran; or
          // fetch it now (serial).
          let contentResult: SceneContentResult;
          if (contentPromises) {
            contentResult = (await contentPromises.get(outline.id)) ?? {
              success: false,
              error: 'Content generation failed',
            };
          } else {
            options.onPhaseChange?.('content', outline);
            contentResult = await fetchContent(outline);
          }
          if (!isCurrentRun()) return false;

          if (!contentResult.success || !contentResult.content) {
            succeeded = false;
            failOutline(outline, contentResult.error || 'Content generation failed');
            if (contentPromises) {
              // Parallel: surface the failure but keep going with the other scenes
              // (their content is already in flight).
              continue;
            }
            // Serial: pause the batch (unchanged behaviour).
            break;
          }

          // Step 2: Generate actions + assemble scene
          const previousScene = store
            .getState()
            .scenes.filter((scene) => scene.order < outline.order)
            .sort((a, b) => b.order - a.order)[0];
          const previousSpeeches = (previousScene?.actions ?? [])
            .filter((action): action is SpeechAction => action.type === 'speech')
            .map((action) => action.text);
          options.onPhaseChange?.('actions', outline);
          const actionsResult = await fetchSceneActions(
            {
              outline: contentResult.effectiveOutline || outline,
              allOutlines: outlines,
              content: contentResult.content,
              stageId: stage.id,
              agents: params.agents,
              previousSpeeches,
              userProfile: params.userProfile,
              languageDirective: params.languageDirective,
              lessonNodeDesign: lessonNodeDesignForOutline(outline),
            },
            signal,
          );
          if (!isCurrentRun()) return false;

          if (actionsResult.success && actionsResult.scene) {
            const scene = actionsResult.scene;
            const settings = useSettingsStore.getState();

            // TTS generation — failure means the whole scene fails
            if (
              isLiveCourseTTSEnabled() &&
              settings.ttsEnabled &&
              settings.ttsProviderId !== 'browser-native-tts' &&
              isTTSProviderEnabled(
                settings.ttsProviderId,
                settings.ttsProvidersConfig?.[settings.ttsProviderId],
              )
            ) {
              const ttsResult = await generateTTSForScene(
                scene,
                params.languageDirective || params.stageInfo.language,
                signal,
              );
              if (!ttsResult.success) {
                if (!isCurrentRun()) return false;
                succeeded = false;
                failOutline(outline, ttsResult.error || 'TTS generation failed');
                break;
              }
            }

            // Epoch changed — stage switched, discard this scene
            if (!isCurrentRun()) {
              await removeFreshTtsAllocations(speechAllocationIds(scene));
              return false;
            }

            removeGeneratingOutline(outline.id);
            addGeneratedScene(scene);
            options.onSceneGenerated?.(scene, outline.order);
          } else {
            succeeded = false;
            failOutline(outline, actionsResult.error || 'Actions generation failed');
            break;
          }
        }
        return succeeded && isCurrentRun();
      } catch (err: unknown) {
        // AbortError is expected when stop() is called — don't treat as failure
        if (isAbortError(err)) {
          log.info('Generation aborted');
          if (
            retryOutlineId &&
            currentOutline &&
            store.getState().stage?.id === run.stageId
          ) {
            store.getState().addFailedOutline(currentOutline);
          }
        } else {
          log.error('Generation run failed:', err);
          if (isCurrentRun() && currentOutline) {
            failOutline(currentOutline, messageFromError(err, 'Scene generation failed'));
          }
        }
        return false;
      } finally {
        // Cancel unused prefetched content before releasing the run. A stale
        // run must never clear markers or pause a different course.
        controller.abort();
        if (ownsStage()) {
          const current = store.getState();
          current.setGeneratingOutlines([]);
          current.setCurrentGeneratingOrder(-1);
          current.markGenerationCompleteIfDone();
          current.setGenerationStatus(store.getState().generationComplete ? 'completed' : 'paused');
          if (store.getState().generationComplete) options.onComplete?.();
        }
        generatingRef.current = false;
        fetchAbortRef.current = null;
        activeRunRef.current = null;
      }
    },
    [options, store],
  );

  const generateRemaining = useCallback(
    async (params: GenerationParams) => {
      await runGeneration(params);
    },
    [runGeneration],
  );

  const stop = useCallback(() => {
    const run = activeRunRef.current;
    const state = store.getState();
    if (run && state.stage?.id === run.stageId && state.generationEpoch === run.epoch) {
      state.bumpGenerationEpoch();
      state.setGeneratingOutlines([]);
      state.setCurrentGeneratingOrder(-1);
      state.setGenerationStatus('paused');
    }
    fetchAbortRef.current?.abort();
    mediaAbortRef.current?.abort();
  }, [store]);

  const isGenerating = useCallback(() => generatingRef.current, []);

  /** Retry a single failed outline from scratch (content → actions → TTS). */
  const retrySingleOutline = useCallback(
    async (outlineId: string) => {
      const state = store.getState();
      const outline = state.failedOutlines.find((o) => o.id === outlineId);
      const params = lastParamsRef.current;
      if (generatingRef.current || !outline || !state.stage || !params) return;
      const retryEpoch = state.generationEpoch;

      // Regen-lock (#571): never silently replace a scene that is open in
      // edit mode. Failed outlines have no completed scene yet so this is
      // structurally a no-op today, but the guard is in place for the
      // moment a "regenerate a successful scene" path routes through here.
      const lockedScene = state.scenes.find((s) => s.order === outline.order);
      if (
        lockedScene &&
        isSceneEditLocked({
          sceneId: lockedScene.id,
          mode: state.mode,
          currentSceneId: state.currentSceneId,
        })
      ) {
        return;
      }

      const succeeded = await runGeneration(params, outlineId);
      const current = store.getState();
      if (
        succeeded &&
        current.stage?.id === state.stage.id &&
        current.generationEpoch === retryEpoch &&
        !current.generationComplete
      ) {
        await runGeneration(params);
      }
    },
    [runGeneration, store],
  );

  return { generateRemaining, retrySingleOutline, stop, isGenerating };
}
