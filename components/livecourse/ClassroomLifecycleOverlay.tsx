'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { TriangleAlert } from 'lucide-react';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { useLiveCourseSession } from '@/lib/livecourse/session/context';

const log = createLogger('ClassroomLifecycle');

function LifecycleDialog({
  open,
  title,
  icon,
  children,
  centered = false,
}: {
  open: boolean;
  title: string;
  icon: ReactNode;
  children: ReactNode;
  /** Hero layout for milestone moments (post-class): big centered mark. */
  centered?: boolean;
}) {
  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className="lc-learner-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl p-6 shadow-sm sm:max-w-md sm:p-8"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        {centered ? (
          <div className="flex flex-col items-center gap-4 pt-2 text-center">
            {icon}
            <DialogTitle className="text-xl font-semibold tracking-tight">{title}</DialogTitle>
          </div>
        ) : (
          <DialogTitle className="flex items-center gap-3 text-lg">
            {icon}
            {title}
          </DialogTitle>
        )}
        <DialogDescription className="sr-only">{title}</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** J3.8: the teaching provider owns finalization until archival succeeds. */
export function ClassroomLifecycleOverlay({ onFinalized }: { onFinalized: () => void }) {
  const { t } = useI18n();
  const { classroomState, finalizeSession } = useLiveCourseSession();
  const [finalizeFailed, setFinalizeFailed] = useState(false);
  const finalizeStartedRef = useRef(false);

  useEffect(() => {
    if (classroomState !== 'finalizing' || finalizeStartedRef.current) return;
    finalizeStartedRef.current = true;
    finalizeSession()
      .then(onFinalized)
      .catch((cause) => {
        log.warn('[ClassroomLifecycle] finalizeSession failed:', cause);
        setFinalizeFailed(true);
      });
  }, [classroomState, finalizeSession, onFinalized]);

  const retryFinalize = async () => {
    setFinalizeFailed(false);
    try {
      await finalizeSession();
      onFinalized();
    } catch (cause) {
      log.warn('[ClassroomLifecycle] finalizeSession retry failed:', cause);
      setFinalizeFailed(true);
    }
  };

  return (
    <LifecycleDialog
      open={classroomState === 'finalizing'}
      title={t(finalizeFailed ? 'livecourse.finalizeFailed' : 'livecourse.finalizing')}
      icon={
        finalizeFailed ? (
          <TriangleAlert className="size-5 shrink-0 text-destructive" aria-hidden="true" />
        ) : (
          <GameLoader size="sm" />
        )
      }
    >
      {finalizeFailed ? (
        <>
          <p role="alert" className="break-words text-sm text-destructive">
            {t('livecourse.finalizeFailed')}
          </p>
          <Button onClick={() => void retryFinalize()}>{t('livecourse.retryFinalize')}</Button>
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t('livecourse.finalizing')}
        </p>
      )}
    </LifecycleDialog>
  );
}

/** J4.1/J4.3: archived choices have no teaching context or memory commands. */
export function PostClassChoice({ onReplay }: { onReplay: () => void }) {
  const { t } = useI18n();
  const router = useRouter();
  const [leaving, setLeaving] = useState<'idle' | 'navigating' | 'failed'>('idle');

  const leavePostClass = async () => {
    if (leaving === 'navigating') return;
    setLeaving('navigating');
    try {
      await Promise.resolve(router.push('/'));
    } catch (cause) {
      log.warn('[ClassroomLifecycle] post-class navigation failed:', cause);
      setLeaving('failed');
    }
  };

  return (
    <LifecycleDialog
      open
      centered
      title={t('livecourse.postClassTitle')}
      icon={
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
      }
    >
      <div className="grid grid-cols-2 gap-3 pt-4">
        <Button onClick={onReplay} disabled={leaving === 'navigating'}>
          {t('livecourse.replay')}
        </Button>
        <Button
          variant="outline"
          onClick={() => void leavePostClass()}
          aria-busy={leaving === 'navigating'}
          disabled={leaving === 'navigating'}
        >
          {leaving === 'navigating' ? t('common.loading') : t('livecourse.leave')}
        </Button>
      </div>
      {leaving === 'failed' && (
        <p role="alert" className="text-sm text-destructive">
          {t('livecourse.leaveFailed')}
        </p>
      )}
    </LifecycleDialog>
  );
}
