'use client';

import { useEffect, useMemo, useState, Suspense, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { Button } from '@/components/ui/button';
import { useStageStore } from '@/lib/store/stage';
import { useSettingsStore } from '@/lib/store/settings';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { isAbortError } from '@/lib/generation/generation-retry';
import {
  loadImageMapping,
  loadDocumentBlob,
  cleanupOldImages,
  storeImages,
} from '@/lib/utils/image-storage';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import {
  MAX_DOCUMENT_BUNDLE_FILES,
  MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES,
  buildDocumentBundle,
  type ParsedDocumentPart,
} from '@/lib/document/bundle';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import { lessonPlanSchema, type LessonPlan } from '@/lib/livecourse/domain/schemas';
import { initializeCourseState } from '@/lib/livecourse/session/course-state-bootstrap';
import { createCourseStateRepository } from '@/lib/livecourse/session/course-state-repository';
import { writeGenerationParams } from '@/lib/livecourse/session/generation-params';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import { applyVisualAidsToOutlines } from '@/lib/livecourse/lesson/visual-aids';
import {
  buildGenerationCourseIntake,
  loadNewCourseMemoryContext,
  persistGenerationCourseIntake,
  type NewCourseMemoryContext,
} from '@/lib/livecourse/memory';
import type { Stage } from '@/lib/types/stage';
import type {
  SceneOutline,
  PdfImage,
  ImageMapping,
  SessionDocumentSource,
  UserRequirements,
} from '@/lib/types/generation';
import { ClarifyCard } from '@/components/generation/clarify-card';
import { ScopePicker } from '@/components/generation/scope-picker';
import { PreparationTransition } from '@/components/generation/preparation-transition';
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  ClarifyResult,
  KnowledgeMap,
} from '@/lib/livecourse/outline/types';
import {
  normalizeClarifyResult,
  normalizeKnowledgeMap,
} from '@/lib/livecourse/outline/normalizers';
import { likelyNeedsKnowledgeMap } from '@/lib/livecourse/outline/scope';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import {
  type GenerationSessionState,
  type GenerationStepId,
  resolveGenerationIdentity,
  withGenerationIdentity,
  ALL_STEPS,
  getActiveSteps,
  getGenerationStepText,
} from './types';
import { resolveGenerationLessonPlan } from './lesson-plan';
import { SegmentList } from './components/segment-list';
import { LessonPlanPanel } from './components/lesson-plan-panel';
import { PreparationSteps } from './components/preparation-steps';
import { ConfirmationFailurePanel } from './components/confirmation-failure';
import { fetchGenerationResearch } from './fetch-research';
import {
  PENDING_CLASSROOM_ENTER_KEY,
  allSegmentsCompleted,
  canEnterClassroom,
  canRetrySegment,
  classroomEnterTarget,
  consumePendingClassroomEnterFailure,
  deriveSegmentProgress,
  type GeneratingPhase,
} from './segment-status';
import { readOutlineStream } from './read-outline-stream';
import {
  SHOWCASE_CLASSROOM_ID,
  isFourierShowcaseSession,
  outlinesFromClassroomScenes,
} from './resume-session';
import {
  applyClassroomStageAndScenes,
  fetchClassroomFromApi,
} from '@/lib/classroom/load-classroom';

const log = createLogger('GenerationPreview');

type ParsedDocumentResponseImage = {
  id: string;
  src?: string;
  pageNumber?: number;
  description?: string;
  width?: number;
  height?: number;
};

function legacySourceFromSession(session: GenerationSessionState): SessionDocumentSource[] {
  if (session.documentSources?.length) return session.documentSources;
  if (!session.pdfStorageKey) return [];
  return [
    {
      id: 'source_1',
      name: session.pdfFileName || 'document.pdf',
      size: 0,
      mimeType: session.documentMimeType || 'application/pdf',
      order: 1,
      storageKey: session.pdfStorageKey,
      providerId: session.pdfProviderId,
    },
  ];
}

function validateDocumentSources(
  sources: SessionDocumentSource[],
  t: (key: string, values?: Record<string, unknown>) => string,
) {
  if (sources.length > MAX_DOCUMENT_BUNDLE_FILES) {
    throw new Error(t('upload.courseMaterialCountLimit', { n: MAX_DOCUMENT_BUNDLE_FILES }));
  }

  const totalSize = sources.reduce((sum, source) => sum + source.size, 0);
  if (totalSize > MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES) {
    throw new Error(
      t('upload.courseMaterialTotalSizeLimit', {
        n: Math.floor(MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES / 1024 / 1024),
      }),
    );
  }
}

/**
 * A3 课前确认（docs/spec/02 生成预览节「按需课前确认（生成教案之前）」）：
 * 预览页内嵌的追问 / 范围勾选状态机。所有状态都可跳过；请求失败进入
 * *-error 态，提供重试或跳过，已答内容已持久化进 session。
 */
type ConfirmStep =
  | { kind: 'idle' }
  | { kind: 'loading-clarify' }
  | { kind: 'questions'; questions: ClarifyQuestion[] }
  | { kind: 'clarify-error' }
  | { kind: 'loading-scope' }
  | { kind: 'scope'; knowledgeMap: KnowledgeMap; submitting?: boolean; error?: string }
  | { kind: 'scope-error' };

type ConfirmOutcome =
  | { type: 'continue'; answers: ClarifyAnswer[] }
  | { type: 'start'; selectedTopics: string[] }
  | { type: 'skip' }
  | { type: 'retry' };

type PreLessonConfirmationResult = {
  requirements: UserRequirements;
  skipped: boolean;
};

