'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';

export function LessonPlanPanel({ plan }: { plan: LessonPlan }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);

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
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className="min-w-0 space-y-3 pb-2 ps-1"
          data-testid="lesson-plan-readonly"
          data-readonly="true"
        >
          <p className="text-sm leading-relaxed text-muted-foreground">{plan.title}</p>
          <ol className="space-y-2">
            {plan.nodes.map((node, index) => (
              <li key={node.id} className="min-w-0 text-sm leading-relaxed text-foreground">
                {index + 1}. {node.title}
              </li>
            ))}
          </ol>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
