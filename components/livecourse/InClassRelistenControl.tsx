'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useLiveCourseSessionOptional } from '@/lib/livecourse/session/context';
import { cn } from '@/lib/utils';

/**
 * J3.6 课中重听（docs/spec/01）：只在 teaching / checking 中可从已讲范围
 * 选择重听；进入 replaying 后显示回放位置与「返回原位置」。重听不产生
 * EvidenceRecord、不重判 GoalState，返回命令只能回到进入重听前的位置
 * （控制器校验 origin）。
 */
export function InClassRelistenControl({
  layout = 'floating',
  disabled = false,
  onStart,
  onEnd,
}: {
  layout?: 'floating' | 'bar';
  disabled?: boolean;
  onStart?: (nodeId: string) => Promise<void>;
  onEnd?: () => Promise<void>;
}) {
  const { t } = useI18n();
  const session = useLiveCourseSessionOptional();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 进入重听前的原位置（发起方记录的 origin，控制器二次校验）。 */
  const [originNodeId, setOriginNodeId] = useState<string | null>(null);

  if (!session || session.status !== 'ready') return null;
  const { classroomState, completedNodeIds, currentNodeId, lessonPlan } = session;
  const replaying = classroomState === 'replaying';
  const canStart =
    (classroomState === 'teaching' || classroomState === 'checking') && completedNodeIds.length > 0;
  if (!replaying && !canStart) return null;

  const nodeTitle = (nodeId: string | null) =>
    lessonPlan?.nodes.find((node) => node.id === nodeId)?.title ?? nodeId ?? '';

  const startRelisten = async (targetNodeId: string) => {
    if (busy || disabled || !currentNodeId) return;
    setBusy(true);
    setError(null);
    try {
      if (onStart) await onStart(targetNodeId);
      else
        await session.emitAction({
          type: 'lesson.relisten_start',
          nodeId: targetNodeId,
          payload: { targetNodeId },
        });
      setOriginNodeId(currentNodeId);
      setOpen(false);
    } catch (cause) {
      // 回放失败留在原位置（控制器拒绝时不迁移状态），可重试。
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const endRelisten = async () => {
    const origin = originNodeId;
    if (busy || (!origin && !onEnd)) return;
    setBusy(true);
    setError(null);
    try {
      if (onEnd) await onEnd();
      else if (origin)
        await session.emitAction({
          type: 'lesson.relisten_end',
          nodeId: origin,
          payload: { targetNodeId: origin },
        });
      setOriginNodeId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const bar = layout === 'bar';

  return (
    <div
      className={
        bar
          ? 'relative text-xs'
          : 'pointer-events-auto fixed bottom-4 left-4 z-40 max-w-xs rounded-xl border border-gray-200 bg-white/95 p-3 text-xs shadow-lg backdrop-blur dark:border-gray-700 dark:bg-gray-900/95'
      }
    >
      {replaying ? (
        <div className={cn('flex items-center gap-2', !bar && 'flex-col items-stretch space-y-2')}>
          {!bar && (
            <p className="text-gray-700 dark:text-gray-200">
              {t('livecourse.relistenPosition', { title: nodeTitle(currentNodeId) })}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            disabled={busy || (!originNodeId && !onEnd)}
            onClick={() => void endRelisten()}
            variant={bar ? 'outline' : 'default'}
          >
            {t('livecourse.relistenBack')}
          </Button>
        </div>
      ) : (
        <div className={bar ? 'relative' : 'space-y-2'}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || disabled}
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {t('livecourse.relistenOpen')}
          </Button>
          {open && (
            <ul
              className={cn(
                'max-h-48 space-y-1 overflow-y-auto',
                bar
                  ? 'lc-classroom-popover absolute bottom-full start-0 z-50 mb-2 w-56 max-w-[calc(100vw-2rem)] rounded-xl border p-2 shadow-sm'
                  : '',
              )}
            >
              {completedNodeIds.map((nodeId) => (
                <li key={nodeId}>
                  <button
                    type="button"
                    disabled={busy || disabled}
                    onClick={() => void startRelisten(nodeId)}
                    className={cn(
                      'min-h-11 w-full break-words rounded-lg px-3 py-2 text-start text-sm transition disabled:opacity-50',
                      !bar &&
                        'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800',
                    )}
                  >
                    {nodeTitle(nodeId)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p
          role="alert"
          className={cn(
            'mt-2',
            bar ? 'absolute bottom-full mb-2 text-destructive' : 'text-red-600 dark:text-red-400',
          )}
        >
          {error}
        </p>
      )}
    </div>
  );
}
