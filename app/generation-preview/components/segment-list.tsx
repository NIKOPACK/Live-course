/* Hallmark · component: segment-list · genre: editorial · theme: paper-studio
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: pass (46–50)
 */
'use client';

import { useState } from 'react';
import { ChevronDown, RotateCw } from 'lucide-react';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { canRetrySegment, type SegmentProgress, type SegmentStatus } from '../segment-status';
import { SegmentClassroomPending, SegmentClassroomPreview } from './segment-classroom-preview';

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
  generationBusy = false,
}: {
  segments: readonly SegmentProgress[];
  onRetry: (outlineId: string) => void;
  retryingId: string | null;
  generationBusy?: boolean;
}) {
  const { t } = useI18n();
  const done = segments.filter((segment) => segment.status === 'completed').length;
  const generatingId =
    segments.find((segment) => segment.status === 'generating')?.outlineId ?? null;
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  if (generatingId && opened[generatingId] !== true && opened[generatingId] !== false) {
    setOpened({ ...opened, [generatingId]: true });
  }

  if (segments.length === 0) return null;

  return (
    <div className="w-full min-w-0 text-left [overflow-wrap:anywhere]">
      <div className="mb-4 min-w-0 space-y-2">
        <p className="text-sm font-medium text-foreground" role="status">
          {t('generation.segmentsProgress', { done, total: segments.length })}
        </p>
        <progress
          value={done}
          max={segments.length}
          aria-label={t('generation.segmentsProgress', { done, total: segments.length })}
          className="h-1.5 w-full overflow-hidden rounded-full accent-primary"
        />
      </div>
      <ol className="min-w-0">
        {segments.map((segment, index) => {
          const retrying = retryingId === segment.outlineId;
          const open = opened[segment.outlineId] === true;
          return (
            <li
              key={segment.outlineId}
              data-testid="preview-segment"
              data-status={segment.status}
              className={cn(
                'lc-rise min-w-0 border-b border-border/50 last:border-b-0',
                segment.status === 'generating' && 'rounded-xl border-b-0 bg-accent/20',
              )}
              style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
            >
              <Collapsible
                open={open}
                onOpenChange={(next) =>
                  setOpened((current) => ({ ...current, [segment.outlineId]: next }))
                }
              >
                <div className="flex min-w-0 items-start gap-3 px-1">
                  <StatusMark status={segment.status} />
                  <div className="min-w-0 flex-1">
                    <CollapsibleTrigger
                      data-testid="preview-segment-toggle"
                      aria-expanded={open}
                      aria-label={t(open ? 'generation.hideSegment' : 'generation.viewSegment', {
                        title: segment.title,
                      })}
                      className={cn(
                        'grid min-h-11 w-full min-w-0 cursor-pointer grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-xl py-3 text-start',
                        'hover:bg-muted/60',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        'active:translate-y-px',
                        'motion-reduce:transition-none motion-reduce:active:translate-y-0',
                      )}
                    >
                      <span className="pt-0.5 text-end text-sm tabular-nums text-muted-foreground">
                        {index + 1}
                      </span>
                      <h3 className="min-w-0 text-base font-medium leading-snug text-foreground">
                        {segment.title}
                      </h3>
                      <span className="flex shrink-0 items-center gap-2 pt-0.5">
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
                          className="lc-status-pill"
                        >
                          <span className="sr-only">{segment.title}: </span>
                          {statusLabel(segment.status, t)}
                        </span>
                        <ChevronDown
                          aria-hidden
                          className={cn(
                            'size-4 shrink-0 text-muted-foreground transition-transform',
                            open && 'rotate-180',
                          )}
                        />
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="min-w-0 ps-[2.75rem]">
                        <SegmentDetail segment={segment} />
                      </div>
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
                        disabled={generationBusy || retryingId !== null}
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
  const teachingPoints = segment.design?.teachingPoints ?? [];
  const waitingForClassroom =
    !segment.scene && (segment.status === 'generating' || segment.status === 'waiting');
  const classroom = segment.scene ? (
    <div className="min-w-0 space-y-2">
      {phaseCopy ? (
        <p className="text-sm leading-relaxed text-muted-foreground" role="status">
          {phaseCopy}
        </p>
      ) : null}
      <SegmentClassroomPreview scene={segment.scene} />
    </div>
  ) : waitingForClassroom ? (
    <SegmentClassroomPending message={phaseCopy ?? t('generation.noClassroomYet')} />
  ) : null;

  return (
    <div
      className="min-w-0 space-y-5 px-1 pb-3 pt-1"
      data-testid="segment-detail"
      data-readonly="true"
    >
      <div
        className={cn(
          'grid min-w-0 gap-5',
          classroom &&
            teachingPoints.length > 0 &&
            'md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:items-start',
        )}
      >
        {classroom}
        {teachingPoints.length > 0 ? (
          <section data-testid="segment-teaching-points" className="min-w-0 space-y-2">
            <h4 className="text-sm font-medium text-foreground">
              {t('lessonPlan.teachingPoints')}
            </h4>
            <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-muted-foreground marker:text-muted-foreground/80">
              {teachingPoints.map((point) => (
                <li key={point} className="min-w-0 ps-0.5">
                  {point}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      {segment.design?.explanationPlan ||
      segment.design?.examples?.length ||
      segment.design?.anticipatedQuestions?.length ||
      segment.design?.misconceptions?.length ? (
        <div className="min-w-0 divide-y divide-border/60">
          {segment.design?.explanationPlan ? (
            <section className="min-w-0 space-y-2 py-4 first:pt-0">
              <h4 className="text-sm font-medium text-foreground">
                {t('lessonPlan.explanationPlan')}
              </h4>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {segment.design.explanationPlan}
              </p>
            </section>
          ) : null}
          {segment.design?.examples?.length ? (
            <section className="min-w-0 space-y-2 py-4 first:pt-0">
              <h4 className="text-sm font-medium text-foreground">{t('lessonPlan.examples')}</h4>
              <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-muted-foreground marker:text-muted-foreground/80">
                {segment.design.examples.map((example) => (
                  <li key={example} className="min-w-0 ps-0.5">
                    {example}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {segment.design?.anticipatedQuestions?.length ? (
            <section className="min-w-0 space-y-2 py-4 first:pt-0">
              <h4 className="text-sm font-medium text-foreground">
                {t('lessonPlan.anticipatedQuestions')}
              </h4>
              <dl className="space-y-3">
                {segment.design.anticipatedQuestions.map((item) => (
                  <div key={item.question} className="min-w-0 space-y-1">
                    <dt className="text-sm font-medium leading-relaxed text-foreground">
                      {item.question}
                    </dt>
                    <dd className="border-s-2 border-border ps-3 text-sm leading-relaxed text-muted-foreground">
                      {item.response}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {segment.design?.misconceptions?.length ? (
            <section className="min-w-0 space-y-2 py-4 first:pt-0">
              <h4 className="text-sm font-medium text-foreground">
                {t('lessonPlan.misconceptions')}
              </h4>
              <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-muted-foreground marker:text-muted-foreground/80">
                {segment.design.misconceptions.map((item) => (
                  <li key={item} className="min-w-0 ps-0.5">
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
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
