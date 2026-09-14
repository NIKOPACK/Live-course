'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { useLiveCaptionStore } from '@/lib/store/live-caption';

/** Captions disappear once the stream has been silent this long — a finished
 * utterance must not linger over the next node's slide. */
const CAPTION_STALE_MS = 6_000;

/**
 * J3.1/J3.2 实时字幕（docs/spec/02-product-manual.md 课堂）：教师讲授文本与
 * 学习者插话识别回显的只读投影。只是可见反馈——不持久化、不产生证据。
 * 字幕事件不可达时整个叠层静默缺省，不影响讲授。
 */
export function LiveCaptionOverlay() {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const caption = useLiveCaptionStore((state) => state.caption);
  // Hides exactly the caption that was current when the timer fired; a newer
  // caption (different `at`) re-shows itself without an extra state write.
  const [staleAt, setStaleAt] = useState<number | null>(null);

  useEffect(() => {
    if (!caption) return;
    const at = caption.at;
    const timer = setTimeout(() => setStaleAt(at), CAPTION_STALE_MS);
    return () => clearTimeout(timer);
  }, [caption]);

  const visible = caption !== null && caption.at !== staleAt;

  return (
    <div
      data-testid="classroom-captions"
      className="max-h-28 shrink-0 overflow-y-auto"
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
            className="lc-classroom-captions-line px-4 py-3 text-sm leading-6 [overflow-wrap:anywhere]"
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
