'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from 'lucide-react';
import { useLiveCourseSessionOptional } from '@/lib/livecourse/session/context';
import { useStageStore } from '@/lib/store';
import { adjacentTeachingNode } from '@/lib/livecourse/session/teaching-flow';

import { InClassRelistenControl } from './InClassRelistenControl';

const log = createLogger('ClassroomSessionBar');

/**
 * Classroom chrome (docs/spec/02 classroom): page status plus pause / continue,
 * relisten, retry the current node, and leave. Sits in the top header slot.
 */
export function ClassroomSessionBar({
  onPlayPause,
  onRetryCurrentNode,
  playbackError,
  controlError,
  playbackIdle = false,
  starting = false,
  feedbackBusy = false,
  navigatingChapter = false,
  onChapterChange,
  onStartRelisten,
  onEndRelisten,
  onPrepareLeave,
}: {
  onPlayPause: () => void;
  onRetryCurrentNode: () => void;
  playbackError: string | null;
  controlError?: string | null;
  playbackIdle?: boolean;
  starting?: boolean;
  feedbackBusy?: boolean;
  navigatingChapter?: boolean;
  onChapterChange?: (nodeId: string) => Promise<void>;
  onStartRelisten?: (nodeId: string) => Promise<void>;
  onEndRelisten?: () => Promise<void>;
  onPrepareLeave?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const session = useLiveCourseSessionOptional();
  const scenes = useStageStore((state) => state.scenes);
  const currentSceneId = useStageStore((state) => state.currentSceneId);
  const currentScene = useStageStore((state) => state.getCurrentScene());
  const [leaving, setLeaving] = useState<'idle' | 'saving' | 'failed'>('idle');
  const [changingChapter, setChangingChapter] = useState(false);
  const [chapterError, setChapterError] = useState<string | null>(null);
  const operationRef = useRef<'chapter' | 'leave' | null>(null);

  if (!session || session.status === 'loading') return null;

  const { classroomState, lessonPlan, currentNodeId } = session;
  if (
    classroomState === 'finalizing' ||
    classroomState === 'completed' ||
    classroomState === 'loading'
  ) {
    return null;
  }

  const nodeTitle =
    lessonPlan?.nodes.find((node) => node.id === currentNodeId)?.title ??
    currentScene?.title ??
    t('livecourse.teaching');
  const nodes = [...(lessonPlan?.nodes ?? [])].sort((left, right) => left.order - right.order);
  const activeNode =
    nodes.find((node) => node.id === currentNodeId) ??
    nodes.find((node) => node.sceneId === currentSceneId);
  const previousNode =
    lessonPlan && activeNode ? adjacentTeachingNode(lessonPlan, activeNode.id, -1) : null;
  const nextNode =
    lessonPlan && activeNode ? adjacentTeachingNode(lessonPlan, activeNode.id, 1) : null;
  const completedCount = nodes.filter((node) => session.completedNodeIds.includes(node.id)).length;
  const busy = changingChapter || navigatingChapter || leaving === 'saving';
  const canNavigate =
    Boolean(onChapterChange) &&
    ['teaching', 'checking', 'paused'].includes(classroomState) &&
    !busy &&
    !starting &&
    !feedbackBusy;
  const sceneIndex = currentSceneId ? scenes.findIndex((scene) => scene.id === currentSceneId) : -1;
  const chapterIndex = activeNode
    ? nodes.findIndex((node) => node.id === activeNode.id)
    : sceneIndex;
  const chapterCount = nodes.length || scenes.length;
  const pageLabel =
    chapterIndex >= 0 && chapterCount > 0
      ? t('livecourse.classroomPage', { index: chapterIndex + 1, total: chapterCount })
      : null;
  const canPause =
    classroomState === 'teaching' || (classroomState === 'checking' && !playbackIdle);
  const canResume = classroomState === 'paused';
  const canStart = canPause && playbackIdle;
  const canLeave =
    classroomState === 'teaching' ||
    classroomState === 'checking' ||
    classroomState === 'paused' ||
    classroomState === 'interrupted' ||
    classroomState === 'replaying';

  const saveAndLeave = async () => {
    if (operationRef.current || busy) return;
    operationRef.current = 'leave';
    setLeaving('saving');
    try {
      await onPrepareLeave?.();
      await session.saveAndLeaveSession();
      router.push('/');
    } catch (cause) {
      log.warn('[ClassroomSessionBar] saveAndLeaveSession failed:', cause);
      setLeaving('failed');
      operationRef.current = null;
    }
  };

  const changeChapter = async (nodeId: string) => {
    if (!canNavigate || !onChapterChange || operationRef.current) return;
    operationRef.current = 'chapter';
    setChangingChapter(true);
    setChapterError(null);
    try {
      await onChapterChange(nodeId);
    } catch (cause) {
      log.warn('Chapter navigation failed:', cause);
      setChapterError(
        cause instanceof Error ? cause.message : t('livecourse.chapterNavigationFailed'),
      );
    } finally {
      operationRef.current = null;
      setChangingChapter(false);
    }
  };

  return (
    <div
      data-testid="classroom-session-bar"
      className="lc-classroom-session-header lc-control-strip flex shrink-0 items-center gap-3 px-4 py-2 max-md:flex-wrap"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="lc-classroom-kicker">LiveCourse</span>
          {pageLabel ? (
            <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--lc-classroom-ink-dim)]">
              {pageLabel}
            </span>
          ) : null}
          <h1 className="truncate text-sm font-medium">{nodeTitle}</h1>
          {nodes.length > 0 ? (
            <span
              role="progressbar"
              aria-label={t('livecourse.learningProgress')}
              aria-valuemin={0}
              aria-valuemax={nodes.length}
              aria-valuenow={completedCount}
              className="shrink-0 text-xs text-muted-foreground"
            >
              {t('livecourse.completedChapters', { count: completedCount, total: nodes.length })}
            </span>
          ) : null}
        </div>
        <p
          role={chapterError || controlError || playbackError ? 'alert' : 'status'}
          className={cn(
            'flex min-w-0 items-center gap-2 truncate text-xs leading-5',
            chapterError || controlError || playbackError
              ? 'text-destructive'
              : 'text-muted-foreground',
          )}
        >
          <span
            aria-hidden="true"
            data-live={
              !controlError &&
              !playbackError &&
              (classroomState === 'teaching' ||
                classroomState === 'checking' ||
                classroomState === 'interrupted')
                ? 'true'
                : 'false'
            }
            data-tone={
              controlError || playbackError
                ? 'error'
                : classroomState === 'paused'
                  ? 'muted'
                  : undefined
            }
            className="lc-live-dot"
          />
          <span className="truncate">
            {chapterError ??
              controlError ??
              playbackError ??
              (changingChapter || navigatingChapter
                ? t('livecourse.switchingChapter')
                : feedbackBusy
                  ? t('livecourse.checkpointFeedback')
                  : classroomState === 'paused'
                    ? t('livecourse.classroomPaused')
                    : classroomState === 'interrupted'
                      ? t('livecourse.teacherListening')
                      : classroomState === 'checking'
                        ? t('livecourse.checkpointAwaiting')
                        : canStart
                          ? t('livecourse.teacherReady')
                          : t('livecourse.teaching'))}
          </span>
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {onChapterChange ? (
          <div role="group" aria-label={t('livecourse.chapterNavigation')} className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              className="min-h-11"
              aria-label={t('livecourse.previousChapter')}
              title={previousNode?.title}
              disabled={!canNavigate || !previousNode}
              onClick={() => previousNode && void changeChapter(previousNode.id)}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              <span className="max-sm:sr-only">{t('livecourse.previousChapter')}</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="min-h-11"
              aria-label={t('livecourse.nextChapter')}
              title={nextNode?.title}
              disabled={!canNavigate || !nextNode}
              onClick={() => nextNode && void changeChapter(nextNode.id)}
            >
              <span className="max-sm:sr-only">{t('livecourse.nextChapter')}</span>
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ) : null}
        {playbackError ? (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10"
            onClick={onRetryCurrentNode}
            disabled={busy}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            {t('livecourse.retryCurrentNode')}
          </Button>
        ) : null}

        {(canPause || canResume) && !playbackError && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11"
            onClick={onPlayPause}
            disabled={starting || busy}
            aria-busy={starting}
          >
            {canResume || canStart ? (
              <Play className="size-4" aria-hidden="true" />
            ) : (
              <Pause className="size-4" aria-hidden="true" />
            )}
            {starting
              ? t('livecourse.connectingTeacher')
              : canResume
                ? t('livecourse.resume')
                : canStart
                  ? t('livecourse.startTeaching')
                  : t('livecourse.pause')}
          </Button>
        )}

        <InClassRelistenControl
          layout="bar"
          disabled={feedbackBusy || busy}
          onStart={onStartRelisten}
          onEnd={onEndRelisten}
        />

        {canLeave && (
          <>
            {leaving === 'failed' && (
              <span role="alert" className="text-xs text-destructive">
                {t('livecourse.leaveFailed')}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className={cn('min-h-11', leaving === 'saving' && 'opacity-70')}
              aria-busy={leaving === 'saving'}
              disabled={busy}
              onClick={() => void saveAndLeave()}
            >
              {leaving === 'saving' ? t('livecourse.leaveSaving') : t('livecourse.leaveClassroom')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