function GenerationPreviewContent() {
  const router = useRouter();
  const { t } = useI18n();
  const hasStartedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const completeSessionPersistedRef = useRef(false);

  const outlines = useStageStore((state) => state.outlines);
  const scenes = useStageStore((state) => state.scenes);
  const loadedStageId = useStageStore((state) => state.stage?.id);
  const generationStatus = useStageStore((state) => state.generationStatus);
  const failedOutlines = useStageStore((state) => state.failedOutlines);
  const generatingOutlines = useStageStore((state) => state.generatingOutlines);
  const [generatingPhases, setGeneratingPhases] = useState<Record<string, GeneratingPhase>>({});
  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onPhaseChange: (phase, outline) =>
      setGeneratingPhases((current) => ({ ...current, [outline.id]: phase })),
  });

  const [session, setSession] = useState<GenerationSessionState | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [sessionLoadFailed, setSessionLoadFailed] = useState(false);
  const [sessionLoadAttempt, setSessionLoadAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [currentStepId, setCurrentStepId] = useState<GenerationStepId>('outline');
  const [statusMessageKey, setStatusMessageKey] = useState('');
  const [enteringClassroom, setEnteringClassroom] = useState(false);
  const [enterError, setEnterError] = useState<string | null>(null);
  const [pendingEnterFailed, setPendingEnterFailed] = useState(false);
  const [retryingSegmentId, setRetryingSegmentId] = useState<string | null>(null);
  const [streamingOutlines, setStreamingOutlines] = useState<SceneOutline[] | null>(null);
  // Content generation waits for the persisted HTML lesson plan.
  const [lessonPlan, setLessonPlan] = useState<LessonPlan | null>(null);
  const [truncationWarnings, setTruncationWarnings] = useState<string[]>([]);
  const [webSearchSources, setWebSearchSources] = useState<Array<{ title: string; url: string }>>(
    [],
  );
  // A3 课前确认（预览页内、生成教案之前）
  const [confirmStep, setConfirmStep] = useState<ConfirmStep>({ kind: 'idle' });
  const confirmResolveRef = useRef<((outcome: ConfirmOutcome) => void) | null>(null);
  /** Read-only new-course L snapshot and its bounded prompt projection. */
  const newCourseMemoryContextRef = useRef<NewCourseMemoryContext | null>(null);
  /** Stable timestamp for the current generation command / C intake. */
  const generationStartedAtRef = useRef<string | null>(null);
  const hasSessionStage = !!session && loadedStageId === session.stageId;

  const segments = useMemo(
    () =>
      deriveSegmentProgress({
        outlines:
          hasSessionStage && outlines.length > 0 ? outlines : (session?.sceneOutlines ?? []),
        scenes: hasSessionStage ? scenes : [],
        failedOutlines: hasSessionStage ? failedOutlines : [],
        generatingOutlines: hasSessionStage ? generatingOutlines : [],
        lessonPlan,
        generatingPhases,
      }),
    [
      failedOutlines,
      generatingOutlines,
      generatingPhases,
      lessonPlan,
      outlines,
      scenes,
      session?.sceneOutlines,
      hasSessionStage,
    ],
  );
  const deckReady = allSegmentsCompleted(segments);
  const hasFailedSegments = segments.some((segment) => segment.status === 'failed');
  const showSegmentWorkspace = confirmStep.kind === 'idle' && segments.length > 0;

  // Compute active steps based on session state
  const activeSteps = getActiveSteps(session);

  const persistSession = (nextSession: GenerationSessionState) => {
    const normalized = withGenerationIdentity(nextSession);
    sessionStorage.setItem('generationSession', JSON.stringify(normalized));
    setSession(normalized);
  };

  /** 挂起生成流水线，等待学习者在确认卡片上做选择；离开页面（abort）时拒绝。 */
  const waitConfirmChoice = (signal: AbortSignal): Promise<ConfirmOutcome> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      confirmResolveRef.current = resolve;
      signal.addEventListener(
        'abort',
        () => {
          confirmResolveRef.current = null;
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });

  const settleConfirm = (outcome: ConfirmOutcome) => {
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    resolve?.(outcome);
  };

  /**
   * A3：生成教案之前的课前确认（追问 → 按需范围勾选）。全程带完整模型请求头
   *（客户端配置的 key 也能用）；任何请求失败都停下提供「重试 / 跳过」，
   * 已答内容立即写回 session 持久化。返回带答案的 requirements。
   */
  const runPreLessonConfirmation = async (
    currentSession: GenerationSessionState,
    signal: AbortSignal,
    stageId: string,
  ): Promise<PreLessonConfirmationResult> => {
    // J2.0 / A6: read learner-only L before asking questions. `load` is a
    // read-only operation and does not create an L session when none exists.
    // The bounded projection is reused by every pre-generation request; no
    // C/L write happens while this confirmation state machine is active.
    const learnerId = await getLearnerKey();
    if (!newCourseMemoryContextRef.current) {
      newCourseMemoryContextRef.current = await loadNewCourseMemoryContext({
        store: getRuntimeStore(),
        stageId,
        learnerId,
        requirements: currentSession.requirements,
      });
    }

    let requirements = currentSession.requirements;
    if (currentSession.confirmationDone) {
      return {
        requirements,
        skipped: currentSession.confirmationSkipped === true,
      };
    }
    let confirmationSkipped = currentSession.confirmationSkipped === true;

    const persistRequirements = (confirmationDone = false) => {
      const next: GenerationSessionState = {
        ...currentSession,
        requirements,
        ...(confirmationDone ? { confirmationDone: true } : {}),
        ...(confirmationSkipped ? { confirmationSkipped: true } : {}),
      };
      persistSession(next);
      currentSession = next;
    };

    const markConfirmationSkipped = () => {
      confirmationSkipped = true;
    };

    // ── 追问 ──
    let questions: ClarifyQuestion[] = [];
    for (;;) {
      setConfirmStep({ kind: 'loading-clarify' });
      try {
        const res = await fetch('/api/generate/outline/clarify', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(
            withThinkingConfig({
              requirements,
              teacherContext: newCourseMemoryContextRef.current?.teacherContext.text || undefined,
            }),
          ),
          signal,
        });
        if (!res.ok) throw new Error(`clarify request failed: ${res.status}`);
        const payload: unknown = await res.json();
        // `apiSuccess` adds a transport-level `success` field while the e2e
        // fixture returns the domain object directly. Normalize the domain
        // portion instead of assuming either envelope, and treat an unusable
        // payload as a real confirmation failure so the retry/skip state is
        // visible to the learner.
        const result = normalizeClarifyResult(payload) as ClarifyResult | null;
        if (!result) throw new Error('clarify response was not a valid result');
        if (result.status === 'needs_clarification') questions = result.questions;
        break;
      } catch (err) {
        if (isAbortError(err)) throw err;
        log.warn('Clarify request failed:', err);
        // 手册：课前问题请求失败时保留已答内容，提供重试或跳过
        setConfirmStep({ kind: 'clarify-error' });
        const choice = await waitConfirmChoice(signal);
        if (choice.type === 'retry') continue;
        markConfirmationSkipped();
        persistRequirements(true);
        setConfirmStep({ kind: 'idle' });
        return { requirements, skipped: confirmationSkipped };
      }
    }

    let clarificationAnswers = requirements.clarificationAnswers ?? [];
    if (questions.length > 0) {
      setConfirmStep({ kind: 'questions', questions });
      const outcome = await waitConfirmChoice(signal);
      if (outcome.type === 'continue') {
        const answered = outcome.answers.filter((a) => a.selectedLabels.length > 0);
        clarificationAnswers = answered;
        if (answered.length > 0) {
          requirements = { ...requirements, clarificationAnswers: answered };
        }
        persistRequirements(); // 立即持久化已答内容
      } else if (outcome.type === 'skip') {
        markConfirmationSkipped();
      }
    }

    // ── 范围勾选（仅范围仍宽时出现）──
    // A clarifier failure deliberately degrades to `ready`; use both its
    // explicit scope question and a deterministic broad-subject check so that
    // a broad request such as “我想学高数” still gets a chance to narrow its
    // scope. Existing selected topics mean the learner already committed a
    // scope, so do not ask again after a refresh.
    const hasScopeQuestion = questions.some((question) => question.multiSelect);
    const shouldLoadScope =
      !requirements.selectedTopics?.length &&
      (hasScopeQuestion || likelyNeedsKnowledgeMap(requirements.requirement));
    if (shouldLoadScope) {
      let knowledgeMap: KnowledgeMap | null = null;
      for (;;) {
        setConfirmStep({ kind: 'loading-scope' });
        try {
          const res = await fetch('/api/generate/outline/knowledge-map', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify(
              withThinkingConfig({
                requirements,
                answers: clarificationAnswers,
                teacherContext: newCourseMemoryContextRef.current?.teacherContext.text || undefined,
              }),
            ),
            signal,
          });
          if (!res.ok) throw new Error(`knowledge-map request failed: ${res.status}`);
          const payload: unknown = await res.json();
          // Accept both the standard `{success:true,...}` response and the
          // raw domain object used by local/browser fixtures. An empty but
          // valid map is distinct from an invalid response and simply skips
          // the optional picker.
          knowledgeMap = normalizeKnowledgeMap(payload) as KnowledgeMap | null;
          if (!knowledgeMap) throw new Error('knowledge-map response was not a valid map');
          break;
        } catch (err) {
          if (isAbortError(err)) throw err;
          log.warn('Knowledge map request failed:', err);
          // 手册：首次加载失败且尚无推荐范围时，提供重试或跳过范围确认
          setConfirmStep({ kind: 'scope-error' });
          const choice = await waitConfirmChoice(signal);
          if (choice.type === 'retry') continue;
          markConfirmationSkipped();
          break;
        }
      }

      if (knowledgeMap?.topics.length) {
        setConfirmStep({ kind: 'scope', knowledgeMap });
        for (;;) {
          const scopeOutcome = await waitConfirmChoice(signal);
          const previousRequirements = requirements;
          const previouslySkipped = confirmationSkipped;
          if (scopeOutcome.type === 'start' && scopeOutcome.selectedTopics.length > 0) {
            requirements = { ...requirements, selectedTopics: scopeOutcome.selectedTopics };
          } else if (scopeOutcome.type === 'skip') {
            markConfirmationSkipped();
          } else {
            continue;
          }
          setConfirmStep({ kind: 'scope', knowledgeMap, submitting: true });
          try {
            persistRequirements(true);
            setConfirmStep({ kind: 'idle' });
            return { requirements, skipped: confirmationSkipped };
          } catch (err) {
            if (isAbortError(err)) throw err;
            log.warn('Scope confirmation failed:', err);
            requirements = previousRequirements;
            confirmationSkipped = previouslySkipped;
            // Keep the same picker mounted: its selection and the loaded map
            // remain available for retry or using the cached recommendation.
            setConfirmStep({ kind: 'scope', knowledgeMap, error: t('clarify.scopeSubmitFailed') });
          }
        }
      }
    }

    persistRequirements(true);
    setConfirmStep({ kind: 'idle' });
    return { requirements, skipped: confirmationSkipped };
  };

  // Load session from sessionStorage
  useEffect(() => {
    cleanupOldImages(24).catch((e) => log.error(e));
    let cancelled = false;

    setSessionLoadFailed(false);
    void (async () => {
      try {
        const saved = sessionStorage.getItem('generationSession');
        if (saved) {
          const parsed = withGenerationIdentity(JSON.parse(saved) as GenerationSessionState);
          // Normalize legacy phases: outline review no longer exists (docs/spec/02
          // 生成预览节 — 学习者只看教案段与每段状态，不审阅/编辑大纲)。Any unknown
          // phase (including the retired 'outline-ready' / 'review') resumes as
          // content generation when outlines were persisted, else from the start.
          if (parsed.previewPhase !== 'preparing' && parsed.previewPhase !== 'generating-content') {
            parsed.previewPhase = parsed.sceneOutlines?.length ? 'generating-content' : 'preparing';
          }
          parsed.taskEngineMode = parsed.taskEngineMode === true;
          if (
            parsed.currentStep !== 'complete' &&
            isFourierShowcaseSession({
              courseTitle: parsed.courseTitle,
              requirement: parsed.requirements.requirement,
            })
          ) {
            const showcase = await fetchClassroomFromApi(SHOWCASE_CLASSROOM_ID);
            if (showcase?.scenes.length && !cancelled) {
              const showcaseOutlines = outlinesFromClassroomScenes(showcase.scenes);
              applyClassroomStageAndScenes(showcase.stage, showcase.scenes, {
                persist: true,
                coursePlan: showcase.coursePlan,
                lessonPlan: showcase.lessonPlan,
                outlines: showcaseOutlines,
                generationComplete: true,
              });
              parsed.stageId = showcase.stage.id;
              parsed.courseId = showcase.coursePlan?.courseId ?? showcase.stage.id;
              parsed.lessonId = showcase.coursePlan?.lessons[0]?.id ?? showcase.stage.id;
              parsed.currentStep = 'complete';
              parsed.previewPhase = 'generating-content';
              parsed.sceneOutlines = showcaseOutlines;
              parsed.lessonPlan = showcase.lessonPlan ?? parsed.lessonPlan;
              parsed.courseTitle = showcase.stage.name;
              hasStartedRef.current = true;
            }
          }
          if (cancelled) return;
          // Restore the plan before generation starts.  Invalid persisted values
          // stay on the session object so the generation boundary can fail loud;
          // never render an unchecked object in the preview panel.
          const persistedPlan = lessonPlanSchema.safeParse(parsed.lessonPlan);
          setLessonPlan(persistedPlan.success ? persistedPlan.data : null);
          if (parsed.sceneOutlines?.length) {
            setStreamingOutlines(parsed.sceneOutlines);
          }
          if (parsed.currentStep === 'complete' && parsed.stageId) {
            if (parsed.stageId !== SHOWCASE_CLASSROOM_ID) {
              await useStageStore.getState().loadFromStorage(parsed.stageId);
              if (cancelled) return;
              if (useStageStore.getState().stage?.id !== parsed.stageId) {
                throw new Error('The completed generation document could not be loaded');
              }
              // sessionStorage can be newer than the last durable scene save.
              // Resume missing segments rather than trusting a stale complete flag.
              const restored = useStageStore.getState();
              if (
                !allSegmentsCompleted(
                  deriveSegmentProgress({
                    outlines: parsed.sceneOutlines ?? restored.outlines,
                    scenes: restored.scenes,
                    failedOutlines: restored.failedOutlines,
                    generatingOutlines: [],
                  }),
                )
              ) {
                parsed.currentStep = 'generating';
                restored.setGenerationComplete(false);
              }
            }
            completeSessionPersistedRef.current = parsed.currentStep === 'complete';
          }
          // Write the migration immediately so a refresh or a failed retry uses
          // exactly the same course/stage/lesson identities.
          sessionStorage.setItem('generationSession', JSON.stringify(parsed));
          setSession(parsed);
        }
        if (consumePendingClassroomEnterFailure(sessionStorage)) {
          setPendingEnterFailed(true);
        }
      } catch (e) {
        log.error('Failed to load generation session:', e);
        if (!cancelled) setSessionLoadFailed(true);
      }
      if (!cancelled) setSessionLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionLoadAttempt]);

  // Abort all in-flight requests on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      stop();
    };
  }, [stop]);

  useEffect(() => {
    if (!deckReady || !session || completeSessionPersistedRef.current) return;
    completeSessionPersistedRef.current = true;
    persistSession({ ...session, currentStep: 'complete', previewPhase: 'generating-content' });
  }, [deckReady, session]);

  // Get API credentials from localStorage
  const getApiHeaders = () => {
    const modelConfig = getCurrentModelConfig();
    const settings = useSettingsStore.getState();
    const imageProviderConfig = settings.imageProvidersConfig?.[settings.imageProviderId];
    const videoProviderConfig = settings.videoProvidersConfig?.[settings.videoProviderId];
    return {
      'Content-Type': 'application/json',
      'x-model': modelConfig.modelString,
      'x-api-key': modelConfig.apiKey,
      'x-base-url': modelConfig.baseUrl,
      'x-provider-type': modelConfig.providerType || '',
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
  };

  const withThinkingConfig = <T extends Record<string, unknown>>(body: T) => {
    const { thinkingConfig } = getCurrentModelConfig();
    return thinkingConfig ? { ...body, thinkingConfig } : body;
  };

  // Auto-start generation when session is loaded
  useEffect(() => {
    if (!session || !sessionLoaded || sessionLoadFailed || hasStartedRef.current) return;
    if (session.currentStep === 'complete') {
      hasStartedRef.current = true;
      return;
    }
    const shouldAutoStart = !session.previewPhase || session.previewPhase === 'preparing';
    // 'generating-content' with persisted outlines: startGeneration resumes from
    // the lesson-plan step; without outlines the SSE simply restarts.
    if (shouldAutoStart || session.previewPhase === 'generating-content') {
      hasStartedRef.current = true;
      startGeneration();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessionLoaded, sessionLoadFailed]);

  // Main generation flow
  const startGeneration = async (sessionOverride?: GenerationSessionState) => {
    const generationSession = sessionOverride ?? session;
    if (!generationSession) return;

    // A retry in the same preview reuses the original intake timestamp, while
    // a refreshed page gets a new timestamp that the idempotent C boundary
    // intentionally ignores when the intake content is unchanged.
    generationStartedAtRef.current ??= new Date().toISOString();
    newCourseMemoryContextRef.current = null;

    // Create AbortController for this generation run
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    // Use a local mutable copy so we can update it after document extraction
    let currentSession = generationSession;

    setError(null);
    setGeneratingPhases({});

    try {
      // Determine if we need the document analysis step
      const documentSources = legacySourceFromSession(currentSession);
      const hasPdfToAnalyze = documentSources.length > 0 && !currentSession.pdfText;
      // If no document to analyze, skip to the next available step
      setCurrentStepId(
        hasPdfToAnalyze
          ? 'pdf-analysis'
          : currentSession.requirements.webSearch
            ? 'web-search'
            : 'outline',
      );

      // Step 0: Extract uploaded course material if needed
      if (hasPdfToAnalyze) {
        log.debug('=== Generation Preview: Extracting course material bundle ===');
        validateDocumentSources(documentSources, t);
        const sortedDocumentSources = [...documentSources].sort((a, b) => a.order - b.order);
        const parsedParts = await Promise.all(
          sortedDocumentSources.map(async (source): Promise<ParsedDocumentPart> => {
            const documentBlob = await loadDocumentBlob(source.storageKey);
            if (!documentBlob) {
              throw new Error(t('generation.courseMaterialLoadFailed'));
            }

            if (!(documentBlob instanceof Blob) || documentBlob.size === 0) {
              log.error('Invalid course material blob:', {
                source: source.name,
                type: typeof documentBlob,
                size: documentBlob instanceof Blob ? documentBlob.size : 'N/A',
              });
              throw new Error(t('generation.courseMaterialLoadFailed'));
            }

            const documentFile = new File([documentBlob], source.name || 'document.pdf', {
              type: source.mimeType || documentBlob.type || 'application/pdf',
            });

            const parseFormData = new FormData();
            parseFormData.append('file', documentFile);

            const providerId = source.providerId || currentSession.pdfProviderId;
            const legacySourceConfig = (
              source as SessionDocumentSource & {
                providerConfig?: {
                  apiKey?: string;
                  baseUrl?: string;
                  accessKeyId?: string;
                  accessKeySecret?: string;
                };
              }
            ).providerConfig;
            const providerConfig = currentSession.pdfProviderConfig || legacySourceConfig;
            if (providerId) parseFormData.append('providerId', providerId);
            if (providerConfig?.apiKey?.trim()) {
              parseFormData.append('apiKey', providerConfig.apiKey);
            }
            if (providerConfig?.baseUrl?.trim()) {
              parseFormData.append('baseUrl', providerConfig.baseUrl);
            }
            // AliDocMind uses AK/SK instead of a single apiKey.
            if (providerConfig?.accessKeyId?.trim()) {
              parseFormData.append('accessKeyId', providerConfig.accessKeyId);
            }
            if (providerConfig?.accessKeySecret?.trim()) {
              parseFormData.append('accessKeySecret', providerConfig.accessKeySecret);
            }

            const parseResponse = await fetch('/api/extract-document', {
              method: 'POST',
              body: parseFormData,
              signal,
            });

            if (!parseResponse.ok) {
              const errorData = await parseResponse.json();
              throw new Error(errorData.error || t('generation.courseMaterialParseFailed'));
            }

            const parseResult = await parseResponse.json();
            if (!parseResult.success || !parseResult.data) {
              throw new Error(t('generation.courseMaterialParseFailed'));
            }

            const rawImages = parseResult.data.metadata?.pdfImages;
            const images = rawImages
              ? rawImages.map((img: ParsedDocumentResponseImage) => ({
                  id: img.id,
                  src: img.src || '',
                  pageNumber: img.pageNumber ?? 1,
                  description: img.description,
                  width: img.width,
                  height: img.height,
                }))
              : ((parseResult.data.images as string[] | undefined) ?? []).map((src, i) => ({
                  id: `img_${i + 1}`,
                  src,
                  pageNumber: 1,
                }));

            return {
              source: {
                id: source.id,
                name: source.name,
                size: source.size,
                lastModified: source.lastModified,
                mimeType: source.mimeType,
                order: source.order,
                providerId,
              },
              text: parseResult.data.text as string,
              rawTextLength: (parseResult.data.text as string).length,
              pageCount: parseResult.data.metadata?.pageCount,
              images,
            };
          }),
        );

        const bundle = buildDocumentBundle(parsedParts);
        const imageStorageIds = await storeImages(bundle.images);

        const pdfImages: PdfImage[] = bundle.images.map((img, i) => ({
          id: img.id,
          src: '',
          pageNumber: img.pageNumber,
          description: img.description,
          width: img.width,
          height: img.height,
          originalId: img.originalId,
          sourceDocumentId: img.sourceDocumentId,
          sourceDocumentName: img.sourceDocumentName,
          sourceDocumentOrder: img.sourceDocumentOrder,
          visionPriority: img.visionPriority,
          storageId: imageStorageIds[i],
        }));

        // Update session with extracted document data
        const updatedSession = {
          ...currentSession,
          documentSources,
          pdfText: bundle.text,
          pdfImages,
          imageStorageIds,
          pdfStorageKey: undefined, // Clear so we don't re-parse
        };
        persistSession(updatedSession);

        // Truncation warnings
        const warnings: string[] = [];
        if (bundle.totalRawTextLength > bundle.textContentBudget) {
          warnings.push(t('generation.textTruncated', { n: bundle.textContentBudget }));
        }
        if (bundle.totalImageCount > MAX_VISION_IMAGES) {
          warnings.push(
            t('generation.imageTruncated', {
              total: bundle.totalImageCount,
              max: MAX_VISION_IMAGES,
            }),
          );
        }
        if (warnings.length > 0) {
          setTruncationWarnings(warnings);
        }

        // Reassign local reference for subsequent steps
        currentSession = updatedSession;
      }

      // Step: Web Search (if enabled)
      if (currentSession.requirements.webSearch) {
        setCurrentStepId('web-search');
        setWebSearchSources([]);

        const wsSettings = useSettingsStore.getState();
        const wsProviderId = wsSettings.webSearchProviderId;
        const wsConfig = wsSettings.webSearchProvidersConfig?.[wsProviderId];
        const research = await fetchGenerationResearch(
          withThinkingConfig({
            query: currentSession.requirements.requirement,
            pdfText: currentSession.pdfText || undefined,
            providerId: wsProviderId,
            apiKey: wsConfig?.apiKey || undefined,
            baseUrl: wsConfig?.baseUrl || undefined,
            zhihuFilter: wsConfig?.filter || undefined,
            zhihuSearchDB: wsConfig?.searchDB || undefined,
          }),
          getApiHeaders(),
          signal,
        );
        if (!research.ok) {
          setTruncationWarnings((warnings) =>
            warnings.includes(t('generation.webSearchFailed'))
              ? warnings
              : [...warnings, t('generation.webSearchFailed')],
          );
        }
        setWebSearchSources(research.researchSources);

        const updatedSessionWithSearch = {
          ...currentSession,
          researchContext: research.researchContext,
          researchSources: research.researchSources,
        };
        persistSession(updatedSessionWithSearch);
        currentSession = updatedSessionWithSearch;
      }

      // Load imageMapping early (needed for both outline and scene generation)
      let imageMapping: ImageMapping = {};
      if (currentSession.imageStorageIds && currentSession.imageStorageIds.length > 0) {
        log.debug('Loading images from IndexedDB');
        imageMapping = await loadImageMapping(currentSession.imageStorageIds);
      } else if (
        currentSession.imageMapping &&
        Object.keys(currentSession.imageMapping).length > 0
      ) {
        log.debug('Using imageMapping from session (old format)');
        imageMapping = currentSession.imageMapping;
      }

      // The homepage allocates this identity once. Legacy sessions are
      // normalized from sessionId above; never mint a new stage on retry or
      // refresh, otherwise the generated course would lose its durable C key.
      const identity = resolveGenerationIdentity(currentSession);
      if (
        currentSession.courseId !== identity.courseId ||
        currentSession.stageId !== identity.stageId ||
        currentSession.lessonId !== identity.lessonId
      ) {
        currentSession = withGenerationIdentity(currentSession);
        persistSession(currentSession);
      }
      const { courseId, stageId, lessonId } = identity;
      const learnerId = await getLearnerKey();
      signal.throwIfAborted();
      // A6/J2.0: load the learner-only profile before any confirmation or
      // generation request. This is read-only; an absent L session is not
      // created. `buildTeacherContext` enforces new-course scope (L only).
      const memoryContext = await loadNewCourseMemoryContext({
        store: getRuntimeStore(),
        stageId,
        learnerId,
        requirements: currentSession.requirements,
      });
      signal.throwIfAborted();
      newCourseMemoryContextRef.current = memoryContext;
      const stage: Stage = {
        id: stageId,
        name: extractTopicFromRequirement(currentSession.requirements.requirement),
        description: '',
        style: 'professional',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        interactiveMode: false,
        taskEngineMode: currentSession.taskEngineMode === true,
      };

      // ── Generate outlines first (infers languageDirective) ──
      let outlines = currentSession.sceneOutlines;
      let languageDirective = currentSession.languageDirective;
      let courseTitle = currentSession.courseTitle;

      setCurrentStepId('outline');
      const needsOutlineGeneration = !outlines || outlines.length === 0;
      if (needsOutlineGeneration) {
        // ── A3 课前确认（生成教案之前，docs/spec/02 生成预览节）──
        // 学习者在这里与 Agent 老师交互：回答按需追问、勾选范围；答案写进
        // requirements，随后的大纲与教案生成都以此为输入。可全部跳过。
        const confirmation = await runPreLessonConfirmation(currentSession, signal, stage.id);
        signal.throwIfAborted();
        currentSession = {
          ...currentSession,
          requirements: confirmation.requirements,
          confirmationDone: true,
          ...(confirmation.skipped ? { confirmationSkipped: true } : {}),
        };

        // J2.0c / A6: generation start is the first durable C write. Resume of
        // an already-outlined deck (J4.4 back to preview) must not rewrite C.
        const generationIntake = buildGenerationCourseIntake({
          requirements: currentSession.requirements,
          skipped: currentSession.confirmationSkipped,
          now: generationStartedAtRef.current,
        });
        await persistGenerationCourseIntake({
          store: getRuntimeStore(),
          stageId,
          learnerId,
          courseId,
          intake: generationIntake,
        });
      }

      if (needsOutlineGeneration) {
        log.debug('=== Generating outlines (SSE) ===');
        setStreamingOutlines([]);

        const outlineResponse = await fetch('/api/generate/scene-outlines-stream', {
          method: 'POST',
          headers: getApiHeaders(),
          body: JSON.stringify(
            withThinkingConfig({
              requirements: currentSession.requirements,
              pdfText: currentSession.pdfText,
              pdfImages: currentSession.pdfImages,
              imageMapping,
              researchContext: currentSession.researchContext,
              teacherContext: newCourseMemoryContextRef.current?.teacherContext.text || undefined,
            }),
          ),
          signal,
        });
        const outlineResult = await readOutlineStream(outlineResponse, {
          signal,
          onOutlines: (outlines) => {
            setStreamingOutlines(outlines);
            if (outlines.length > 0) setStatusMessageKey('');
          },
          onRetry: () => setStatusMessageKey('generation.outlineRetrying'),
          messages: {
            failed: t('generation.outlineGenerateFailed'),
            empty: t('generation.outlineEmptyResponse'),
            unreadable: t('generation.streamNotReadable'),
          },
        });
        signal.throwIfAborted();

        outlines = outlineResult.outlines;
        languageDirective = outlineResult.languageDirective;
        courseTitle = outlineResult.courseTitle;
        const effectiveTaskEngineMode = outlineResult.taskEngineMode;

        // 大纲（场景骨架）只是教案的输入，学习者不审阅（docs/spec/02 生成预览节）。
        // 落盘后直接进入教案设计；刷新恢复时从教案步骤继续。
        const updatedSession: GenerationSessionState = {
          ...currentSession,
          sceneOutlines: outlines,
          languageDirective,
          courseTitle,
          taskEngineMode: effectiveTaskEngineMode,
          previewPhase: 'generating-content',
        };
        persistSession(updatedSession);
        currentSession = updatedSession;
        setStreamingOutlines(outlines);

        // Generation is committed (outlines succeeded and the flow continues
        // automatically). Safe to wipe the homepage draft cache now.
        try {
          localStorage.removeItem('requirementDraft');
        } catch {
          /* ignore */
        }
      }

      if (!outlines || outlines.length === 0) {
        throw new Error(t('generation.outlineEmptyResponse'));
      }

      // ── A1: lesson plan — design before content (docs/spec/05 A1) ──
      // The plan is part of the resumable generation envelope. A valid
      // persisted plan wins; only a missing plan invokes the API. New lessons
      // require a main-agent visual direction before page generation. Node
      // design can degrade server-side, but a missing direction stays retryable.
      setCurrentStepId('lesson-plan');
      let generatedLessonPlan: LessonPlan;
      if (currentSession.lessonPlan !== undefined && currentSession.lessonPlan !== null) {
        generatedLessonPlan = resolveGenerationLessonPlan({
          session: currentSession,
          outlines,
          courseId,
          stageId: stage.id,
          requirement: currentSession.requirements.requirement,
          courseTitle,
        }).plan;
      } else {
        let apiCandidate: unknown;
        try {
          setStatusMessageKey('lessonPlan.preparing');
          const lessonPlanRes = await fetch('/api/generate/lesson-plan', {
            method: 'POST',
            headers: getApiHeaders(),
            body: JSON.stringify(
              withThinkingConfig({
                requirements: currentSession.requirements,
                outlines,
                courseId,
                lessonId,
                stageId: stage.id,
                courseTitle,
                languageDirective,
                htmlPresentation: true,
              }),
            ),
            signal,
          });
          if (lessonPlanRes.ok) {
            const lessonPlanData: unknown = await lessonPlanRes.json();
            apiCandidate = (lessonPlanData as { lessonPlan?: unknown } | null)?.lessonPlan;
          } else {
            throw new Error(t('generation.generationFailed'));
          }
        } finally {
          setStatusMessageKey('');
        }
        generatedLessonPlan = resolveGenerationLessonPlan({
          session: currentSession,
          outlines,
          courseId,
          stageId: stage.id,
          requirement: currentSession.requirements.requirement,
          courseTitle,
          apiCandidate,
          requireHtmlPresentation: true,
        }).plan;
      }

      // Persist immediately, before any scene/content request. Refreshes and
      // retries therefore reuse this exact plan and timestamp, and C
      // initialization can safely use its stable `course:init:<courseId>` key.
      signal.throwIfAborted();
      currentSession = {
        ...currentSession,
        lessonPlan: generatedLessonPlan,
      };
      persistSession(currentSession);
      setLessonPlan(generatedLessonPlan);

      // A5 教案配图（docs/spec/04-detailed-design.md §5/§7）：把教案各节点
      // design.visualAids 合并进对应 outline 的 mediaGenerations，之后的逐场景
      // 内容生成、store.setOutlines 持久化与媒体 orchestrator 都读合并后的
      // outlines，媒体执行通道不变。
      outlines = applyVisualAidsToOutlines(generatedLessonPlan, outlines);

      // Move to next step
      setStatusMessageKey('');
      stage.taskEngineMode = currentSession.taskEngineMode === true;

      // Store languageDirective on the stage
      if (languageDirective) {
        stage.languageDirective = languageDirective;
      }

      // Adopt the LLM-inferred course title as the stage name when available,
      // replacing the raw-requirement placeholder set at stage creation time.
      if (courseTitle) {
        stage.name = courseTitle;
      }

      // ── 台上只有一位 Agent 老师（docs/spec/02：任何画面只面对一位 Agent）──
      // 角色生成 / 抽卡 / 助教 roster 已撤，固定使用内置教师人设。
      const agents = getDefaultAgents();
      stage.agentIds = agents.map((a) => a.id);

      // Move to scene generation step
      setStatusMessageKey('');
      if (!outlines || outlines.length === 0) {
        throw new Error(t('generation.outlineEmptyResponse'));
      }

      // Store stage and outlines. If this stage was already persisted (refresh
      // or homepage return during J2.1), hydrate first so completed scenes are
      // not wiped — setStage() clears scenes, and 成功段 must not be redone.
      const store = useStageStore.getState();
      stage.videoManifest = buildVideoManifestFromOutlines(outlines);
      if (store.stage?.id !== stageId) {
        await store.loadFromStorage(stageId);
      }
      signal.throwIfAborted();
      const hydrated = useStageStore.getState();
      if (hydrated.stage?.id === stageId) {
        useStageStore.setState({
          stage: {
            ...hydrated.stage,
            name: stage.name,
            languageDirective: stage.languageDirective ?? hydrated.stage.languageDirective,
            taskEngineMode: stage.taskEngineMode,
            agentIds: stage.agentIds,
            videoManifest: stage.videoManifest,
            updatedAt: Date.now(),
          },
        });
      } else {
        store.setStage(stage);
      }
      useStageStore.getState().setOutlines(outlines);
      // A1: persist the lesson plan inside the document outline snapshot so
      // reopening this classroom reads it directly instead of re-deriving.
      useStageStore.getState().setLessonPlan(generatedLessonPlan);

      // J2.0c → J2.1 (docs/spec/01-user-journeys.md, docs/spec/04 §6):
      // initialize the course-scoped C memory before requesting any scene
      // content. The repository's stable init key makes retries idempotent;
      // a failure stays in this preview and the generation envelope remains
      // available for the user to retry.
      const courseState = createCourseStateRepository({
        store: getRuntimeStore(),
        stageId,
        learnerId,
        courseId,
      });
      const courseSnapshot = await initializeCourseState({
        repository: courseState,
        courseId,
        stageId,
        lessonId,
        learnerId,
        lessonPlan: generatedLessonPlan,
      });
      signal.throwIfAborted();
      // Use the repository's returned projection as the single source of
      // truth. This also handles an identical retry that returns the original
      // snapshot rather than appending a second C record.
      store.setCoursePlan(courseSnapshot.coursePlan);

      // Advance to slide-content step
      setCurrentStepId('slide-content');

      // Build stageInfo and userProfile for API call
      const stageInfo = {
        name: stage.name,
        description: stage.description,
        style: stage.style,
      };

      const userProfile =
        currentSession.requirements.userNickname || currentSession.requirements.userBio
          ? `Student: ${currentSession.requirements.userNickname || 'Unknown'}${currentSession.requirements.userBio ? ` — ${currentSession.requirements.userBio}` : ''}`
          : undefined;

      // J2.1–J2.3: generate every segment on the preview page. Failed segments
      // stay failed for in-place retry; the learner enters the classroom only
      // after an explicit action once every segment is complete.
      store.setGeneratingOutlines(outlines);
      writeGenerationParams(sessionStorage, {
        courseId,
        stageId,
        lessonId,
        pdfImages: currentSession.pdfImages,
        imageMapping,
        agents,
        userProfile,
        languageDirective,
      });

      const saved = await store.saveToStorage();
      signal.throwIfAborted();
      if (!saved) {
        throw new Error(t('generation.generationFailed'));
      }
      persistSession({
        ...currentSession,
        currentStep: 'generating',
        previewPhase: 'generating-content',
      });

      const abortGeneration = () => stop();
      signal.addEventListener('abort', abortGeneration, { once: true });
      try {
        signal.throwIfAborted();
        await generateRemaining({
          pdfImages: currentSession.pdfImages,
          imageMapping,
          stageInfo,
          agents,
          userProfile,
          languageDirective,
        });
      } finally {
        signal.removeEventListener('abort', abortGeneration);
      }
    } catch (err) {
      // AbortError is expected when navigating away — don't show as error
      if (isAbortError(err)) {
        log.info('[GenerationPreview] Generation aborted');
        return;
      }
      // Keep the resumable generation envelope on every real failure. Some
      // confirmation/document steps may have persisted newer requirements
      // immediately before throwing, so prefer the latest stored envelope and
      // only fall back to the local copy when storage is unreadable.
      try {
        const saved = sessionStorage.getItem('generationSession');
        if (saved) {
          const persisted = withGenerationIdentity(JSON.parse(saved) as GenerationSessionState);
          sessionStorage.setItem('generationSession', JSON.stringify(persisted));
        } else {
          sessionStorage.setItem(
            'generationSession',
            JSON.stringify(withGenerationIdentity(currentSession)),
          );
        }
      } catch (persistError) {
        log.error('Failed to preserve generation session after generation error:', persistError);
        // Do not mask the original generation failure with a persistence error.
      }
      setStreamingOutlines(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const extractTopicFromRequirement = (requirement: string): string => {
    const trimmed = requirement.trim();
    if (trimmed.length <= 500) {
      return trimmed;
    }
    return trimmed.substring(0, 500).trim() + '...';
  };

  const goBackToHome = () => {
    abortControllerRef.current?.abort();
    // Keep the resumable envelope so the homepage can reopen this preview
    // (docs/spec/01 J4.4 / docs/spec/04 §7).
    router.push('/');
  };

  /** Retry the current generation in place.  Returning home is the destructive
   * action; a generation failure must keep its session and every completed
   * outline/plan so the next attempt can resume with the same identities. */
  const retryGeneration = () => {
    let retrySession = session;
    try {
      const saved = sessionStorage.getItem('generationSession');
      if (saved) retrySession = withGenerationIdentity(JSON.parse(saved) as GenerationSessionState);
    } catch (cause) {
      log.warn('Could not read the persisted generation session for retry:', cause);
    }
    if (!retrySession) return;

    setSession(retrySession);
    setError(null);
    setStatusMessageKey('');
    setConfirmStep({ kind: 'idle' });
    hasStartedRef.current = true;
    void startGeneration(retrySession);
  };

  const retrySegment = async (outlineId: string) => {
    if (retryingSegmentId || generationStatus === 'generating') return;
    const target = segments.find((segment) => segment.outlineId === outlineId);
    if (!target || !canRetrySegment(target.status)) return;
    setRetryingSegmentId(outlineId);
    try {
      await retrySingleOutline(outlineId);
    } finally {
      setRetryingSegmentId(null);
    }
  };

  const enterClassroom = async () => {
    if (!canEnterClassroom(segments, enteringClassroom)) return;
    setEnteringClassroom(true);
    setEnterError(null);
    try {
      const store = useStageStore.getState();
      const saved = await store.saveToStorage();
      const stageId = classroomEnterTarget({ saved, stageId: store.stage?.id });
      if (!stageId) {
        throw new Error(t('generation.enterClassroomFailed'));
      }
      sessionStorage.setItem(PENDING_CLASSROOM_ENTER_KEY, stageId);
      setPendingEnterFailed(false);
      router.push(`/classroom/${stageId}`);
    } catch (cause) {
      log.warn('[GenerationPreview] Enter classroom failed:', cause);
      setEnterError(t('generation.enterClassroomFailed'));
      setEnteringClassroom(false);
    }
  };

  if (!sessionLoaded) {
    return (
      <PreviewShell phase="loading" onBack={goBackToHome}>
        <div className="flex min-h-40 items-center justify-center">
          <GameLoader size="lg" label={t('common.loading')} />
        </div>
      </PreviewShell>
    );
  }

  if (sessionLoadFailed) {
    return (
      <PreviewShell phase="load-error" onBack={goBackToHome}>
        <div className="flex min-w-0 flex-col gap-4">
          <p className="text-sm leading-relaxed text-destructive" role="alert">
            {t('generation.sessionLoadFailed')}
          </p>
          <Button
            className="h-auto min-h-11 min-w-0 max-w-full self-start rounded-xl px-4 py-3 whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none"
            onClick={() => {
              setSessionLoaded(false);
              setSessionLoadAttempt((attempt) => attempt + 1);
            }}
          >
            {t('clarify.retry')}
          </Button>
        </div>
      </PreviewShell>
    );
  }

  if (!session) {
    return (
      <PreviewShell phase="missing-session" onBack={goBackToHome}>
        <div className="flex min-w-0 flex-col gap-4">
          <AlertCircle aria-hidden className="size-8 text-muted-foreground" />
          <h2 className="text-xl font-semibold leading-tight tracking-tight">
            {t('generation.sessionNotFound')}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('generation.sessionNotFoundDesc')}
          </p>
          <Button
            onClick={() => router.push('/')}
            className="h-auto min-h-11 w-full min-w-0 gap-2 rounded-xl px-4 py-3 whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none"
          >
            <ArrowLeft aria-hidden className="size-4" />
            {t('generation.backToHome')}
          </Button>
        </div>
      </PreviewShell>
    );
  }

  const activeStep = activeSteps.find((step) => step.id === currentStepId) ?? ALL_STEPS[2];
  const activeStepText = getGenerationStepText(activeStep, session);
  const enterClassroomError =
    enterError ?? (pendingEnterFailed ? t('generation.enterClassroomFailed') : null);

  const phase = error
    ? 'error'
    : confirmStep.kind !== 'idle'
      ? confirmStep.kind
      : deckReady
        ? 'ready'
        : `${currentStepId}-${showSegmentWorkspace ? 'segments' : 'preparing'}`;
  const failedSegmentIds = segments
    .filter((segment) => segment.status === 'failed')
    .map((segment) => segment.outlineId)
    .join(',');

  const footer = (
    <>
      {error ? (
        <Button
          size="lg"
          className="lc-rise h-auto min-h-11 min-w-0 max-w-full rounded-xl px-6 py-3 whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none"
          onClick={retryGeneration}
        >
          {t('clarify.retry')}
        </Button>
      ) : deckReady && confirmStep.kind === 'idle' ? (
        <Button
          size="lg"
          className="lc-rise h-auto min-h-12 min-w-0 max-w-full gap-2 rounded-2xl px-8 py-3 text-base whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none sm:min-w-56"
          data-testid="enter-classroom"
          disabled={enteringClassroom}
          aria-busy={enteringClassroom}
          onClick={() => void enterClassroom()}
        >
          {enteringClassroom && <GameLoader size="sm" />}
          {t(enteringClassroom ? 'generation.enteringClassroom' : 'generation.enterClassroom')}
        </Button>
      ) : null}
      {enterClassroomError && (
        <p
          data-testid="enter-classroom-error"
          className="text-sm leading-relaxed text-destructive"
          role="alert"
        >
          {enterClassroomError}
        </p>
      )}
    </>
  );

  return (
    <PreviewShell
      phase={phase}
      transitionKey={`${phase}:${lessonPlan?.id ?? 'pending-plan'}:${failedSegmentIds}`}
      onBack={goBackToHome}
      footer={footer}
    >
      {confirmStep.kind !== 'idle' && !error ? (
        <div className="min-w-0">
          {(confirmStep.kind === 'loading-clarify' || confirmStep.kind === 'loading-scope') && (
            <div className="flex min-w-0 items-start gap-4 py-4" role="status" aria-busy="true">
              <GameLoader size="md" className="shrink-0" />
              <h2 className="min-w-0 text-xl font-semibold leading-snug tracking-tight">
                {t(
                  confirmStep.kind === 'loading-clarify'
                    ? 'clarify.loading'
                    : 'clarify.loadingScope',
                )}
              </h2>
            </div>
          )}
          {confirmStep.kind === 'questions' && (
            <ClarifyCard
              questions={confirmStep.questions}
              onSkip={() => settleConfirm({ type: 'skip' })}
              onContinue={(answers) => settleConfirm({ type: 'continue', answers })}
            />
          )}
          {confirmStep.kind === 'scope' && (
            <ScopePicker
              knowledgeMap={confirmStep.knowledgeMap}
              submitting={confirmStep.submitting}
              error={confirmStep.error}
              onSkip={() => settleConfirm({ type: 'skip' })}
              onStart={(selectedTopics) => settleConfirm({ type: 'start', selectedTopics })}
            />
          )}
          {(confirmStep.kind === 'clarify-error' || confirmStep.kind === 'scope-error') && (
            <ConfirmationFailurePanel
              kind={confirmStep.kind}
              onRetry={() => settleConfirm({ type: 'retry' })}
              onSkip={() => settleConfirm({ type: 'skip' })}
            />
          )}
        </div>
      ) : (
        <div className="min-w-0 space-y-6">
          <div role={error ? 'alert' : 'status'} className="min-w-0 space-y-4">
            <div className="flex size-11 items-center justify-center">
              {error || hasFailedSegments ? (
                <span className="flex size-11 items-center justify-center rounded-2xl bg-destructive/10">
                  <AlertCircle aria-hidden className="size-5 text-destructive" />
                </span>
              ) : !deckReady ? (
                <GameLoader size="lg" />
              ) : (
                <span className="lc-success-mark">
                  <svg viewBox="0 0 24 24" fill="none" className="size-5" aria-hidden="true">
                    <path
                      className="lc-check-path"
                      d="M5 12.5l4.5 4.5L19 7.5"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      pathLength={1}
                    />
                  </svg>
                </span>
              )}
            </div>
            <div className="min-w-0 space-y-2">
              <h2
                data-testid="preview-status-title"
                className="text-xl font-semibold leading-snug tracking-tight"
              >
                {error
                  ? t('generation.generationFailed')
                  : deckReady
                    ? t('generation.generationComplete')
                    : hasFailedSegments
                      ? t('preparationVisual.segmentsFailedTitle')
                      : t('generation.preparationTitle')}
              </h2>
              <p
                className={cn(
                  'text-sm leading-relaxed',
                  error ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {error ||
                  (deckReady
                    ? t('generation.classroomReady')
                    : hasFailedSegments
                      ? t('preparationVisual.segmentsFailedHelp')
                      : t(statusMessageKey || activeStepText.description))}
              </p>
            </div>
          </div>
          {activeStep.id === 'web-search' && webSearchSources.length > 0 && !error && (
            <ul className="space-y-2 text-sm leading-relaxed text-muted-foreground">
              {webSearchSources.slice(0, 4).map((source, index) => (
                <li key={index}>{source.title}</li>
              ))}
            </ul>
          )}
          {truncationWarnings.length > 0 && !error && !deckReady && (
            <ul className="space-y-2 border-s-2 border-border ps-4 text-sm leading-relaxed text-muted-foreground">
              {truncationWarnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}
          {!error && !deckReady && currentStepId !== 'slide-content' && (
            <PreparationSteps steps={activeSteps} currentStepId={currentStepId} session={session} />
          )}
          {!error && !showSegmentWorkspace && currentStepId === 'outline' && (
            <PreparationTransition transitionKey={`outline-${streamingOutlines?.length ?? 0}`}>
              <div data-testid="outline-stream-preview" className="min-h-28" aria-busy="true">
                {streamingOutlines?.length ? (
                  <ol className="space-y-2 text-sm leading-relaxed text-muted-foreground">
                    {streamingOutlines.slice(-4).map((outline) => (
                      <li key={outline.id} className="lc-preparation-enter flex min-w-0 gap-3">
                        <span className="shrink-0 tabular-nums">{outline.order + 1}.</span>
                        <span className="min-w-0">{outline.title}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div aria-hidden="true" className="space-y-3 py-1">
                    {[75, 90, 60].map((width) => (
                      <div
                        key={width}
                        className="h-3 rounded bg-muted"
                        style={{ width: `${width}%` }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </PreparationTransition>
          )}
          {lessonPlan && confirmStep.kind === 'idle' ? (
            <LessonPlanPanel plan={lessonPlan} compact={showSegmentWorkspace} />
          ) : null}
          {showSegmentWorkspace && (
            <SegmentList
              segments={segments}
              onRetry={(outlineId) => void retrySegment(outlineId)}
              retryingId={retryingSegmentId}
              generationBusy={generationStatus === 'generating'}
            />
          )}
        </div>
      )}
    </PreviewShell>
  );
}

function PreviewShell({
  phase,
  transitionKey = phase,
  onBack,
  children,
  footer,
}: {
  phase: string;
  transitionKey?: string;
  onBack: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <main className="lc-preview-shell min-h-[100dvh] w-full bg-background p-4 text-left text-foreground sm:p-6 lg:p-8">
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6 [overflow-wrap:anywhere]">
        <header className="min-w-0 space-y-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-auto min-h-11 gap-2 rounded-xl px-3 py-3 whitespace-normal motion-reduce:transition-none"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden className="size-4" />
            {t('generation.backToHome')}
          </Button>
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              LiveCourse
            </p>
            <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">
              {t('preparationVisual.title')}
            </h1>
          </div>
        </header>
        <section
          data-testid="preparation-surface"
          data-phase={phase}
          className="lc-preview-card min-w-0 rounded-2xl bg-card p-4 sm:p-6 lg:p-8"
        >
          <PreparationTransition
            transitionKey={transitionKey}
            pending={phase === 'loading' || phase.startsWith('loading-')}
          >
            {children}
          </PreparationTransition>
        </section>
        <div className="flex min-h-16 min-w-0 flex-col items-stretch gap-3 pb-4 sm:items-end">
          {footer}
        </div>
      </div>
    </main>
  );
}

export default function GenerationPreviewPage() {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <PreviewShell phase="loading" onBack={() => router.push('/')}>
          <div className="flex min-h-40 items-center justify-center">
            <GameLoader size="lg" label={t('common.loading')} />
          </div>
        </PreviewShell>
      }
    >
      <GenerationPreviewContent />
    </Suspense>
  );
}
