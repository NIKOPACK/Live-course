'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ClarifyAnswer, ClarifyQuestion } from '@/lib/livecourse/outline/types';

interface ClarifyCardProps {
  questions: ClarifyQuestion[];
  /** true while the knowledge-map request is in flight after continuing */
  submitting?: boolean;
  onSkip: () => void;
  onContinue: (answers: ClarifyAnswer[]) => void;
}

/**
 * Inline clarification card in the generation preview, before lesson-plan
 * design (docs/spec/01-user-journeys.md J2.0). The learner taps options
 * to answer; every question is optional and the whole card can be skipped.
 */
export function ClarifyCard({ questions, submitting, onSkip, onContinue }: ClarifyCardProps) {
  const { t } = useI18n();
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const submittedRef = useRef(false);
  const questionRef = useRef<HTMLHeadingElement>(null);
  const questionId = useId();
  const question = questions[questionIndex];
  const busy = submitting || submitted;
  const hasAnswers = Object.values(selections).some((ids) => ids.length > 0);

  useEffect(() => {
    questionRef.current?.focus();
  }, [question?.id]);

  const toggleOption = (question: ClarifyQuestion, optionId: string) => {
    setSelections((prev) => {
      const current = prev[question.id] ?? [];
      const next = question.multiSelect
        ? current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
        : current.includes(optionId)
          ? []
          : [optionId];
      return { ...prev, [question.id]: next };
    });
  };

  const finish = (answersByQuestion: Record<string, string[]>) => {
    if (busy || submittedRef.current) return;
    const answers: ClarifyAnswer[] = questions.map((question) => {
      const selectedOptionIds = answersByQuestion[question.id] ?? [];
      return {
        questionId: question.id,
        question: question.question,
        selectedOptionIds,
        selectedLabels: question.options
          .filter((option) => selectedOptionIds.includes(option.id))
          .map((option) => option.label),
      };
    });
    submittedRef.current = true;
    setSubmitted(true);
    if (answers.some((answer) => answer.selectedOptionIds.length > 0)) {
      onContinue(answers);
    } else {
      onSkip();
    }
  };

  const advance = (skipCurrent = false) => {
    if (busy || !question) return;
    const nextSelections = skipCurrent ? { ...selections, [question.id]: [] } : selections;
    setSelections(nextSelections);
    if (questionIndex < questions.length - 1) {
      setQuestionIndex(questionIndex + 1);
      return;
    }
    finish(nextSelections);
  };

  return (
    <div className="min-w-0 bg-card text-foreground [overflow-wrap:anywhere]" aria-busy={busy}>
      <h2 className="text-xl font-semibold leading-snug tracking-tight">{t('clarify.title')}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t('clarify.subtitle')}</p>

      {question && (
        <div className="lc-rise mt-6" key={question.id}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" role="status">
              {t('clarify.questionProgress', {
                current: questionIndex + 1,
                total: questions.length,
              })}
            </p>
            <span className="flex items-center gap-1.5" aria-hidden="true">
              {questions.map((item, dotIndex) => (
                <span
                  key={item.id}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-300 motion-reduce:transition-none',
                    dotIndex === questionIndex
                      ? 'w-5 bg-primary'
                      : dotIndex < questionIndex
                        ? 'w-1.5 bg-primary/50'
                        : 'w-1.5 bg-border',
                  )}
                />
              ))}
            </span>
          </div>
          <h3
            ref={questionRef}
            id={questionId}
            tabIndex={-1}
            className="mt-2 text-base font-semibold leading-relaxed outline-none"
          >
            {question.question}
          </h3>
          <p
            id={`${questionId}-hint`}
            className="mt-2 text-sm leading-relaxed text-muted-foreground"
          >
            {t(question.multiSelect ? 'clarify.chooseMultiple' : 'clarify.chooseOne')}
          </p>
          <div
            role="group"
            aria-labelledby={questionId}
            aria-describedby={`${questionId}-hint`}
            className="mt-4 grid min-w-0 gap-2"
          >
            {question.options.map((option) => {
              const selected = (selections[question.id] ?? []).includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  title={option.description}
                  disabled={busy}
                  onClick={() => toggleOption(question, option.id)}
                  className={cn(
                    'flex min-h-11 w-full min-w-0 items-start gap-3 whitespace-normal rounded-xl border px-4 py-3 text-left text-sm leading-relaxed transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60',
                    selected
                      ? 'border-primary bg-accent text-foreground'
                      : 'border-border bg-card text-foreground hover:bg-accent/50',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border',
                      selected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border',
                    )}
                  >
                    {selected && <Check className="lc-pop size-4" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block">{option.label}</span>
                    {option.description && (
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {hasAnswers && (
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          {t('preparationVisual.answersKept')}
        </p>
      )}
      <div className="mt-6 grid min-w-0 gap-2 border-t border-border pt-4 sm:flex sm:flex-wrap sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto min-h-11 min-w-0 max-w-full rounded-xl px-4 py-3 whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none sm:mr-auto"
          disabled={busy}
          onClick={() => finish(selections)}
        >
          {t(hasAnswers ? 'clarify.skipRemaining' : 'clarify.skipAll')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto min-h-11 min-w-0 max-w-full rounded-xl px-4 py-3 whitespace-normal shadow-none [overflow-wrap:anywhere] motion-reduce:transition-none"
          disabled={busy || !question}
          onClick={() => advance(true)}
        >
          {t('clarify.skipCurrent')}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-auto min-h-11 min-w-0 max-w-full rounded-xl px-4 py-3 whitespace-normal [overflow-wrap:anywhere] motion-reduce:transition-none"
          disabled={busy || !(selections[question?.id] ?? []).length}
          onClick={() => advance()}
        >
          {busy && <GameLoader size="sm" />}
          {t('clarify.continue')}
        </Button>
      </div>
    </div>
  );
}
