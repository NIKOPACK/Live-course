'use client';

import { useId, useMemo, useState } from 'react';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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

  const renderTopic = (topic: KnowledgeTopic, depth: number) => (
    <li key={topic.id} className="min-w-0">
      <label
        style={{ paddingInlineStart: `${8 + Math.min(depth, 3) * 12}px` }}
        className={cn(
          'flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-xl px-2 py-3 transition-colors motion-reduce:transition-none hover:bg-accent/50',
          selected.has(topic.id) && 'bg-accent',
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
              <span className="lc-status-pill ms-2 align-middle" data-tone="active">
                {t('clarify.recommended')}
              </span>
            )}
          </span>
          {topic.summary && (
            <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
              {topic.summary}
            </span>
          )}
        </span>
      </label>
      {topic.children?.length ? (
        <ul>{topic.children.map((child) => renderTopic(child, depth + 1))}</ul>
      ) : null}
    </li>
  );

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

      <ul className="lc-rise mt-6 min-w-0 space-y-1.5" aria-label={t('clarify.scopeTitle')}>
        {knowledgeMap.topics.map((topic) => renderTopic(topic, 0))}
      </ul>

      <p
        id={selectionHintId}
        className="mt-4 text-sm leading-relaxed text-muted-foreground"
        role="status"
      >
        {selectedTitles.length > 0
          ? t('clarify.selectedCount', { count: selectedTitles.length })
          : t('clarify.emptySelection')}
      </p>
      {error && (
        <p className="mt-4 text-sm leading-relaxed text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="mt-6 grid min-w-0 gap-2 border-t border-border pt-4 sm:flex sm:flex-wrap sm:justify-end">
        {recommendedTitles.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-11 min-w-0 max-w-full rounded-xl px-4 py-3 whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none sm:mr-auto"
            disabled={submitting}
            onClick={() => setSelected(new Set(recommendedIds(knowledgeMap.topics)))}
          >
            {t('clarify.selectRecommended')}
          </Button>
        )}
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
  );
}
