'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useLiveCourseSession } from '@/lib/livecourse/session/context';

/** Keep teaching effects unmounted until the session has actually hydrated. */
export function ClassroomSessionBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { status, error, retryHydration } = useLiveCourseSession();
  const retryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (status === 'error') retryRef.current?.focus();
  }, [status]);

  if (status === 'ready') return children;

  return (
    <div className="lc-classroom-fill flex flex-1 items-center justify-center p-6">
      <div className="max-w-md space-y-4 text-center" aria-busy={status === 'loading'}>
        {status === 'error' ? (
          <>
            <div role="alert" className="space-y-2 break-words text-sm text-destructive">
              <p>{t('livecourse.entryLoadFailed')}</p>
              <p>{error}</p>
            </div>
            <Button ref={retryRef} onClick={retryHydration}>
              {t('livecourse.retry')}
            </Button>
          </>
        ) : (
          <GameLoader size="lg" label={t('livecourse.entryLoading')} />
        )}
      </div>
    </div>
  );
}
