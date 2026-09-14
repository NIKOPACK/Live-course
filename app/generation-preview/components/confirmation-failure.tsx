'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';

/**
 * J2.0 / J2.0b first-load failures: no recommended tree exists yet, so this
 * panel must not invent checkboxes. Retry or skip with demand + defaults.
 */
export function ConfirmationFailurePanel({
  kind,
  onRetry,
  onSkip,
}: {
  kind: 'clarify-error' | 'scope-error';
  onRetry: () => void;
  onSkip: () => void;
}) {
  const { t } = useI18n();
  const isScope = kind === 'scope-error';

  return (
    <div
      className="min-w-0 space-y-6"
      data-testid={isScope ? 'scope-first-load-error' : 'clarify-request-error'}
    >
      <div role="alert" className="min-w-0 space-y-3">
        <AlertCircle aria-hidden className="size-6 text-destructive" />
        <h2 className="text-xl font-semibold leading-snug tracking-tight">
          {t(isScope ? 'clarify.scopeFailed' : 'clarify.requestFailed')}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t(
            isScope ? 'preparationVisual.scopeSkipHelp' : 'preparationVisual.clarificationSkipHelp',
          )}
        </p>
      </div>
      <div className="grid min-w-0 gap-2 sm:flex sm:flex-wrap">
        <Button
          className="h-auto min-h-11 min-w-0 max-w-full rounded-xl px-4 py-3 whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none"
          size="sm"
          onClick={onRetry}
        >
          {t('clarify.retry')}
        </Button>
        <Button
          className="h-auto min-h-11 min-w-0 max-w-full rounded-xl px-4 py-3 whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none"
          size="sm"
          variant="ghost"
          onClick={onSkip}
        >
          {t(isScope ? 'clarify.skipScopeDefaults' : 'clarify.skip')}
        </Button>
      </div>
    </div>
  );
}
