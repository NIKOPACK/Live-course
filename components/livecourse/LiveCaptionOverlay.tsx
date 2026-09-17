'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { useLiveCaptionStore } from '@/lib/store/live-caption';

/** Captions disappear once the stream has been silent this long — a finished
 * utterance must not linger over the next node's slide. */
const CAPTION_STALE_MS = 6_000;

/**
 * Pins captions to the bottom of the nearest positioned ancestor. Teaching HTML
 * keeps that ancestor on the board slot so the layer paints above the body-
 * portaled iframe (z-index 1). Quiz host Start/Submit lives in a sibling strip,
 * so the ancestor must be the page surface, not the whole board.
 */
export function ClassroomCaptionLayer() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
      <LiveCaptionOverlay />
    </div>
  );
}

/**
 * J3.1/J3.2 实时字幕（docs/spec/02-product-manual.md 课堂）：教师讲授文本与
 * 学习者插话识别回显的只读投影。只是可见反馈——不持久化、不产生证据。
 * 字幕事件不可达时整个叠层静默缺省，不影响讲授。
 */
export function LiveCaptionOverlay() {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const caption = useLiveCaptionStore((state) => state.caption);
  const held = useLiveCaptionStore((state) => state.holdCount > 0);
  const captionWindow = useMemo(() => ({ caption, held }), [caption, held]);
  const [expiredWindow, setExpiredWindow] = useState<typeof captionWindow | null>(null);

  useEffect(() => {
    if (!captionWindow.caption || captionWindow.held) return;
    const timer = setTimeout(() => setExpiredWindow(captionWindow), CAPTION_STALE_MS);
    return () => clearTimeout(timer);
  }, [captionWindow]);

  const visible = caption !== null && captionWindow !== expiredWindow;

  return (
    <div
      data-testid="classroom-captions"
      className="pointer-events-auto max-h-16 overflow-y-auto"
      role="log"
      aria-label={t('livecourse.captionTitle')}
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence>
        {visible ? (
          <motion.p
            key={caption.speaker}
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.15 }}
            className="lc-classroom-captions-line px-4 py-2 text-sm leading-5 [overflow-wrap:anywhere]"
          >
            <span
              className="lc-status-pill me-2 align-middle"
              data-tone={caption.speaker === 'student' ? 'idle' : 'active'}
            >
              {caption.speaker === 'student' ? t('livecourse.captionYou') : t('home.teacherTitle')}
            </span>
            {caption.text}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
