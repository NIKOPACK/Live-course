'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { AiriVrmAvatarStatus } from '@/components/livecourse/TeacherAvatar';
import { TeacherAvatarPoster } from '@/components/livecourse/TeacherAvatarPoster';

function TeacherPoster() {
  return (
    <div className="lc-avatar absolute inset-0 overflow-hidden" aria-hidden="true">
      <TeacherAvatarPoster />
    </div>
  );
}

const TeacherAvatar = dynamic(
  () => import('@/components/livecourse/TeacherAvatar').then((module) => module.TeacherAvatar),
  { ssr: false, loading: TeacherPoster },
);

export function HomeTeacherScene() {
  const { t } = useI18n();
  const [liveAvatarRequested, setLiveAvatarRequested] = useState(false);
  const [avatarStatus, setAvatarStatus] = useState<AiriVrmAvatarStatus>('idle');

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;

    const liveSceneMedia = window.matchMedia(
      '(min-width: 1024px) and (prefers-reduced-motion: no-preference)',
    );
    let disposed = false;
    let idleId: number | undefined;
    let timerId: number | undefined;

    const cancelUpgrade = () => {
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (timerId !== undefined) window.clearTimeout(timerId);
      idleId = undefined;
      timerId = undefined;
    };

    // Keep the 26 MB model off narrow or reduced-motion screens.
    const updateMedia = () => {
      cancelUpgrade();
      if (!liveSceneMedia.matches) {
        setLiveAvatarRequested(false);
        setAvatarStatus('idle');
        return;
      }

      const upgrade = () => {
        idleId = undefined;
        timerId = undefined;
        if (!disposed && liveSceneMedia.matches) setLiveAvatarRequested(true);
      };
      if (
        typeof window.requestIdleCallback === 'function' &&
        typeof window.cancelIdleCallback === 'function'
      ) {
        idleId = window.requestIdleCallback(upgrade, { timeout: 3000 });
      } else {
        timerId = window.setTimeout(upgrade, 1500);
      }
    };

    updateMedia();
    liveSceneMedia.addEventListener('change', updateMedia);
    return () => {
      disposed = true;
      cancelUpgrade();
      liveSceneMedia.removeEventListener('change', updateMedia);
    };
  }, []);

  return (
    <aside className="lc-home-scene" aria-labelledby="home-teacher-title">
      <figure className="lc-home-board" aria-labelledby="home-board-title">
        <figcaption>
          <p id="home-board-title" className="lc-board-title">
            {t('home.boardTitle')}
          </p>
        </figcaption>
        <svg className="lc-board-diagram" viewBox="0 0 300 260" fill="none" aria-hidden="true">
          <g className="lc-board-axes">
            <path d="M30 20V230H278" />
            <path d="m25 27 5-7 5 7M271 225l7 5-7 5" />
            <path d="M90 230v5m60-5v5m60-5v5M25 170h5m-5-60h5" />
          </g>
          <path className="lc-board-guide" d="M156 159.4V230M30 159.4H156" />
          <path className="lc-board-curve" d="M30 230Q135 230 240 34" pathLength="1" />
          <path className="lc-board-tangent" d="m106 215.4 110-123.2" pathLength="1" />
          <circle className="lc-board-point" cx="156" cy="159.4" r="5" />
          <g className="lc-board-axis-labels">
            <text x="269" y="252">
              x
            </text>
            <text x="12" y="24">
              y
            </text>
          </g>
        </svg>
        <div className="lc-board-equation" aria-hidden="true">
          <span>
            f(x) = x<sup>2</sup>
          </span>
          <span>f&prime;(x) = 2x</span>
        </div>
        <p className="lc-board-note">{t('home.boardNote')}</p>
      </figure>

      <div className="lc-teacher-portrait" data-testid="home-teacher-portrait">
        {liveAvatarRequested ? (
          <TeacherAvatar
            mode="idle"
            expression="neutral"
            lookAt="camera"
            className="absolute inset-0"
            onStatusChange={setAvatarStatus}
          />
        ) : (
          <TeacherPoster />
        )}
      </div>

      <div className="lc-teacher-caption">
        <h2 id="home-teacher-title" role="status">
          {liveAvatarRequested && avatarStatus === 'ready'
            ? t('home.avatarGreeting')
            : t('home.teacherTitle')}
        </h2>
        <p>{t('home.teacherHint')}</p>
      </div>
    </aside>
  );
}
