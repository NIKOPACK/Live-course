'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { GameLoader } from '@/components/livecourse/GameLoader';

export function ShareCourseDialog({
  open,
  courseName,
  url,
  busy,
  error,
  onCopy,
  onRetry,
  onClose,
}: {
  open: boolean;
  courseName: string;
  url?: string;
  busy: boolean;
  error: boolean;
  onCopy: () => Promise<void> | void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent className="lc-learner-dialog w-[calc(100%-2rem)] max-w-lg rounded-xl bg-card shadow-sm">
        <DialogHeader>
          <DialogTitle className="pr-10 [overflow-wrap:anywhere]">
            {t('home.shareCourseTitle', { name: courseName })}
          </DialogTitle>
          <DialogDescription>{t('home.shareCourseDescription')}</DialogDescription>
        </DialogHeader>

        {busy ? <GameLoader size="md" label={t('home.shareCourseSharing')} className="py-4" /> : null}

        {error && !busy ? (
          <p role="alert" className="py-2 text-sm text-destructive">
            {t('home.shareCourseFailed')}
          </p>
        ) : null}

        {url && !busy ? (
          <p className="break-all rounded-md bg-muted px-3 py-2 text-sm" data-testid="share-course-url">
            {url}
          </p>
        ) : null}

        <DialogFooter>
          {error && !busy ? (
            <Button type="button" onClick={onRetry}>
              {t('home.shareCourseRetry')}
            </Button>
          ) : null}
          {url && !busy ? (
            <Button
              type="button"
              onClick={async () => {
                await onCopy();
                setCopied(true);
              }}
            >
              {copied ? t('home.shareCourseCopied') : t('home.shareCourseCopy')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('home.shareCourseClose')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
