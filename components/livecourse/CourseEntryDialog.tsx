'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GameLoader } from '@/components/livecourse/GameLoader';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { CourseEntryProjection } from '@/lib/livecourse/session/course-state-snapshot';

export type CourseEntryDialogState =
  | { status: 'loading' }
  | { status: 'ready'; entry: CourseEntryProjection }
  | { status: 'error' };

/**
 * J4.4 首页同课选择态（docs/spec/02-product-manual.md「重开同一课程」）：
 * 状态与可选动作完全由 `resolveCourseEntry` 投影驱动——仅未完成课程可
 * 「继续」，有持久化已讲范围即可「再听」；UI 不重新解释 progress /
 * lifecycle 字段。加载失败留在选择态，可重试或返回首页；不得新建课程。
 */
export function CourseEntryDialog({
  open,
  classroomName,
  state,
  onContinue,
  onReplay,
  onRetry,
  onClose,
}: {
  open: boolean;
  classroomName: string;
  state: CourseEntryDialogState;
  onContinue: () => void;
  onReplay: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="lc-learner-dialog w-[calc(100%-2rem)] max-w-lg rounded-xl bg-card shadow-sm">
        <DialogHeader>
          <DialogTitle className="pr-10 [overflow-wrap:anywhere]">{classroomName}</DialogTitle>
          <DialogDescription>
            {state.status === 'ready' && (
              <Badge variant={state.entry.status === 'archived' ? 'secondary' : 'default'}>
                {state.entry.status === 'archived'
                  ? t('livecourse.entryStatusCompleted')
                  : t('livecourse.entryStatusInProgress')}
              </Badge>
            )}
          </DialogDescription>
        </DialogHeader>

        {state.status === 'loading' && (
          <GameLoader size="md" label={t('livecourse.entryLoading')} className="py-4" />
        )}

        {state.status === 'error' && (
          <>
            <p role="alert" className="py-4 text-sm text-destructive">
              {t('livecourse.entryLoadFailed')}
            </p>
            <DialogFooter>
              <Button onClick={onRetry}>{t('livecourse.retry')}</Button>
              <Button variant="ghost" onClick={onClose}>
                {t('livecourse.backHome')}
              </Button>
            </DialogFooter>
          </>
        )}

        {state.status === 'ready' && (
          <DialogFooter>
            {state.entry.canReplay && (
              <Button variant="outline" onClick={onReplay}>
                {t('livecourse.replay')}
              </Button>
            )}
            {state.entry.canContinue && (
              <Button onClick={onContinue}>{t('livecourse.continueLesson')}</Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
