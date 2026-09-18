'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';

export function LessonPlanPanel({
  plan,
  compact = false,
}: {
  plan: LessonPlan;
  /** When the working segment list is on screen, start collapsed so the TOC is not a second copy. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(!compact);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
      <CollapsibleTrigger
        data-testid="lesson-plan-toggle"
        aria-expanded={open}
        className={cn(
          'flex min-h-11 w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-xl px-1 py-2 text-start',
          'hover:bg-muted/60',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          'active:translate-y-px',
          'motion-reduce:transition-none motion-reduce:active:translate-y-0',
        )}
      >
        <span className="min-w-0 text-sm font-medium leading-relaxed text-foreground">
          {open ? t('lessonPlan.hide') : t('lessonPlan.toggle')}
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="lc-preview-collapse">
        <div
          className="min-w-0 space-y-3 pb-2 ps-1"
          data-testid="lesson-plan-readonly"
          data-readonly="true"
        >
          <p className="text-base font-medium leading-snug text-foreground">{plan.title}</p>
          <ol className="grid min-w-0 gap-2">
            {plan.nodes.map((node, index) => (
              <li
                key={node.id}
                className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-2 text-sm leading-relaxed text-muted-foreground"
              >
                <span className="tabular-nums text-end text-muted-foreground/80">{index + 1}</span>
                <span className="min-w-0 text-foreground">{node.title}</span>
              </li>
            ))}
          </ol>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
