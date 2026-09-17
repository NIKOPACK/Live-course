'use client';

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useSettingsStore } from '@/lib/store/settings';
import { claimStageSceneLoadToken, isCurrentStageSceneLoadToken } from '@/lib/store/stage';
import { loadImageMapping } from '@/lib/utils/image-storage';
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ComponentProps,
} from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import {
  applyClassroomStageAndScenes,
  defaultClassroomLoadDeps,
  runClassroomLoad,
} from '@/lib/classroom/load-classroom';
import { LiveCourseSessionProvider, useLiveCourseSession } from '@/lib/livecourse/session/context';
import { needsFinalizationRecovery } from '@/lib/livecourse/session/finalization-recovery';
import { createCourseStateRepository } from '@/lib/livecourse/session/course-state-repository';
import { resolveCourseIdentity } from '@/lib/livecourse/session/course-identity';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import {
  ClassroomLifecycleOverlay,
  PostClassChoice,
} from '@/components/livecourse/ClassroomLifecycleOverlay';
import { ClassroomSessionBoundary } from '@/components/livecourse/ClassroomSessionBoundary';
import { LiveCourseReplayHost } from '@/components/livecourse/LiveCourseReplayHost';
import { ReplayPresentationBoundary } from '@/components/livecourse/ReplayPresentationBoundary';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { useI18n } from '@/lib/hooks/use-i18n';
import { TriangleAlert } from 'lucide-react';
import {
  GenerationParamsError,
  PENDING_CLASSROOM_ENTER_FAILED_KEY,
  PENDING_CLASSROOM_ENTER_KEY,
  readGenerationParams,
  type StageGenerationParams,
} from '@/lib/livecourse/session/generation-params';
import { LEGACY_CLASSROOM_ERROR } from '@/lib/livecourse/lesson/html-classroom';

const log = createLogger('Classroom');

export default function ClassroomDetailPage() {
  return (
    <Suspense fallback={<GameLoader />}>
      <ClassroomRoute />
    </Suspense>
  );
}

function ClassroomRoute() {
  const params = useParams();
  const search = useSearchParams();
  return (
    <ClassroomDetailContent
      key={`${params?.id}:${search.toString()}`}
      replayRequested={search.get('replay') === '1'}
      replayFrom={search.get('from') === 'post' ? 'post' : 'home'}
    />
  );
}

function ClassroomTeachingContent({
  onFinalized,
  ...stageProps
}: ComponentProps<typeof Stage> & { onFinalized: () => void }) {
  const { classroomState } = useLiveCourseSession();
  return (
    <>
      {classroomState !== 'finalizing' && classroomState !== 'completed' ? (
        <Stage {...stageProps} />
      ) : null}
      <ClassroomLifecycleOverlay onFinalized={onFinalized} />
    </>
  );
}

