/* Hallmark · component: segment-list · genre: editorial · theme: paper-studio
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (46–50)
 */
'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, RotateCw } from 'lucide-react';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { canRetrySegment, type SegmentProgress, type SegmentStatus } from '../segment-status';
import { SegmentClassroomPreview } from './segment-classroom-preview';

function statusLabel(status: SegmentStatus, t: (key: string) => string): string {
  switch (status) {
    case 'waiting':
      return t('generation.segmentWaiting');
    case 'generating':
      return t('generation.segmentGenerating');
    case 'completed':
      return t('generation.segmentCompleted');
    case 'failed':
      return t('generation.segmentFailed');
  }
}

export function SegmentList({
  segments,
  onRetry,
  retryingId,
}: {
  segments: readonly SegmentProgress[];
  onRetry: (outlineId: string) => void;
  retryingId: string | null;
}) {
  const { t } = useI18n();
  const done = segments.filter((segment) => segment.status === 'completed').length;
  const generatingId =
    segments.find((segment) => segment.status === 'generating')?.outlineId ?? null;
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!generatingId) return;
    setOpened((current) => {
      if (current[generatingId] === false || current[generatingId] === true) return current;
      return { ...current, [generatingId]: true };
    });
  }, [generatingId]);

  if (segments.length === 0) return null;

  return (
    <div className="w-full min-w-0 text-left [overflow-wrap:anywhere]">
      <p className="mb-3 text-sm font-medium text-foreground" role="status">
        {t('generation.segmentsProgress', { done, total: segments.length })}
      </p>
      <progress
        value={done}
        max={segments.length}
        aria-label={t('generation.segmentsProgress', { done, total: segments.length })}
        className="mb-4 h-2 w-full overflow-hidden rounded-full accent-primary"
      />
      <ol className="divide-y divide-border/60">
        {segments.map((segment, index) => {
          const retrying = retryingId === segment.outlineId;
          const open = opened[segment.outlineId] === true;
          return (
            <li
              key={segment.outlineId}
              data-testid="preview-segment"
              data-status={segment.status}
              className={cn(
                'lc-rise min-w-0 py-2',
                segment.status === 'generating' && 'lc-active-sheen rounded-xl',
              )}
              style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
            >
              <Collapsible
                open={open}
                onOpenChange={(next) =>
                  setOpened((current) => ({ ...current, [segment.outlineId]: next }))
                }
              >
                <div className="flex min-w-0 items-start gap-3">
                  <StatusMark status={segment.status} />
                  <div className="min-w-0 flex-1">
                    <CollapsibleTrigger
                      data-testid="preview-segment-toggle"
                      aria-expanded={open}
                      aria-label={t(open ? 'generation.hideSegment' : 'generation.viewSegment', {
                        title: segment.title,
                      })}
                      className={cn(
                        'flex min-h-11 w-full min-w-0 cursor-pointer items-start justify-between gap-3 rounded-xl px-1 py-2 text-start',
                        'hover:bg-muted/60',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        'active:translate-y-px',
                        'motion-reduce:transition-none motion-reduce:active:translate-y-0',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                          <h3 className="min-w-0 text-base font-medium leading-relaxed text-foreground">
                            {index + 1}. {segment.title}
                          </h3>
                          <span
                            role="status"
                            data-tone={
                              segment.status === 'failed'
                                ? 'error'
                                : segment.status === 'completed'
                                  ? 'done'
                                  : segment.status === 'generating'
                                    ? 'active'
                                    : 'idle'
                            }
                            className="lc-status-pill min-w-0 sm:max-w-40 sm:shrink-0"
                          >
                            <span className="sr-only">{segment.title}: </span>
                            {statusLabel(segment.status, t)}
                          </span>
                        </div>
                        {segment.design?.teachingPoints?.length ? (
                          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                            {segment.design.teachingPoints[0]}
                          </p>
                        ) : null}
                      </div>
                      <ChevronDown
                        aria-hidden
                        className={cn(
                          'mt-3 size-4 shrink-0 text-muted-foreground transition-transform',
                          open && 'rotate-180',
                        )}
                      />
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SegmentDetail segment={segment} />
                    </CollapsibleContent>
                    {canRetrySegment(segment.status) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3 h-auto min-h-11 min-w-0 max-w-full gap-2 rounded-xl whitespace-normal px-4 py-3 shadow-none [overflow-wrap:anywhere] motion-reduce:transition-none"
                        data-testid="retry-segment"
                        aria-label={t('generation.retrySegmentLabel', { title: segment.title })}
                        aria-busy={retrying}
                        disabled={retryingId !== null}
                        onClick={() => onRetry(segment.outlineId)}
                      >
                        {retrying ? (
                          <GameLoader size="sm" />
                        ) : (
                          <RotateCw aria-hidden className="size-4" />
                        )}
                        {t('generation.retrySegment')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Collapsible>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SegmentDetail({ segment }: { segment: SegmentProgress }) {
  const { t } = useI18n();
  const phaseCopy =
    segment.status === 'generating'
      ? segment.generatingPhase === 'actions'
        ? t('generation.segmentActionsGenerating')
        : t('generation.segmentContentGenerating')
      : segment.status === 'waiting'
        ? t('generation.segmentWaitingDetail')
        : null;

  return (
    <div
      className="min-w-0 space-y-4 px-1 pb-3 pt-1"
      data-testid="segment-detail"
      data-readonly="true"
    >
      {phaseCopy ? (
        <p className="text-sm leading-relaxed text-muted-foreground" role="status">
          {phaseCopy}
        </p>
      ) : null}
      {segment.design?.teachingPoints && segment.design.teachingPoints.length > 1 ? (
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">{t('lessonPlan.teachingPoints')}</p>
          <ul className="space-y-1 text-sm leading-relaxed text-muted-foreground">
            {segment.design.teachingPoints.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {segment.design?.explanationPlan ? (
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">{t('lessonPlan.explanationPlan')}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {segment.design.explanationPlan}
          </p>
        </div>
      ) : null}
      {segment.design?.examples?.length ? (
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">{t('lessonPlan.examples')}</p>
          <ul className="space-y-1 text-sm leading-relaxed text-muted-foreground">
            {segment.design.examples.map((example) => (
              <li key={example}>{example}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {segment.design?.anticipatedQuestions?.length ? (
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-foreground">
            {t('lessonPlan.anticipatedQuestions')}
          </p>
          <ul className="space-y-2 text-sm leading-relaxed text-muted-foreground">
            {segment.design.anticipatedQuestions.map((item) => (
              <li key={item.question}>
                <span className="block text-foreground">{item.question}</span>
                <span className="mt-1 block">{item.response}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {segment.scene ? (
        <SegmentClassroomPreview scene={segment.scene} />
      ) : segment.status === 'generating' || segment.status === 'waiting' ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t('generation.noClassroomYet')}
        </p>
      ) : null}
    </div>
  );
}

function StatusMark({ status }: { status: SegmentStatus }) {
  return (
    <span
      className={cn(
        'mt-3 flex size-5 shrink-0 items-center justify-center rounded-full border',
        status === 'completed' && 'border-primary/40 bg-primary/10 text-primary',
        status === 'failed' && 'border-destructive/40 bg-destructive/10 text-destructive',
        status === 'generating' && 'border-primary/50',
        status === 'waiting' && 'border-border/60',
      )}
      aria-hidden
    >
      {status === 'completed' ? (
        <svg viewBox="0 0 24 24" fill="none" className="size-3">
          <path
            className="lc-check-path"
            d="M5 12.5l4.5 4.5L19 7.5"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
          />
        </svg>
      ) : status === 'generating' ? (
        <GameLoader size="sm" />
      ) : status === 'failed' ? (
        <span className="text-[11px] font-bold leading-none">!</span>
      ) : null}
    </span>
  );
}
