'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import type { Slide } from '@livecourse/dsl';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { Scene } from '@/lib/types/stage';
import { HtmlPagePreview } from '@/components/scene-renderers/html-page-preview';

export function SegmentClassroomPending({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <div data-testid="segment-classroom-pending" data-readonly="true" className="min-w-0">
      <p className="mb-2 text-sm font-medium text-foreground">{t('generation.classroomPreview')}</p>
      <div
        role="status"
        aria-busy="true"
        className="lc-active-sheen relative flex aspect-video w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-lg bg-muted px-3 text-center sm:px-6"
      >
        <BookOpen className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-pretty text-sm font-medium leading-relaxed text-foreground">{message}</p>
      </div>
    </div>
  );
}

export function SegmentClassroomPreview({ scene }: { scene: Scene }) {
  const { t } = useI18n();

  if (
    (scene.content.type === 'interactive' || scene.content.type === 'quiz') &&
    scene.content.html
  ) {
    return (
      <div data-testid="segment-classroom-preview" data-readonly="true" className="min-w-0">
        <p className="mb-2 text-sm font-medium text-foreground">
          {t(
            scene.content.type === 'quiz'
              ? 'generation.quizPreview'
              : 'generation.classroomPreview',
          )}
        </p>
        <HtmlPagePreview
          html={scene.content.html}
          title={scene.title}
          stageId={scene.stageId}
          questions={scene.content.type === 'quiz' ? scene.content.questions : undefined}
        />
      </div>
    );
  }

  if (scene.content.type === 'slide') {
    return (
      <div data-testid="segment-classroom-preview" data-readonly="true" className="min-w-0">
        <p className="mb-2 text-sm font-medium text-foreground">
          {t('generation.classroomPreview')}
        </p>
        <SlidePreview slide={scene.content.canvas} />
      </div>
    );
  }

  if (scene.content.type === 'quiz') {
    return (
      <div
        data-testid="segment-classroom-preview"
        data-readonly="true"
        className="min-w-0 space-y-2"
      >
        <p className="text-sm font-medium text-foreground">{t('generation.quizPreview')}</p>
        <ol className="space-y-2 text-sm leading-relaxed text-muted-foreground">
          {scene.content.questions.map((question, index) => (
            <li key={question.id || index}>
              {index + 1}. {question.question}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div data-testid="segment-classroom-preview" data-readonly="true" className="min-w-0 space-y-1">
      <p className="text-sm font-medium text-foreground">
        {scene.content.type === 'pbl'
          ? t('generation.pblPreview')
          : t('generation.interactivePreview')}
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">{scene.title}</p>
    </div>
  );
}

function SlidePreview({ slide }: { slide: Slide }) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const [thumbWidth, setThumbWidth] = useState(0);

  useEffect(() => {
    const el = thumbRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setThumbWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={thumbRef}
      className="relative aspect-[16/9] w-full overflow-hidden rounded-lg bg-muted"
    >
      {thumbWidth > 0 ? (
        <SlideThumbnail
          slide={slide}
          size={thumbWidth}
          viewportSize={slide.viewportSize ?? 1000}
          viewportRatio={slide.viewportRatio ?? 0.5625}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <BookOpen className="size-5 text-muted-foreground" aria-hidden />
        </div>
      )}
    </div>
  );
}
