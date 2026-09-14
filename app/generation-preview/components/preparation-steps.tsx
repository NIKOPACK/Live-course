'use client';

import { Check } from 'lucide-react';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { getGenerationStepText, type GenerationSessionState, type GenerationStep } from '../types';

export function PreparationSteps({
  steps,
  currentIndex,
  session,
}: {
  steps: readonly GenerationStep[];
  currentIndex: number;
  session: GenerationSessionState | null;
}) {
  const { t } = useI18n();
  if (steps.length === 0) return null;

  return (
    <ol className="min-w-0" data-testid="preparation-steps">
      {steps.map((step, index) => {
        const done = index < currentIndex;
        const current = index === currentIndex;
        const last = index === steps.length - 1;
        const copy = getGenerationStepText(step, session);
        return (
          <li
            key={step.id}
            data-step={step.id}
            data-current={current ? 'true' : undefined}
            className={cn(
              'relative flex min-w-0 items-start gap-3 pb-4 text-sm leading-relaxed last:pb-0',
              current ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {!last && (
              <span
                aria-hidden
                className={cn(
                  'absolute start-[9.5px] top-6 h-[calc(100%-1.5rem)] w-px',
                  done ? 'bg-primary/40' : 'bg-border/70',
                )}
              />
            )}
            <span
              className={cn(
                'relative mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border bg-card',
                done && 'border-primary/40 bg-primary/10 text-primary',
                current && 'border-primary/60',
                !done && !current && 'border-border/60',
              )}
              aria-hidden
            >
              {done ? (
                <Check className="size-3" strokeWidth={2.5} />
              ) : current ? (
                <GameLoader size="sm" />
              ) : null}
            </span>
            <span className={cn('min-w-0 pt-px', current && 'font-medium')}>
              {t(copy.title, copy.titleValues)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
