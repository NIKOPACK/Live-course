'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { useLiveCourseSessionOptional } from '@/lib/livecourse/session/context';
import { useStageStore } from '@/lib/store';

import { InClassRelistenControl } from './InClassRelistenControl';

const log = createLogger('ClassroomSessionBar');

/**
 * Classroom action bar (docs/spec/02 classroom): pause / continue, relisten
 * taught parts, retry the current node, and leave. Not a playback transport.
 */
export function ClassroomSessionBar({
  onPlayPause,
  onRetryCurrentNode,
  playbackError,
  controlError,
  playbackIdle = false,
  starting = false,
  feedbackBusy = false,
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
  const sceneIndex = currentSceneId ? scenes.findIndex((scene) => scene.id === currentSceneId) : -1;
  const pageLabel =
    sceneIndex >= 0 && scenes.length > 0
      ? t('livecourse.classroomPage', { index: sceneIndex + 1, total: scenes.length })
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
    setLeaving('saving');
    try {
      await onPrepareLeave?.();
      await session.saveAndLeaveSession();
      router.push('/');
    } catch (cause) {
      log.warn('[ClassroomSessionBar] saveAndLeaveSession failed:', cause);
      setLeaving('failed');
    }
  };

  return (
    <div
      data-testid="classroom-session-bar"
      className="lc-control-strip flex shrink-0 items-center gap-3 px-4 py-2 max-md:flex-wrap"
    >
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2">
          {pageLabel ? (
            <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--lc-classroom-ink-dim)]">
              {pageLabel}
            </span>
          ) : null}
          <span className="truncate text-sm font-medium">{nodeTitle}</span>
        </p>
        <p
          role={controlError || playbackError ? 'alert' : 'status'}
          className={cn(
            'flex min-w-0 items-center gap-2 truncate text-xs leading-5',
            controlError || playbackError ? 'text-destructive' : 'text-muted-foreground',
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
            {controlError ??
              playbackError ??
              (feedbackBusy
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
        {playbackError ? (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10"
            onClick={onRetryCurrentNode}
            disabled={leaving === 'saving'}
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
            disabled={starting || leaving === 'saving'}
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
          disabled={feedbackBusy || leaving === 'saving'}
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
              disabled={leaving === 'saving'}
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
