'use client';

import { useEffect, useRef, useState } from 'react';
import { HtmlQuizSurface } from './html-quiz-surface';
import type { QuizQuestion } from '@/lib/types/stage';

/** Isolated read-only document: no pool activation, attempt hydration or writes. */
export function HtmlPagePreview({
  html,
  title,
  stageId,
  size,
  viewportSize = 1000,
  viewportRatio = 0.5625,
  questions,
}: {
  html: string;
  title: string;
  stageId?: string;
  size?: number;
  viewportSize?: number;
  viewportRatio?: number;
  questions?: QuizQuestion[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (size || !element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setMeasuredWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [size]);

  const width = size ?? measuredWidth;
  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden bg-background"
      style={{ aspectRatio: `${1 / viewportRatio}` }}
      data-readonly="true"
    >
      <div
        className="absolute inset-0 origin-top-left"
        style={
          width > 0
            ? {
                width: viewportSize,
                height: viewportSize * viewportRatio,
                transform: `scale(${width / viewportSize})`,
              }
            : undefined
        }
      >
        <HtmlQuizSurface html={html} title={title} stageId={stageId} questions={questions} />
      </div>
    </div>
  );
}