function ClassroomDetailContent({
  replayRequested,
  replayFrom,
}: {
  replayRequested: boolean;
  replayFrom: 'home' | 'post';
}) {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const classroomId = params?.id as string;

  const { loadFromStorage } = useStageStore();
  const loadedStage = useStageStore((state) => state.stage);
  const persistedCoursePlan = useStageStore((state) => state.coursePlan);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * The route id is a durable stage id, not necessarily the course id.  Wait
   * until the stage/document has hydrated before resolving the identity used
   * by C/W repositories.  A present but malformed/unrelated plan is an
   * explicit load error; it must not silently fall back to the route id.
   */
  const courseIdentityResolution = useMemo(() => {
    if (loading) return { identity: null, error: null };
    if (!loadedStage || loadedStage.id !== classroomId) {
      return {
        identity: null,
        error: `Classroom ${JSON.stringify(classroomId)} is not available`,
      };
    }
    try {
      return {
        identity: resolveCourseIdentity({
          stageId: classroomId,
          coursePlan: persistedCoursePlan,
        }),
        error: null,
      };
    } catch (cause) {
      return {
        identity: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [classroomId, loadedStage, loading, persistedCoursePlan]);

  const displayError = error ?? courseIdentityResolution.error;

  const pendingEnter =
    typeof window !== 'undefined' &&
    sessionStorage.getItem(PENDING_CLASSROOM_ENTER_KEY) === classroomId;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem(PENDING_CLASSROOM_ENTER_KEY) !== classroomId) return;
    if (displayError) {
      sessionStorage.setItem(PENDING_CLASSROOM_ENTER_FAILED_KEY, '1');
      router.replace('/generation-preview');
      return;
    }
    if (!loading) {
      sessionStorage.removeItem(PENDING_CLASSROOM_ENTER_KEY);
      sessionStorage.removeItem(PENDING_CLASSROOM_ENTER_FAILED_KEY);
      sessionStorage.removeItem('generationSession');
    }
  }, [classroomId, displayError, loading, router]);

  // A2 生命周期视图：teach →（finalizing 自动归档成功）→ post（J4.1 课后
  // 选择）→ replay（J4.2/J4.4 再听）。?replay=1&from=home|post 直接进入再听。
  const [view, setView] = useState<'teach' | 'post' | 'replay'>(() =>
    replayRequested ? 'replay' : 'teach',
  );
  const [archiveStatus, setArchiveStatus] = useState<
    'checking' | 'active' | 'recovering' | 'archived' | 'error'
  >('checking');
  const [replayEntry, setReplayEntry] = useState<'home' | 'post'>(replayFrom);

  // The initial route query decides whether the document loader is allowed to
  // perform maintenance writes. Keep this as a ref so switching between the
  // post/replay presentation states does not re-run the classroom load with a
  // different write policy, while retrying a failed replay still remains
  // read-only.
  const replayReadOnlyRef = useRef(view === 'replay');
  replayReadOnlyRef.current = view === 'replay';

  // J4.1 恢复列：重新加载已归档课程的课堂页时，必须回到同一课后选择态，
  // 而不是面对一个空 W 的教学视图（也不允许再次 finalization）。
  useEffect(() => {
    const identity = courseIdentityResolution.identity;
    if (loading || error || !identity) return;
    let cancelled = false;
    void (async () => {
      try {
        const learnerId = await getLearnerKey();
        const snapshot = await createCourseStateRepository({
          store: getRuntimeStore(),
          stageId: classroomId,
          learnerId,
          courseId: identity.courseId,
        }).load();
        if (cancelled) return;
        if (snapshot?.lifecycle?.status !== 'archived') {
          setArchiveStatus('active');
          return;
        }
        const recovering = await needsFinalizationRecovery(snapshot, getRuntimeStore());
        if (cancelled) return;
        setArchiveStatus(recovering ? 'recovering' : 'archived');
        setView((current) => {
          if (current === 'replay') return current;
          if (recovering) return 'teach';
          return current === 'teach' ? 'post' : current;
        });
      } catch (cause) {
        // Keep the route blocked until the archive check has a definitive
        // result; starting teaching while the check is unresolved can create
        // a new W for an already archived course.
        if (!cancelled) {
          setArchiveStatus('error');
          setError(cause instanceof Error ? cause.message : 'Unable to verify classroom lifecycle');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [classroomId, courseIdentityResolution.identity, error, loading]);

  const generationStartedRef = useRef(false);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const loadClassroom = useCallback(
    async (isEffectCurrent: () => boolean = () => true) => {
      const loadToken = claimStageSceneLoadToken();
      const isCurrent = () => isEffectCurrent() && isCurrentStageSceneLoadToken(loadToken);

      await runClassroomLoad({
        classroomId,
        readOnly: replayReadOnlyRef.current,
        loadToken,
        isCurrent,
        loadFromStorage,
        getCurrentStage: () => useStageStore.getState().stage,
        fetchClassroom: defaultClassroomLoadDeps.fetchClassroom,
        applyFallbackScenes: (args) =>
          defaultClassroomLoadDeps.applyFallbackScenes({
            ...args,
            isCurrent,
            applyStageAndScenes: applyClassroomStageAndScenes,
          }),
        loadRestoredMediaTasks: defaultClassroomLoadDeps.loadRestoredMediaTasks,
        applyRestoredMediaTasks: defaultClassroomLoadDeps.applyRestoredMediaTasks,
        discardRestoredMediaTasks: defaultClassroomLoadDeps.discardRestoredMediaTasks,
        loadLegacyAgentFallbacks: defaultClassroomLoadDeps.loadLegacyAgentFallbacks,
        commitMigratedAgentConfigs: defaultClassroomLoadDeps.commitMigratedAgentConfigs,
        applyGeneratedAgents: defaultClassroomLoadDeps.applyGeneratedAgents,
        getSettings: () => useSettingsStore.getState(),
        getAgent: (id) => useAgentRegistry.getState().getAgent(id),
        restoreAgentSelection: defaultClassroomLoadDeps.restoreAgentSelection,
        setError,
        setLoading,
        log,
      });
    },
    [classroomId, loadFromStorage],
  );

  useEffect(() => {
    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    setLoading(true);
    setError(null);
    generationStartedRef.current = false;

    // Clear previous classroom's media tasks to prevent cross-classroom contamination.
    // Placeholder IDs (gen_img_1, gen_vid_1) are NOT globally unique across stages,
    // so stale tasks from a previous classroom would shadow the new one's.
    const mediaStore = useMediaGenerationStore.getState();
    mediaStore.revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Clear whiteboard history to prevent snapshots from a previous course leaking in.
    useWhiteboardHistoryStore.getState().clearHistory();

    let cancelled = false;
    loadClassroom(() => !cancelled);

    // Cancel ongoing generation when classroomId changes or component unmounts
    return () => {
      cancelled = true;
      stop();
    };
  }, [classroomId, loadClassroom, stop]);

  // Auto-resume generation for pending outlines
  useEffect(() => {
    // Resolve archival before starting teaching-side generation. A post-class
    // reload and replay both present persisted content without restarting it.
    if (
      view !== 'teach' ||
      archiveStatus !== 'active' ||
      loading ||
      displayError ||
      generationStartedRef.current
    )
      return;

    const state = useStageStore.getState();
    const { outlines, scenes, stage, generationComplete } = state;

    // Check if there are pending outlines. A finished deck is frozen for
    // editing: deleting a slide leaves its outline orphaned, but that must not
    // be treated as an interrupted generation and regenerated. Only resume
    // when generation has not completed.
    const completedOrders = new Set(scenes.map((s) => s.order));
    const hasPending = !generationComplete && outlines.some((o) => !completedOrders.has(o.order));

    if (hasPending && stage) {
      let generationParams: StageGenerationParams | null;
      try {
        generationParams = readGenerationParams(sessionStorage, stage.id);
        if (
          generationParams &&
          (generationParams.courseId !== courseIdentityResolution.identity?.courseId ||
            generationParams.lessonId !== courseIdentityResolution.identity?.lessonId)
        ) {
          throw new GenerationParamsError(
            `Generation parameters identity does not match classroom ${JSON.stringify(stage.id)}`,
          );
        }
      } catch (cause) {
        log.error('[Classroom] Refusing unscoped or invalid generation params:', cause);
        setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      generationStartedRef.current = true;

      // Load generation params from the stage-scoped envelope stored by
      // generation-preview. A missing envelope is valid for legacy decks;
      // malformed, cross-stage, or cross-course data was rejected above.
      const params: Partial<StageGenerationParams> = generationParams ?? {};

      // Reconstruct imageMapping from IndexedDB using pdfImages storageIds
      const storageIds = (params.pdfImages || [])
        .map((img: { storageId?: string }) => img.storageId)
        .filter((storageId): storageId is string => Boolean(storageId));

      loadImageMapping(storageIds).then((imageMapping) => {
        generateRemaining({
          pdfImages: params.pdfImages,
          imageMapping,
          stageInfo: {
            name: stage.name || '',
            description: stage.description,
            style: stage.style,
          },
          agents: params.agents,
          userProfile: params.userProfile,
          languageDirective: params.languageDirective || stage.languageDirective,
        });
      });
    } else if (outlines.length > 0 && stage) {
      // All scenes are generated, but some media may not have finished.
      // Resume media generation for any tasks not yet in IndexedDB.
      // generateMediaForOutlines skips already-completed tasks automatically.
      generationStartedRef.current = true;
      // The deck reached the classroom already fully materialized (e.g. a
      // single-slide course, or a deck whose last slide finished in
      // generation-preview), so generateRemaining's completion path never
      // ran. Record completion now so a later edit/delete is not treated as
      // an interrupted generation. No-op if already complete or not all
      // outlines have scenes.
      useStageStore.getState().markGenerationCompleteIfDone();
      // Resume media only for outlines that still have a scene. On a finished
      // deck the user may have deleted a slide, leaving an orphaned outline;
      // generating its media would waste API calls on a slide that is gone.
      const materializedOrders = new Set(scenes.map((s) => s.order));
      const materializedOutlines = outlines.filter((o) => materializedOrders.has(o.order));
      generateMediaForOutlines(materializedOutlines, stage.id).catch((err) => {
        log.warn('[Classroom] Media generation resume error:', err);
      });
    }
  }, [
    archiveStatus,
    courseIdentityResolution.identity,
    displayError,
    generateRemaining,
    loading,
    view,
  ]);

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div className="lc-classroom-shell flex h-dvh min-h-0 flex-col overflow-hidden">
          {loading ||
          (pendingEnter && displayError) ||
          (archiveStatus === 'checking' && !displayError) ? (
            <div className="lc-classroom-fill flex flex-1 items-center justify-center">
              <GameLoader size="md" label={t('livecourse.classroomLoading')} />
            </div>
          ) : displayError ? (
            <div className="lc-classroom-fill flex flex-1 items-center justify-center">
              <div className="mx-auto max-w-lg px-6 py-8 text-center">
                <TriangleAlert
                  className="mx-auto mb-4 size-6 text-destructive"
                  aria-hidden="true"
                />
                <h1 className="text-2xl font-semibold text-foreground">
                  {t('livecourse.classroomLoadFailed')}
                </h1>
                <p
                  role="alert"
                  className="my-4 break-words text-sm leading-6 text-muted-foreground"
                >
                  {displayError === LEGACY_CLASSROOM_ERROR
                    ? t('livecourse.legacyClassroomUnsupported')
                    : displayError}
                </p>
                <button
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    loadClassroom();
                  }}
                  className="min-h-11 rounded-xl bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {t('livecourse.retry')}
                </button>
              </div>
            </div>
          ) : !courseIdentityResolution.identity ? (
            <div className="lc-classroom-fill flex flex-1 items-center justify-center">
              <GameLoader size="md" label={t('livecourse.classroomLoading')} />
            </div>
          ) : (
            <>
              <header className="lc-classroom-header">
                <div className="lc-classroom-header-copy">
                  <p className="lc-classroom-kicker">LiveCourse</p>
                  <h1>{loadedStage?.name ?? 'LiveCourse'}</h1>
                </div>
                <span className="lc-classroom-header-mark" aria-hidden="true" />
              </header>
              {view === 'replay' ? (
                // Keep the teaching provider out of the replay tree entirely.
                // `sessionEnabled={false}` only skipped hydration; its command
                // callbacks could still create a teaching W when playback
                // effects ran. Replay owns its separate replay W below.
                <ReplayPresentationBoundary>
                  {({ presentationStore, replayBridge }) => (
                    <>
                      <Stage
                        onRetryOutline={retrySingleOutline}
                        presentationOnly
                        presentationStore={presentationStore}
                        replayBridge={replayBridge}
                      />
                      <LiveCourseReplayHost
                        courseId={courseIdentityResolution.identity.courseId}
                        lessonId={courseIdentityResolution.identity.lessonId}
                        presentationStore={presentationStore}
                        replayBridge={replayBridge}
                        onAbort={() => {
                          // 加载失败按入口返回：首页同课选择态 / 课后选择态。
                          if (replayEntry === 'home') {
                            router.push(`/?course=${classroomId}`);
                          } else {
                            setView('post');
                          }
                        }}
                        onEnd={() => {
                          // J4.2/J4.4：replay W 销毁后按入口返回选择态。
                          if (replayEntry === 'home') {
                            router.push(`/?course=${classroomId}`);
                          } else {
                            setView('post');
                          }
                        }}
                      />
                    </>
                  )}
                </ReplayPresentationBoundary>
              ) : view === 'post' ? (
                <PostClassChoice
                  onReplay={() => {
                    setReplayEntry('post');
                    setView('replay');
                  }}
                />
              ) : (
                <LiveCourseSessionProvider
                  courseId={courseIdentityResolution.identity.courseId}
                  lessonId={courseIdentityResolution.identity.lessonId}
                  sessionEnabled
                >
                  <ClassroomSessionBoundary>
                    <ClassroomTeachingContent
                      onRetryOutline={retrySingleOutline}
                      onFinalized={() => setView('post')}
                    />
                  </ClassroomSessionBoundary>
                </LiveCourseSessionProvider>
              )}
            </>
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}
