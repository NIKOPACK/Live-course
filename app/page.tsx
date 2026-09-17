'use client';

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  BookOpen,
  Clock,
  MoreHorizontal,
  Settings,
  Sun,
  Moon,
  Monitor,
  Trash2,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { supportedLocales } from '@/lib/i18n';
import { createLogger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { SettingsDialog } from '@/components/settings';
import { deleteUserClassroom } from '@/lib/classroom/delete-user-classroom';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { useTheme } from '@/lib/hooks/use-theme';
import { nanoid } from 'nanoid';
import { deleteDocumentBlob, storeDocumentBlob } from '@/lib/utils/image-storage';
import { useCourseMaterials } from '@/lib/hooks/use-course-materials';
import type { UserRequirements } from '@/lib/types/generation';
import { useSettingsStore } from '@/lib/store/settings';
import { shouldRunGenerationWebSearch } from '@/lib/web-search/constants';
import { hasUsableLLMProvider } from '@/lib/store/settings-validation';
import { useUserProfileStore } from '@/lib/store/user-profile';
import {
  StageListItem,
  listStages,
  getFirstSlideByStages,
  loadStageData,
  resolveCourseCoverUrls,
  revokeCourseCoverUrls,
  revokeThumbnailSlideMediaUrls,
} from '@/lib/utils/stage-storage';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import type { Slide } from '@livecourse/dsl';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { SpeechButton } from '@/components/audio/speech-button';
import { LiveCourseMark } from '@/components/livecourse/LiveCourseMark';
import { HomeTeacherScene } from '@/components/livecourse/HomeTeacherScene';
import { GameLoader } from '@/components/livecourse/GameLoader';
import {
  CourseEntryDialog,
  type CourseEntryDialogState,
} from '@/components/livecourse/CourseEntryDialog';
import { createCourseStateRepository } from '@/lib/livecourse/session/course-state-repository';
import { resolveCourseEntry } from '@/lib/livecourse/session/course-state-snapshot';
import { resolveCourseIdentity } from '@/lib/livecourse/session/course-identity';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import { createGenerationIdentity } from './generation-preview/types';
import {
  SHOWCASE_CLASSROOM_ID,
  buildGenerationResumeSession,
  isFourierShowcaseSession,
  parseGenerationSession,
  shouldOpenGenerationPreview,
  type GenerationSessionState,
} from './generation-preview/resume-session';
import { readGenerationParams } from '@/lib/livecourse/session/generation-params';

const log = createLogger('Home');

interface FormState {
  requirement: string;
}

type HomeCourseEntry = {
  classroomId: string;
  name: string;
  state: CourseEntryDialogState;
};

const initialFormState: FormState = {
  requirement: '',
};

const GOAL_EXAMPLES = [
  { goal: 'home.exampleGoal1', label: 'home.exampleLabel1' },
  { goal: 'home.exampleGoal2', label: 'home.exampleLabel2' },
  { goal: 'home.exampleGoal3', label: 'home.exampleLabel3' },
] as const;

function HomePage() {
  const { t, locale, setLocale } = useI18n();
  const reduceMotion = useReducedMotion();
  // 设置经异步 KV 水合；水合完成前不渲染「未配置模型」提示，避免已配置的
  // 用户每次进首页都闪一下错误提示。测试里 mock 掉的 store 没有 persist
  // API，此时退回旧行为（视为已水合）。
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  useEffect(() => {
    const persistApi = useSettingsStore.persist;
    if (!persistApi || persistApi.hasHydrated()) {
      setSettingsHydrated(true);
      return;
    }
    return persistApi.onFinishHydration(() => setSettingsHydrated(true));
  }, []);
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initialFormState);
  const materials = useCourseMaterials({
    storeDocumentBlob,
    deleteDocumentBlob,
    onCleanupError: (cause) => log.error('Failed to clean up course material:', cause),
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // J4.4 首页同课选择态：状态与可选动作完全由 resolveCourseEntry 投影驱动。
  const [courseEntry, setCourseEntry] = useState<HomeCourseEntry | null>(null);
  const [settingsSection, setSettingsSection] = useState<
    import('@/lib/types/settings').SettingsSection | undefined
  >(undefined);

  // Draft cache for requirement text
  const { cachedValue: cachedRequirement, updateCache: updateRequirementCache } =
    useDraftCache<string>({ key: 'requirementDraft' });

  // A usable LLM provider exists ⇒ a concrete model is always selected (#580
  // invariant). Gate generation on this single condition (state A vs B)
  // instead of inspecting modelId directly.
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const hasUsableProvider = hasUsableLLMProvider(providersConfig);
  // Restore requirement draft from localStorage on mount. The previous derived-state
  // pattern initialised `prev` from the cached value itself, so on the first client
  // render the comparison was always equal and the restore never fired. Use an effect
  // so the cache is hydrated into the form once we know the live requirement is empty.
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    if (!cachedRequirement) return;
    draftRestoredRef.current = true;
    setForm((prev) => (prev.requirement ? prev : { ...prev, requirement: cachedRequirement }));
  }, [cachedRequirement]);

  const [themeOpen, setThemeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requirementTouched, setRequirementTouched] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [classroomsLoading, setClassroomsLoading] = useState(true);
  const [classroomsError, setClassroomsError] = useState(false);
  const [classrooms, setClassrooms] = useState<StageListItem[]>([]);
  const [liveGeneration, setLiveGeneration] = useState<GenerationSessionState | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, Slide>>({});
  const [covers, setCovers] = useState<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const thumbnailsRef = useRef<Record<string, Slide>>({});
  const coversRef = useRef<Record<string, string>>({});
  const mountedRef = useRef(false);
  const courseEntryRef = useRef<HomeCourseEntry | null>(null);
  const courseEntryRequestEpochRef = useRef(0);
  const courseEntryActionRef = useRef<'continue' | 'replay' | null>(null);
  const deletingIdsRef = useRef(new Set<string>());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const generationAttemptEpochRef = useRef(0);
  const generationSubmittingRef = useRef(false);
  const generationSessionIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.max(104, Math.min(textarea.scrollHeight, 240))}px`;
  }, [form.requirement]);

  // Async work on this page must not publish state after the page has left the
  // home route.  The assignment in the effect body also handles React
  // StrictMode's development-only setup/cleanup/setup cycle correctly.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      courseEntryRequestEpochRef.current += 1;
      generationAttemptEpochRef.current += 1;
      generationSubmittingRef.current = false;
    };
  }, []);

  // Keep an imperative view for event handlers.  A stale dialog event can run
  // after a newer render, so callbacks must inspect this ref rather than only
  // the value captured by their render closure.
  courseEntryRef.current = courseEntry;

  const replaceThumbnails = useCallback((slides: Record<string, Slide>) => {
    const previous = thumbnailsRef.current;
    thumbnailsRef.current = slides;
    setThumbnails(slides);
    window.setTimeout(() => revokeThumbnailSlideMediaUrls(previous), 0);
  }, []);

  const replaceCovers = useCallback((next: Record<string, string>) => {
    const previous = coversRef.current;
    coversRef.current = next;
    setCovers(next);
    window.setTimeout(() => revokeCourseCoverUrls(previous), 0);
  }, []);

  const loadClassrooms = useCallback(async () => {
    setClassroomsLoading(true);
    setClassroomsError(false);
    try {
      const list = await listStages();
      if (!mountedRef.current) return;
      setClassrooms(list);
      const [slides, coverUrls] = await Promise.all([
        list.length > 0 ? getFirstSlideByStages(list.map((c) => c.id)) : Promise.resolve({}),
        list.length > 0 ? resolveCourseCoverUrls(list) : Promise.resolve({}),
      ]);
      if (!mountedRef.current) {
        revokeThumbnailSlideMediaUrls(slides);
        revokeCourseCoverUrls(coverUrls);
        return;
      }
      replaceThumbnails(slides);
      replaceCovers(coverUrls);
    } catch (err) {
      log.error('Failed to load classrooms:', err);
      if (mountedRef.current) setClassroomsError(true);
    } finally {
      if (mountedRef.current) setClassroomsLoading(false);
    }
  }, [replaceThumbnails, replaceCovers]);

  useEffect(() => {
    // Clear stale media store to prevent cross-course thumbnail contamination.
    // The store may hold tasks from a previously visited classroom whose elementIds
    // (gen_img_1, etc.) collide with other courses' placeholders.
    useMediaGenerationStore.getState().revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    loadClassrooms();
    setLiveGeneration(parseGenerationSession(sessionStorage.getItem('generationSession')));

    return () => {
      revokeThumbnailSlideMediaUrls(thumbnailsRef.current);
      thumbnailsRef.current = {};
      revokeCourseCoverUrls(coversRef.current);
      coversRef.current = {};
    };
  }, [loadClassrooms]);

  // J4.4：点最近课堂卡片。尚未生成完成的课回到生成预览（J2.1）；生成完成
  // 后读该课程 C，有快照则进入同课选择态（继续 / 再听由 resolveCourseEntry
  // 决定）；无快照则直接进课堂（新课）。加载失败留在选择态可重试或返回首页，
  // 绝不恢复旧 W 或新建课程。
  const openCourseEntry = async (classroom: Pick<StageListItem, 'id' | 'name'>) => {
    // A successful Continue/Replay dispatch owns the route transition. Ignore
    // a card click that arrives in the same event window; otherwise it could
    // replace the action token and issue a second navigation before the page
    // unmounts.
    if (courseEntryActionRef.current) return;
    const requestEpoch = ++courseEntryRequestEpochRef.current;
    const loadingEntry: HomeCourseEntry = {
      classroomId: classroom.id,
      name: classroom.name,
      state: { status: 'loading' },
    };
    courseEntryRef.current = loadingEntry;
    setCourseEntry(loadingEntry);

    const isCurrentRequest = () =>
      mountedRef.current && courseEntryRequestEpochRef.current === requestEpoch;

    try {
      const learnerId = await getLearnerKey();
      if (!isCurrentRequest()) return;
      // A classroom card identifies a persisted stage. Resolve the durable
      // course/lesson identity from that stage's document before touching C;
      // multi-lesson plans must never be partitioned under the route id.
      const stageData = await loadStageData(classroom.id);
      if (!isCurrentRequest()) return;
      const identity = resolveCourseIdentity({
        stageId: classroom.id,
        coursePlan: stageData?.coursePlan,
      });
      const liveSession = parseGenerationSession(sessionStorage.getItem('generationSession'));
      if (
        shouldOpenGenerationPreview({
          classroomId: classroom.id,
          liveSession,
          outline: stageData?.outline,
        })
      ) {
        if (
          isFourierShowcaseSession({
            name: classroom.name,
            courseTitle: liveSession?.courseTitle,
            requirement: liveSession?.requirements.requirement,
          })
        ) {
          if (liveSession) {
            sessionStorage.setItem(
              'generationSession',
              JSON.stringify({
                ...liveSession,
                stageId: SHOWCASE_CLASSROOM_ID,
                currentStep: 'complete',
                previewPhase: 'generating-content',
              }),
            );
          }
          courseEntryActionRef.current = 'continue';
          courseEntryRequestEpochRef.current += 1;
          courseEntryRef.current = null;
          setCourseEntry(null);
          router.push(`/classroom/${SHOWCASE_CLASSROOM_ID}`);
          return;
        }
        const keepLive =
          liveSession?.stageId === classroom.id && liveSession.currentStep !== 'complete';
        if (!keepLive) {
          let languageDirective: string | undefined;
          try {
            languageDirective = readGenerationParams(
              sessionStorage,
              classroom.id,
            )?.languageDirective;
          } catch {
            languageDirective = undefined;
          }
          const resume = buildGenerationResumeSession({
            stageId: classroom.id,
            courseId: identity.courseId,
            lessonId: identity.lessonId,
            requirement: classroom.name,
            outlines: stageData?.outline?.outlines ?? [],
            lessonPlan: stageData?.outline?.lessonPlan,
            courseTitle: classroom.name,
            languageDirective,
          });
          sessionStorage.setItem('generationSession', JSON.stringify(resume));
        }
        courseEntryActionRef.current = 'continue';
        courseEntryRequestEpochRef.current += 1;
        courseEntryRef.current = null;
        setCourseEntry(null);
        router.push('/generation-preview');
        return;
      }
      const courseState = createCourseStateRepository({
        store: getRuntimeStore(),
        stageId: classroom.id,
        learnerId,
        courseId: identity.courseId,
      });
      const snapshot = await courseState.load();
      if (!isCurrentRequest()) return;
      if (!snapshot) {
        courseEntryActionRef.current = 'continue';
        courseEntryRequestEpochRef.current += 1;
        courseEntryRef.current = null;
        setCourseEntry(null);
        router.push(`/classroom/${classroom.id}`);
        return;
      }
      const readyEntry: HomeCourseEntry = {
        classroomId: classroom.id,
        name: classroom.name,
        state: { status: 'ready', entry: resolveCourseEntry(snapshot) },
      };
      if (!isCurrentRequest()) return;
      courseEntryRef.current = readyEntry;
      setCourseEntry(readyEntry);
    } catch (err) {
      if (!isCurrentRequest()) return;
      log.error('Failed to load course entry state:', err);
      const errorEntry: HomeCourseEntry = {
        classroomId: classroom.id,
        name: classroom.name,
        state: { status: 'error' },
      };
      courseEntryRef.current = errorEntry;
      setCourseEntry(errorEntry);
    }
  };

  // 「再听」结束 / 失败后按入口返回首页同课选择态（?course=<id>）。
  const courseParamHandledRef = useRef(false);

  const dropClassroomFromHomeList = (stageId: string) => {
    setClassrooms((prev) => prev.filter((item) => item.id !== stageId));
    const coverUrl = coversRef.current[stageId];
    if (coverUrl) {
      const nextCovers = { ...coversRef.current };
      delete nextCovers[stageId];
      coversRef.current = nextCovers;
      setCovers(nextCovers);
      revokeCourseCoverUrls({ [stageId]: coverUrl });
    }
    const thumb = thumbnailsRef.current[stageId];
    if (thumb) {
      const nextThumbs = { ...thumbnailsRef.current };
      delete nextThumbs[stageId];
      thumbnailsRef.current = nextThumbs;
      setThumbnails(nextThumbs);
      revokeThumbnailSlideMediaUrls({ [stageId]: thumb });
    }
  };

  const clearMatchingGenerationSession = (stageId: string) => {
    try {
      const parsed = parseGenerationSession(sessionStorage.getItem('generationSession'));
      if (parsed?.stageId === stageId) {
        sessionStorage.removeItem('generationSession');
      }
    } catch (error) {
      log.warn(`Failed to clear generation session for ${stageId}:`, error);
    }
    setLiveGeneration((live) => (live?.stageId === stageId ? null : live));
  };

  const requestDeleteClassroom = (classroom: Pick<StageListItem, 'id' | 'name'>) => {
    if (classroom.id === SHOWCASE_CLASSROOM_ID) return;
    setPendingDelete({ id: classroom.id, name: classroom.name });
    setDeleteFailed(false);
  };

  const confirmDeleteClassroom = async () => {
    if (!pendingDelete || deleteBusy) return;
    const stageId = pendingDelete.id;
    if (courseEntryRef.current?.classroomId === stageId) {
      courseEntryRef.current = null;
      setCourseEntry(null);
    }
    courseEntryRequestEpochRef.current += 1;
    courseParamHandledRef.current = true;
    if (typeof window !== 'undefined') {
      const courseId = new URLSearchParams(window.location.search).get('course');
      if (courseId === stageId) router.replace('/');
    }
    deletingIdsRef.current.add(stageId);
    setDeletingIds(new Set(deletingIdsRef.current));
    setDeleteBusy(true);
    setDeleteFailed(false);
    try {
      await deleteUserClassroom(stageId);
      dropClassroomFromHomeList(stageId);
      clearMatchingGenerationSession(stageId);
      setPendingDelete(null);
    } catch (error) {
      log.error(`Failed to delete classroom ${stageId}:`, error);
      setDeleteFailed(true);
    } finally {
      deletingIdsRef.current.delete(stageId);
      setDeletingIds(new Set(deletingIdsRef.current));
      setDeleteBusy(false);
    }
  };

  useEffect(() => {
    if (courseParamHandledRef.current || classrooms.length === 0) return;
    const courseId = new URLSearchParams(window.location.search).get('course');
    if (!courseId) return;
    const classroom = classrooms.find((item) => item.id === courseId);
    if (!classroom) return;
    courseParamHandledRef.current = true;
    void openCourseEntry(classroom);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot query-param entry
  }, [classrooms]);

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    try {
      if (field === 'requirement') updateRequirementCache(value as string);
    } catch {
      /* ignore */
    }
  };

  const buildRequirements = (): UserRequirements => {
    const userProfile = useUserProfileStore.getState();
    const settings = useSettingsStore.getState();
    return {
      requirement: form.requirement,
      userNickname: userProfile.nickname || undefined,
      userBio: userProfile.bio || undefined,
      webSearch: shouldRunGenerationWebSearch(settings),
    };
  };

  const proceedToGeneration = (requirements: UserRequirements, attemptEpoch: number): boolean => {
    let committedSessionId: string | null = null;
    const isCurrentAttempt = () =>
      mountedRef.current &&
      generationSubmittingRef.current &&
      generationAttemptEpochRef.current === attemptEpoch;
    try {
      if (!isCurrentAttempt()) return false;
      const settings = useSettingsStore.getState();
      materials.submit(settings.pdfProviderId, (sources) => {
        const documentSources = sources.length > 0 ? sources : undefined;
        const providerCfg =
          documentSources && settings.pdfProvidersConfig?.[settings.pdfProviderId];
        const sessionId = generationSessionIdRef.current ?? nanoid();
        generationSessionIdRef.current = sessionId;
        const sessionState = {
          sessionId,
          ...createGenerationIdentity(sessionId),
          requirements,
          pdfText: '',
          pdfImages: [],
          imageStorageIds: [],
          documentSources,
          // Backward-compatible single-document fields for previously saved sessions.
          pdfStorageKey: documentSources?.[0]?.storageKey,
          pdfFileName: documentSources?.[0]?.name,
          documentMimeType: documentSources?.[0]?.mimeType,
          pdfProviderId: documentSources ? settings.pdfProviderId : undefined,
          pdfProviderConfig: providerCfg
            ? {
                apiKey: providerCfg.apiKey,
                baseUrl: providerCfg.baseUrl,
                accessKeyId: providerCfg.accessKeyId,
                accessKeySecret: providerCfg.accessKeySecret,
              }
            : undefined,
          sceneOutlines: null,
          currentStep: 'generating' as const,
        };
        sessionStorage.setItem('generationSession', JSON.stringify(sessionState));
        committedSessionId = sessionId;
        router.push('/generation-preview');
      });
      return true;
    } catch (err) {
      if (committedSessionId) {
        try {
          const saved = sessionStorage.getItem('generationSession');
          if (saved && JSON.parse(saved)?.sessionId === committedSessionId) {
            sessionStorage.removeItem('generationSession');
          }
        } catch (cleanupError) {
          log.error('Failed to remove unsubmitted generation session:', cleanupError);
        }
      }
      log.error('Error preparing generation:', err);
      if (isCurrentAttempt()) {
        setError(err instanceof Error ? err.message : t('upload.generateFailed'));
      }
      return false;
    }
  };

  const handleGenerate = async () => {
    setRequirementTouched(true);
    // No model/provider guard here: generation is gated by `canGenerate`
    // (requires a usable provider), and under the #580 invariant a usable
    // provider always has a concrete model. State A (no usable provider)
    // surfaces through the toolbar's single Configure-Provider affordance.
    if (!form.requirement.trim()) {
      return;
    }

    if (!mountedRef.current || !hasUsableProvider || generationSubmittingRef.current) return;

    setError(null);
    generationSubmittingRef.current = true;
    const attemptEpoch = ++generationAttemptEpochRef.current;
    setIsSubmitting(true);

    // 课前追问与范围勾选已挪到生成预览页（docs/spec/02 生成预览节），首页
    // 提交后直接进入预览。
    const succeeded = proceedToGeneration(buildRequirements(), attemptEpoch);
    // Keep the one-shot gate closed once navigation has been dispatched.  If
    // preparation failed, clear it so the same draft can be retried in place.
    if (!succeeded && mountedRef.current && generationAttemptEpochRef.current === attemptEpoch) {
      generationSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return t('classroom.today');
    if (diffDays === 1) return t('classroom.yesterday');
    if (diffDays < 7) return `${diffDays} ${t('classroom.daysAgo')}`;
    return date.toLocaleDateString();
  };

  const preparingClassroom: StageListItem | null =
    liveGeneration &&
    liveGeneration.currentStep !== 'complete' &&
    liveGeneration.stageId &&
    !classrooms.some((item) => item.id === liveGeneration.stageId)
      ? {
          id: liveGeneration.stageId,
          name:
            liveGeneration.courseTitle?.trim() ||
            liveGeneration.requirements.requirement.trim() ||
            t('generation.preparationTitle'),
          sceneCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      : null;
  const visibleClassrooms = preparingClassroom ? [preparingClassroom, ...classrooms] : classrooms;
  const generatingStageId =
    liveGeneration && liveGeneration.currentStep !== 'complete' ? liveGeneration.stageId : null;

  const generationAvailable = !!form.requirement.trim() && hasUsableProvider;
  const canGenerate = generationAvailable && materials.ready && !isSubmitting;
  const requirementHasError = requirementTouched && !form.requirement.trim();

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleGenerate();
    }
  };

  return (
    <div className="lc-home relative flex min-h-dvh w-full flex-col bg-background text-foreground">
      <header className="lc-home-nav sticky top-0 z-30 border-b">
        <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-3 px-5 sm:h-18 sm:gap-6 sm:px-8">
          <a href="#new-lesson" className="shrink-0 rounded-lg">
            <LiveCourseMark dark className="[&>span]:text-lg sm:[&>span]:text-xl" />
          </a>
          <nav aria-label={t('home.workspace')} className="ms-auto flex items-center">
            <a
              href="#recent-classrooms"
              className="lc-home-nav-link inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg text-muted-foreground"
            >
              <Clock className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t('classroom.recentClassrooms')}</span>
              <span className="sr-only sm:hidden">{t('classroom.recentClassrooms')}</span>
            </a>
          </nav>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="lc-home-utility hidden min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm transition-colors sm:inline-flex"
              aria-label={t('settings.title')}
            >
              <Settings className="size-4" aria-hidden="true" />
              {t('settings.title')}
            </button>
            <DropdownMenu open={themeOpen} onOpenChange={setThemeOpen} modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('home.displaySettings')}
                  className="lc-home-utility inline-flex size-11 items-center justify-center rounded-lg transition-colors"
                >
                  <MoreHorizontal className="size-5" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="lc-learner-menu min-w-56 rounded-xl p-2">
                <DropdownMenuItem
                  onSelect={() => setSettingsOpen(true)}
                  className="min-h-11 sm:hidden"
                >
                  <Settings className="size-4" aria-hidden="true" />
                  {t('settings.title')}
                </DropdownMenuItem>
                <DropdownMenuSeparator className="sm:hidden" />
                <DropdownMenuLabel>{t('settings.theme')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={theme}
                  onValueChange={(value) => setTheme(value as typeof theme)}
                >
                  {(
                    [
                      ['light', Sun, t('settings.themeOptions.light')],
                      ['dark', Moon, t('settings.themeOptions.dark')],
                      ['system', Monitor, t('settings.themeOptions.system')],
                    ] as const
                  ).map(([value, Icon, label]) => (
                    <DropdownMenuRadioItem key={value} value={value} className="min-h-11">
                      <Icon className="size-4" />
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="min-h-11">
                    {t('home.language')}
                    <span className="ms-auto text-xs text-muted-foreground">
                      {supportedLocales.find((item) => item.code === locale)?.shortLabel}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="lc-learner-menu max-h-[70dvh] min-w-44 overflow-y-auto rounded-xl p-2">
                    <DropdownMenuRadioGroup
                      value={locale}
                      onValueChange={(value) => {
                        const next = supportedLocales.find((item) => item.code === value);
                        if (next) setLocale(next.code);
                      }}
                    >
                      {supportedLocales.map((item) => (
                        <DropdownMenuRadioItem
                          key={item.code}
                          value={item.code}
                          className="min-h-11"
                        >
                          {item.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsSection(undefined);
        }}
        initialSection={settingsSection}
      />

      <CourseEntryDialog
        open={courseEntry !== null}
        classroomName={courseEntry?.name ?? ''}
        state={courseEntry?.state ?? { status: 'loading' }}
        onContinue={() => {
          const current = courseEntryRef.current;
          if (
            courseEntryActionRef.current ||
            !current ||
            current.state.status !== 'ready' ||
            !current.state.entry.canContinue ||
            deletingIdsRef.current.has(current.classroomId) ||
            pendingDelete?.id === current.classroomId
          ) {
            return;
          }
          const id = current.classroomId;
          courseEntryActionRef.current = 'continue';
          courseEntryRequestEpochRef.current += 1;
          courseEntryRef.current = null;
          setCourseEntry(null);
          router.push(`/classroom/${id}`);
        }}
        onReplay={() => {
          const current = courseEntryRef.current;
          if (
            courseEntryActionRef.current ||
            !current ||
            current.state.status !== 'ready' ||
            !current.state.entry.canReplay ||
            deletingIdsRef.current.has(current.classroomId) ||
            pendingDelete?.id === current.classroomId
          ) {
            return;
          }
          const id = current.classroomId;
          courseEntryActionRef.current = 'replay';
          courseEntryRequestEpochRef.current += 1;
          courseEntryRef.current = null;
          setCourseEntry(null);
          router.push(`/classroom/${id}?replay=1&from=home`);
        }}
        onRetry={() => {
          const current = courseEntryRef.current;
          if (!current || courseEntryActionRef.current) return;
          void openCourseEntry({ id: current.classroomId, name: current.name });
        }}
        onClose={() => {
          courseEntryRequestEpochRef.current += 1;
          courseEntryActionRef.current = null;
          courseEntryRef.current = null;
          setCourseEntry(null);
          router.replace('/');
        }}
      />

      <main className="relative z-10 w-full flex-1">
        <section id="new-lesson" className="lc-home-hero scroll-mt-18" aria-labelledby="home-title">
          <div className="lc-home-hero-inner">
            <header className="lc-home-heading">
              <LiveCourseMark size="hero" dark className="lc-home-brand" />
              <h1 id="home-title" className="lc-home-title">
                {t('home.heroTitle')}
              </h1>
            </header>

            <HomeTeacherScene />

            <div className="lc-home-composer" data-submitting={isSubmitting}>
              <div className="lc-prompt flex flex-col overflow-hidden rounded-2xl border border-border">
                <label
                  id="learning-goal-label"
                  htmlFor="learning-goal"
                  className="px-5 pt-5 text-base font-semibold text-foreground sm:px-6"
                >
                  {t('home.learningPrompt')}
                </label>
                <textarea
                  id="learning-goal"
                  ref={textareaRef}
                  aria-labelledby="learning-goal-label"
                  placeholder={t('home.goalPlaceholder')}
                  className="min-h-26 w-full resize-none overflow-y-auto border-0 bg-transparent px-5 pb-3 pt-3 text-base leading-7 outline-none placeholder:text-muted-foreground sm:px-6"
                  value={form.requirement}
                  disabled={isSubmitting}
                  onChange={(event) => updateForm('requirement', event.target.value)}
                  onBlur={() => setRequirementTouched(true)}
                  onKeyDown={handleKeyDown}
                  aria-required="true"
                  aria-invalid={requirementHasError}
                  aria-describedby={requirementHasError ? 'requirement-error' : 'goal-next-step'}
                  rows={3}
                />

                {requirementHasError && (
                  <p
                    id="requirement-error"
                    role="alert"
                    className="px-5 pb-2 text-xs text-destructive"
                  >
                    {t('upload.requirementRequired')}
                  </p>
                )}

                <div className="lc-prompt-toolbar mt-auto flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <GenerationToolbar
                      courseMaterials={materials.items}
                      onCourseMaterialsAdd={materials.add}
                      onCourseMaterialRemove={materials.remove}
                      onCourseMaterialRetry={materials.retry}
                      disabled={isSubmitting}
                      onPdfError={setError}
                    />
                  </div>

                  <SpeechButton
                    size="md"
                    className="size-11"
                    disabled={isSubmitting}
                    onTranscription={(text) => {
                      setForm((previous) => {
                        const next =
                          previous.requirement + (previous.requirement ? ' ' : '') + text;
                        updateRequirementCache(next);
                        return { ...previous, requirement: next };
                      });
                    }}
                  />

                  <button
                    type="button"
                    data-testid="start-generation"
                    onClick={() => void handleGenerate()}
                    disabled={!canGenerate}
                    aria-busy={isSubmitting}
                    className={cn(
                      'lc-primary-action inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-[background-color,box-shadow,transform] disabled:cursor-not-allowed max-[359px]:w-full',
                      generationAvailable || isSubmitting
                        ? 'bg-primary text-primary-foreground disabled:opacity-60'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {isSubmitting && <GameLoader size="sm" />}
                    <span>{isSubmitting ? t('common.loading') : t('toolbar.enterClassroom')}</span>
                    {!isSubmitting && (
                      <ArrowRight
                        className="lc-start-arrow size-4 rtl:rotate-180"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </div>
              </div>

              <p id="goal-next-step" className="lc-home-hint mt-3 px-1 text-xs leading-5">
                {t('home.nextStepHint')}
              </p>

              {settingsHydrated && !hasUsableProvider && (
                <p
                  data-testid="configure-model-hint"
                  role="status"
                  className="lc-home-hint mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs"
                >
                  <span>{t('home.configureModelHint')}</span>
                  <button
                    type="button"
                    className="lc-home-settings-link inline-flex min-h-11 items-center font-medium hover:underline"
                    onClick={() => {
                      setSettingsSection('providers');
                      setSettingsOpen(true);
                    }}
                  >
                    {t('home.openModelSettings')}
                  </button>
                </p>
              )}

              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
                    role="alert"
                    className="mt-4 rounded-xl border border-destructive/20 bg-destructive/10 p-3"
                  >
                    <p className="text-sm text-destructive">{error}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="lc-home-examples">
              <p className="lc-home-hint mb-2 text-xs">{t('home.exampleGoalsLabel')}</p>
              <div className="grid grid-cols-3 gap-3 sm:gap-5">
                {GOAL_EXAMPLES.map(({ goal, label }) => (
                  <button
                    key={goal}
                    type="button"
                    data-testid="goal-example"
                    title={t(goal)}
                    disabled={isSubmitting}
                    onClick={() => {
                      updateForm('requirement', t(goal));
                      setRequirementTouched(false);
                      textareaRef.current?.focus();
                    }}
                    className="lc-goal-example group flex min-h-11 min-w-0 items-center justify-between gap-2 py-2 text-start text-xs disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm"
                  >
                    <span className="min-w-0 flex-1">{t(label)}</span>
                    <ArrowRight
                      className="lc-example-arrow size-3.5 shrink-0 rtl:rotate-180"
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section
          id="recent-classrooms"
          aria-labelledby="recent-classrooms-title"
          className="lc-recent scroll-mt-24"
        >
          <div className="lc-recent-heading">
            <div className="flex items-center gap-3">
              <h2 id="recent-classrooms-title" className="text-lg font-semibold">
                {t('classroom.recentClassrooms')}
              </h2>
              {visibleClassrooms.length > 0 && (
                <span className="text-sm tabular-nums text-muted-foreground">
                  {visibleClassrooms.length}
                </span>
              )}
            </div>
            {visibleClassrooms.length > 0 && (
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {t('home.recentShelfHint')}
              </p>
            )}
          </div>

          <div className="lc-course-list" aria-busy={classroomsLoading}>
            {classroomsError ? (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 py-5 text-sm text-destructive"
              >
                <p>{t('home.classroomsLoadFailed')}</p>
                <Button variant="outline" size="sm" onClick={() => void loadClassrooms()}>
                  {t('home.retryLoad')}
                </Button>
              </div>
            ) : classroomsLoading ? (
              <GameLoader size="md" label={t('home.loadingClassrooms')} className="py-5" />
            ) : visibleClassrooms.length === 0 ? (
              <div data-testid="recent-empty-shelf" className="lc-empty-shelf">
                <BookOpen className="size-5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                <p className="min-w-0 flex-1 text-sm leading-6 text-muted-foreground">
                  {t('home.recentEmpty')}
                </p>
                <button
                  type="button"
                  className="inline-flex min-h-11 shrink-0 items-center gap-2 text-sm font-medium text-primary hover:underline"
                  onClick={() => {
                    document.getElementById('new-lesson')?.scrollIntoView({
                      behavior: reduceMotion ? 'auto' : 'smooth',
                      block: 'start',
                    });
                    textareaRef.current?.focus({ preventScroll: true });
                  }}
                >
                  {t('home.recentEmptyAction')}
                  <ArrowRight className="size-4 rtl:rotate-180" aria-hidden="true" />
                </button>
              </div>
            ) : null}
            {visibleClassrooms.map((classroom, index) => (
              <motion.div
                key={classroom.id}
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(index, 5) * 0.04, duration: 0.25 }}
              >
                <ClassroomCard
                  classroom={classroom}
                  coverUrl={covers[classroom.id]}
                  slide={thumbnails[classroom.id]}
                  formatDate={formatDate}
                  generating={generatingStageId === classroom.id}
                  canDelete={classroom.id !== SHOWCASE_CLASSROOM_ID}
                  deleting={deletingIds.has(classroom.id)}
                  onClick={() => {
                    if (deletingIdsRef.current.has(classroom.id)) return;
                    void openCourseEntry(classroom);
                  }}
                  onDelete={() => requestDeleteClassroom(classroom)}
                />
              </motion.div>
            ))}
          </div>
        </section>
      </main>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (deleteBusy) return;
          if (!open) {
            setPendingDelete(null);
            setDeleteFailed(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('home.deleteCourseTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p>{t('home.deleteCourseDescription')}</p>
                {deleteFailed ? (
                  <p role="alert" className="mt-3 text-destructive">
                    {t('home.deleteCourseFailed')}
                  </p>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy} data-testid="delete-course-cancel">
              {t('common.cancel')}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleteBusy}
              data-testid="delete-course-confirm"
              onClick={() => void confirmDeleteClassroom()}
            >
              {deleteBusy ? t('home.deleteCourseDeleting') : t('home.deleteCourseConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <footer className="relative z-10 mx-auto flex w-full max-w-[1320px] flex-wrap items-center justify-between gap-2 px-5 pb-6 pt-8 text-xs text-muted-foreground sm:px-8">
        <span>LiveCourse</span>
        <span>{t('home.slogan')}</span>
      </footer>
    </div>
  );
}

function ClassroomCard({
  classroom,
  coverUrl,
  slide,
  formatDate,
  generating = false,
  canDelete = false,
  deleting = false,
  onClick,
  onDelete,
}: {
  classroom: StageListItem;
  coverUrl?: string;
  slide?: Slide;
  formatDate: (ts: number) => string;
  generating?: boolean;
  canDelete?: boolean;
  deleting?: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);

  useEffect(() => {
    if (coverUrl) return;
    const el = thumbRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [coverUrl]);

  return (
    <div className={cn('lc-course-row', canDelete && 'lc-course-row-with-delete')}>
      <button
        type="button"
        onClick={onClick}
        disabled={deleting}
        aria-label={generating ? `${classroom.name}. ${t('home.generatingCourse')}` : classroom.name}
        className="lc-course-row-open group w-full cursor-pointer text-start focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
      >
        <div
          ref={thumbRef}
          className="lc-course-thumb relative aspect-[16/9] w-full overflow-hidden rounded-lg bg-muted"
        >
          {coverUrl ? (
            <img
              src={coverUrl}
              alt=""
              data-testid="course-cover"
              className="absolute inset-0 size-full object-cover"
            />
          ) : slide && thumbWidth > 0 ? (
            <SlideThumbnail
              slide={slide}
              size={thumbWidth}
              viewportSize={slide.viewportSize ?? 1000}
              viewportRatio={slide.viewportRatio ?? 0.5625}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
                <BookOpen className="size-5 opacity-70" aria-hidden="true" />
              </div>
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="line-clamp-2 break-words text-[15px] font-medium text-foreground">
            {classroom.name}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {generating ? (
              <span data-testid="generating-course">{t('home.generatingCourse')}</span>
            ) : (
              `${classroom.sceneCount} ${t('classroom.slides')} · ${formatDate(classroom.updatedAt)}`
            )}
          </p>
        </div>
        <ArrowRight
          className="size-4 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-1 rtl:rotate-180"
          aria-hidden="true"
        />
      </button>
      {canDelete ? (
        <button
          type="button"
          data-testid="delete-course"
          disabled={deleting}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDelete();
          }}
          aria-label={t('home.deleteCourseAria', { name: classroom.name })}
          className="lc-course-row-delete inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Trash2 className="size-4" aria-hidden="true" />
          <span className="sr-only">{t('home.deleteCourse')}</span>
        </button>
      ) : null}
    </div>
  );
}

export default function Page() {
  return <HomePage />;
}
