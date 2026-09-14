'use client';

import Image from 'next/image';
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AlertCircle, BookOpenText, CheckCircle2, Minimize2, Presentation } from 'lucide-react';

import { teachingActionBus } from '@/lib/livecourse/actions/bus';
import type { GoalState } from '@/lib/livecourse/domain';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useLiveCourseSessionOptional } from '@/lib/livecourse/session/context';
import { cn } from '@/lib/utils';

import { RealtimeTeacherControls, type RealtimePlaybackHandler } from './RealtimeTeacherControls';
import {
  TeacherAvatar,
  type TeacherAvatarExpression,
  type TeacherAvatarMode,
} from './TeacherAvatar';
import { TeacherAvatarPoster } from './TeacherAvatarPoster';
import type { AiriVrmLookAt } from '@/lib/livecourse/avatar/airi-vrm-element';
import type { TeacherSpeechPort } from '@/lib/livecourse/realtime/client/teacher-speech';

const goalLabels: Record<GoalState['status'], string> = {
  not_started: '待检查',
  in_progress: '学习中',
  met: '已达成',
  needs_support: '需要支架',
};

const DESKTOP_MEDIA_QUERY = '(min-width: 1440px)';

function subscribeDesktop(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const media = window.matchMedia(DESKTOP_MEDIA_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

function getDesktopSnapshot(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
}

interface TeacherAvatarHostProps {
  readonly compact?: boolean;
  readonly docked?: boolean;
  readonly onRequestExpand?: () => void;
  /** The inherited LiveCourse notes and discussion history, hosted in this rail. */
  readonly recordContent?: ReactNode;
  readonly recordOpen?: boolean;
  readonly onRecordOpenChange?: (open: boolean) => void;
  /** Presentation keeps the Realtime controls mounted while hiding the rail body. */
  readonly isPresenting?: boolean;
  /** Stand beside the board. No records, evidence, or player chrome. */
  readonly presence?: boolean;
  /** Freeze/resume the independent lesson PlaybackEngine around a natural interruption. */
  readonly onPlaybackInterrupt?: RealtimePlaybackHandler;
  readonly onPlaybackResume?: RealtimePlaybackHandler;
  readonly onTeacherChange?: (teacher: TeacherSpeechPort | null) => void;
}

export function TeacherAvatarHost({
  compact = false,
  docked = true,
  onRequestExpand,
  recordContent,
  recordOpen,
  onRecordOpenChange,
  isPresenting = false,
  presence = false,
  onPlaybackInterrupt,
  onPlaybackResume,
  onTeacherChange,
}: TeacherAvatarHostProps) {
  const { t } = useI18n();
  const session = useLiveCourseSessionOptional();
  const isDesktop = useSyncExternalStore(subscribeDesktop, getDesktopSnapshot, () => false);
  const [mode, setMode] = useState<TeacherAvatarMode>('idle');
  const [expression, setExpression] = useState<TeacherAvatarExpression>('neutral');
  const [lookAt, setLookAt] = useState<AiriVrmLookAt>('student');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [uncontrolledActivePanel, setUncontrolledActivePanel] = useState<'teaching' | 'records'>(
    'teaching',
  );
  const activePanel =
    recordOpen === undefined ? uncontrolledActivePanel : recordOpen ? 'records' : 'teaching';

  useEffect(
    () =>
      teachingActionBus.subscribe((action) => {
        switch (action.type) {
          case 'avatar.speech_start':
            setMode('speaking');
            setExpression('happy');
            break;
          case 'avatar.speech_end':
            setMode('idle');
            setExpression('neutral');
            break;
          case 'avatar.expression':
            setExpression(action.payload.expression);
            setMode(action.payload.expression === 'think' ? 'thinking' : 'idle');
            break;
          case 'avatar.look_at':
            setLookAt(action.payload.target);
            break;
        }
      }),
    [],
  );

  const currentNode = useMemo(
    () => session?.lessonPlan?.nodes.find((item) => item.id === session.currentNodeId),
    [session],
  );
  const currentGoal = useMemo(() => {
    const goalId = currentNode?.goalIds[0];
    return goalId ? session?.goalStates.find((goal) => goal.goalId === goalId) : undefined;
  }, [currentNode, session]);
  const currentGoalTitle = session?.lessonPlan?.goals.find(
    (goal) => goal.id === currentGoal?.goalId,
  )?.title;
  const panelVisible = !compact && !collapsed && (isPresenting || isDesktop || mobileExpanded);
  const verticalPosition = currentNode?.type === 'checkpoint' ? 'top-16' : 'top-4';
  const showTeachingPanel = activePanel === 'teaching' || isPresenting;
  const useDesktopRail = docked && isDesktop && !isPresenting;

  const compactButton = (className?: string): ReactNode => (
    <button
      type="button"
      onClick={() => {
        onRequestExpand?.();
        setCollapsed(false);
        setMobileExpanded(true);
      }}
      title="展开 AI 教师"
      aria-label="展开 AI 教师"
      className={cn(
        'absolute right-3 z-30 grid size-11 place-items-center overflow-hidden rounded-full border border-black/10 bg-white shadow-lg dark:border-white/10 dark:bg-gray-900',
        !(docked && !isDesktop) && verticalPosition,
        useDesktopRail && 'relative right-auto top-auto z-20 my-2 mr-2 size-12 shrink-0 self-start',
        docked && !isDesktop && 'bottom-3 top-auto',
        className,
      )}
    >
      <Image
        src="/avatars/teacher-avatar-poster.png"
        alt=""
        width={44}
        height={44}
        className="size-full object-cover object-top"
        priority
      />
    </button>
  );

  if (!session) return null;
  const isPaused = session.classroomState === 'paused';

  if (presence && !isPresenting) {
    const lecternStatus = isPaused
      ? t('livecourse.classroomPaused')
      : mode === 'speaking'
        ? t('livecourse.teacherSpeaking')
        : mode === 'thinking'
          ? t('livecourse.teacherThinking')
          : t('livecourse.teacherReady');

    return (
      <aside data-testid="classroom-teacher" className="lc-teacher-rail relative z-20">
        <div className="lc-teacher-bay relative hidden min-h-0 flex-1 overflow-hidden md:block">
          <TeacherAvatar
            mode={isPaused ? 'idle' : mode}
            expression={isPaused ? 'neutral' : expression}
            lookAt={lookAt}
            className="absolute inset-0 size-full"
          />
        </div>
        <div className="lc-lectern-plate flex items-start gap-3 px-3 py-2.5 md:flex-col md:gap-0 md:px-4 md:py-3">
          <div className="relative h-14 w-11 shrink-0 overflow-hidden md:hidden">
            <TeacherAvatarPoster />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{lecternStatus}</p>
            <RealtimeTeacherControls
              tone="lectern"
              onPlaybackInterrupt={onPlaybackInterrupt}
              onPlaybackResume={onPlaybackResume}
              onTeacherChange={onTeacherChange}
            />
          </div>
        </div>
      </aside>
    );
  }

  return (
    <>
      {!panelVisible && compactButton()}
      <aside
        className={cn(
          'absolute right-3 z-30 w-[min(17rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-md border border-black/10 bg-white/95 shadow-xl backdrop-blur dark:border-white/10 dark:bg-gray-950/95',
          !isPresenting && !(docked && !isDesktop) && verticalPosition,
          useDesktopRail &&
            'relative right-auto top-auto z-20 my-2 mr-2 w-[clamp(18rem,22vw,22rem)] shrink-0 self-stretch shadow-sm',
          docked &&
            !isDesktop &&
            'bottom-3 top-auto max-h-[calc(100dvh-1.5rem)] w-[min(42rem,calc(100vw-1.5rem))]',
          isPresenting &&
            'bottom-3 top-auto w-auto rounded-full border-gray-200 bg-white/95 shadow-lg dark:border-gray-700 dark:bg-gray-950/95',
          panelVisible ? 'flex' : 'hidden',
        )}
      >
        <div
          className={cn(
            'flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-3 py-2.5 dark:border-gray-800',
            isPresenting && 'hidden',
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'size-2.5 shrink-0 rounded-full',
                mode === 'speaking'
                  ? 'bg-emerald-500'
                  : mode === 'thinking'
                    ? 'bg-amber-500'
                    : 'bg-gray-400',
              )}
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                AI 教师
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {mode === 'speaking' ? '讲解中' : mode === 'thinking' ? '思考中' : '待机'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {recordContent ? (
              <div className="flex items-center rounded-md bg-gray-100 p-0.5 dark:bg-gray-800">
                <button
                  type="button"
                  onClick={() => {
                    setUncontrolledActivePanel('teaching');
                    onRecordOpenChange?.(false);
                  }}
                  aria-label="教师讲台"
                  title="教师讲台"
                  className={cn(
                    'grid size-7 place-items-center rounded transition-colors',
                    activePanel === 'teaching'
                      ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                      : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-100',
                  )}
                >
                  <Presentation className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUncontrolledActivePanel('records');
                    onRecordOpenChange?.(true);
                  }}
                  aria-label="课堂记录"
                  title="课堂记录"
                  className={cn(
                    'grid size-7 place-items-center rounded transition-colors',
                    activePanel === 'records'
                      ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-gray-100'
                      : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-100',
                  )}
                >
                  <BookOpenText className="size-3.5" />
                </button>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setMobileExpanded(false);
                setCollapsed(true);
              }}
              title="收起 AI 教师"
              aria-label="收起 AI 教师"
              className="grid size-8 shrink-0 place-items-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-gray-800 dark:hover:text-gray-100"
            >
              <Minimize2 className="size-4" />
            </button>
          </div>
        </div>

        <div
          className={cn(
            'relative mx-3 my-3 min-h-[12rem] flex-1 overflow-hidden rounded-md border-2 bg-gray-100 transition-colors dark:bg-gray-800 sm:min-h-[16rem]',
            mode === 'speaking'
              ? 'border-emerald-500'
              : mode === 'thinking'
                ? 'border-amber-500'
                : 'border-gray-200 dark:border-gray-700',
            !showTeachingPanel && 'hidden',
            isPresenting && 'hidden',
          )}
        >
          {panelVisible && showTeachingPanel && !isPresenting ? (
            <TeacherAvatar
              mode={mode}
              expression={expression}
              lookAt={lookAt}
              className="size-full"
            />
          ) : null}
        </div>

        <div
          className={cn(
            'shrink-0 border-t border-gray-100 px-3 py-2.5 dark:border-gray-800',
            !showTeachingPanel && 'hidden',
            isPresenting && 'hidden',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
              当前目标
            </span>
            {currentGoal ? (
              <span
                className={cn(
                  'flex items-center gap-1 text-[11px] font-medium',
                  currentGoal.status === 'met'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : currentGoal.status === 'needs_support'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-gray-500 dark:text-gray-400',
                )}
              >
                {currentGoal.status === 'met' && <CheckCircle2 className="size-3" />}
                {goalLabels[currentGoal.status]}
              </span>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-4 text-gray-800 dark:text-gray-200">
            {currentGoalTitle || '等待检查点证据'}
          </p>
          {currentGoal ? (
            <p className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
              {currentGoal.acceptedEvidenceCount} 条有效证据
              {currentGoal.pendingReviewCount > 0
                ? ` · ${currentGoal.pendingReviewCount} 条待复核`
                : ''}
            </p>
          ) : null}
          {session.error ? (
            <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-red-600 dark:text-red-400">
              <AlertCircle className="mt-0.5 size-3 shrink-0" />
              <span className="line-clamp-2">{session.error}</span>
            </div>
          ) : null}
        </div>
        <div className={cn(!showTeachingPanel && 'hidden', isPresenting && 'block')}>
          <RealtimeTeacherControls
            onPlaybackInterrupt={onPlaybackInterrupt}
            onPlaybackResume={onPlaybackResume}
            onTeacherChange={onTeacherChange}
          />
        </div>
        {recordContent ? (
          <div
            className={cn(
              'min-h-0 flex-1 overflow-hidden',
              activePanel === 'records' && !isPresenting ? 'block' : 'hidden',
            )}
          >
            {recordContent}
          </div>
        ) : null}
      </aside>
    </>
  );
}
