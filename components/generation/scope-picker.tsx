'use client';

import { useId, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { KnowledgeMap, KnowledgeTopic } from '@/lib/livecourse/outline/types';

interface ScopePickerProps {
  knowledgeMap: KnowledgeMap;
  /** true while the generation session is being prepared after starting */
  submitting?: boolean;
  error?: string;
  /** Explicit defaults when the loaded map has no recommendation. */
  onSkip: () => void;
  onStart: (selectedTitles: string[]) => void;
}

function recommendedIds(topics: KnowledgeTopic[]): string[] {
  return topics.flatMap((topic) => [
    ...(topic.recommended ? [topic.id] : []),
    ...recommendedIds(topic.children ?? []),
  ]);
}

function collectTitles(topics: KnowledgeTopic[], selected: Set<string>): string[] {
  return topics.flatMap((topic) => [
    ...(selected.has(topic.id) ? [topic.title] : []),
    ...collectTitles(topic.children ?? [], selected),
  ]);
}

function countTopics(topics: KnowledgeTopic[]): number {
  return topics.reduce((total, topic) => total + 1 + countTopics(topic.children ?? []), 0);
}

/**
 * Knowledge-scope picker in the generation preview, before lesson-plan design
 * (docs/spec/01-user-journeys.md J2.0b): the learner checks which decomposed
 * topics to learn; recommended topics are checked by default and the whole
 * step can be skipped.
 */
export function ScopePicker({
  knowledgeMap,
  submitting,
  error,
  onSkip,
  onStart,
}: ScopePickerProps) {
  const { t } = useI18n();
  const selectionHintId = useId();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(recommendedIds(knowledgeMap.topics)),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedTitles = useMemo(
    () => collectTitles(knowledgeMap.topics, selected),
    [knowledgeMap.topics, selected],
  );
  const recommendedTitles = useMemo(
    () => collectTitles(knowledgeMap.topics, new Set(recommendedIds(knowledgeMap.topics))),
    [knowledgeMap.topics],
  );

  const renderTopic = (topic: KnowledgeTopic, depth: number) => {
    const children = topic.children ?? [];
    const hasDetails = children.length > 0 || Boolean(topic.summary);
    const open = expanded.has(topic.id);
    const indent = Math.min(depth, 3) * 16;
    const selectedChildren = collectTitles(children, selected).length;
    return (
      <li key={topic.id} className="min-w-0" data-scope-topic={topic.id}>
        <Collapsible
          open={open}
          disabled={submitting}
          onOpenChange={(next) =>
            setExpanded((current) => {
              const updated = new Set(current);
              if (next) updated.add(topic.id);
              else updated.delete(topic.id);
              return updated;
            })
          }
        >
          <div
            className="flex min-w-0 items-start gap-1 rounded-lg transition-colors hover:bg-muted/50 motion-reduce:transition-none"
            style={{ paddingInlineStart: indent }}
          >
            <label
              className={cn(
                'flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3 px-2 py-3',
                submitting && 'pointer-events-none opacity-60',
              )}
            >
              <Checkbox
                className="mt-0.5 shrink-0"
                aria-label={topic.title}
                checked={selected.has(topic.id)}
                onCheckedChange={() => toggle(topic.id)}
                disabled={submitting}
              />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="block text-sm font-medium leading-relaxed">
                  {topic.title}
                  {topic.recommended && (
                    <span className="ms-2 inline-block font-normal text-primary">
                      {t('clarify.recommended')}
                    </span>
                  )}
                </span>
                {children.length > 0 && (
                  <span
                    className={cn(
                      'mt-1 block text-sm leading-relaxed tabular-nums',
                      selectedChildren > 0 ? 'text-primary' : 'text-muted-foreground',
                    )}
                    data-scope-selection-count
                  >
                    {t('clarify.scopeSelectedChildren', {
                      selected: selectedChildren,
                      total: countTopics(children),
                    })}
                  </span>
                )}
              </span>
            </label>
            {hasDetails && (
              <CollapsibleTrigger
                aria-label={t(open ? 'clarify.scopeCollapse' : 'clarify.scopeExpand', {
                  title: topic.title,
                })}
                className="flex min-h-11 w-11 max-w-full shrink-0 items-center justify-center self-start whitespace-normal rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              >
                <ChevronDown
                  aria-hidden
                  className={cn(
                    'size-4 transition-transform duration-200 motion-reduce:transition-none',
                    open && 'rotate-180',
                  )}
                />
              </CollapsibleTrigger>
            )}
          </div>
          {hasDetails && (
            <CollapsibleContent className="lc-preview-collapse">
              {topic.summary && (
                <p
                  className="min-w-0 pb-3 pe-3 text-sm leading-relaxed text-muted-foreground"
                  style={{ paddingInlineStart: indent + 40 }}
                >
                  {topic.summary}
                </p>
              )}
              {children.length > 0 && (
                <ul className="min-w-0 pb-2">
                  {children.map((child) => renderTopic(child, depth + 1))}
                </ul>
              )}
            </CollapsibleContent>
          )}
        </Collapsible>
      </li>
    );
  };

  return (
    <div
      className="min-w-0 bg-card text-foreground [overflow-wrap:anywhere]"
      aria-busy={submitting}
    >
      <h2 className="text-xl font-semibold leading-snug tracking-tight">
        {t('clarify.scopeTitle')}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {recommendedTitles.length > 0
          ? t('clarify.scopeSubtitle', { subject: knowledgeMap.subject })
          : knowledgeMap.subject}
      </p>

      <div className="mt-5 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border pb-2">
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t('clarify.scopeOverview', {
            groups: knowledgeMap.topics.length,
            count: countTopics(knowledgeMap.topics),
          })}
        </p>
        {recommendedTitles.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-11 min-w-0 max-w-full rounded-xl px-2 py-2 whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none"
            disabled={submitting}
            onClick={() => setSelected(new Set(recommendedIds(knowledgeMap.topics)))}
          >
            {t('clarify.selectRecommended')}
          </Button>
        )}
      </div>
      {/* Reserve focus-scroll clearance for the sticky controls and bounded error message. */}
      <ul
        className="min-w-0 divide-y divide-border/60 [&_button]:scroll-mb-80"
        aria-label={t('clarify.scopeTitle')}
        data-testid="scope-topics"
      >
        {knowledgeMap.topics.map((topic) => renderTopic(topic, 0))}
      </ul>
      <div
        className="sticky bottom-0 z-10 -mx-1 mt-5 min-w-0 border-t border-border bg-card/95 px-1 pb-1 pt-3 backdrop-blur-sm"
        data-testid="scope-actions"
      >
        {error && (
          <p
            className="mb-2 max-h-24 overflow-y-auto text-sm leading-relaxed text-destructive"
            role="alert"
            tabIndex={0}
          >
            {error}
          </p>
        )}
        <p
          id={selectionHintId}
          className="min-h-12 text-sm leading-relaxed text-muted-foreground"
          role="status"
        >
          {selectedTitles.length > 0
            ? t('clarify.selectedCount', { count: selectedTitles.length })
            : t('clarify.emptySelection')}
        </p>
        <div className="grid min-w-0 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-auto min-h-11 min-w-0 max-w-full rounded-xl px-4 py-3 whitespace-normal shadow-none [overflow-wrap:anywhere] motion-reduce:transition-none"
            disabled={submitting}
            onClick={() => (recommendedTitles.length > 0 ? onStart(recommendedTitles) : onSkip())}
          >
            {t(recommendedTitles.length > 0 ? 'clarify.skipScope' : 'clarify.skipScopeDefaults')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-auto min-h-11 min-w-0 max-w-full rounded-xl px-4 py-3 whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none"
            aria-describedby={selectionHintId}
            disabled={submitting || selectedTitles.length === 0}
            onClick={() => {
              if (!submitting && selectedTitles.length > 0) onStart(selectedTitles);
            }}
          >
            {submitting && <GameLoader size="sm" />}
            {t(error ? 'preparationVisual.retryScope' : 'clarify.startClass')}
          </Button>
        </div>
      </div>
    </div>
  );
}
