'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  CourseShareRedeemError,
  fetchShareMetadata,
  readShareRedeemRegistration,
  redeemCourseShare,
  type ShareMetadata,
} from '@/lib/livecourse/share';

type LandingState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready'; meta: ShareMetadata; existingStageId?: string }
  | { status: 'joining'; meta: ShareMetadata }
  | { status: 'joined'; stageId: string; meta: ShareMetadata }
  | { status: 'error'; meta?: ShareMetadata };

export default function ShareLandingPage() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = typeof params.token === 'string' ? params.token : '';
  const [state, setState] = useState<LandingState>({ status: 'loading' });
  const joiningRef = useRef(false);

  const load = useCallback(async () => {
    if (!token) {
      setState({ status: 'missing' });
      return;
    }
    setState({ status: 'loading' });
    try {
      const meta = await fetchShareMetadata(token);
      const existing = await readShareRedeemRegistration(token);
      setState({
        status: 'ready',
        meta,
        existingStageId: existing?.stageId,
      });
    } catch (error) {
      if (error instanceof CourseShareRedeemError && error.status === 404) {
        setState({ status: 'missing' });
        return;
      }
      setState({ status: 'error' });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const join = async () => {
    if (joiningRef.current) return;
    if (state.status !== 'ready' && state.status !== 'error') return;
    const meta = state.status === 'ready' ? state.meta : state.meta;
    if (!meta) return;
    joiningRef.current = true;
    setState({ status: 'joining', meta });
    try {
      const redeemed = await redeemCourseShare(token);
      setState({ status: 'joined', stageId: redeemed.stageId, meta });
    } catch {
      setState({ status: 'error', meta });
    } finally {
      joiningRef.current = false;
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-6 py-16">
      {state.status === 'loading' ? (
        <GameLoader size="md" label={t('shareLanding.loading')} />
      ) : null}

      {state.status === 'missing' ? (
        <>
          <h1 className="text-2xl font-semibold">{t('shareLanding.missingTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('shareLanding.missingBody')}</p>
          <Button type="button" onClick={() => router.push('/')}>
            {t('shareLanding.home')}
          </Button>
        </>
      ) : null}

      {state.status === 'ready' ||
      state.status === 'joining' ||
      state.status === 'joined' ||
      (state.status === 'error' && state.meta) ? (
        <>
          <p className="text-sm text-muted-foreground">{t('shareLanding.kicker')}</p>
          <div
            data-testid="share-landing-cover"
            className="relative aspect-[16/9] w-full overflow-hidden rounded-lg bg-muted"
          >
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
                <BookOpen className="size-5 opacity-70" aria-hidden="true" />
              </div>
            </div>
          </div>
          <h1 className="text-2xl font-semibold [overflow-wrap:anywhere]">
            {'meta' in state && state.meta ? state.meta.title : ''}
          </h1>
          <p data-testid="share-landing-scene-count" className="text-sm text-muted-foreground">
            {t('shareLanding.sceneCount', {
              count: 'meta' in state && state.meta ? state.meta.sceneCount : 0,
            })}
          </p>
          <p className="text-sm text-muted-foreground">{t('shareLanding.zeroProgress')}</p>
          {state.status === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t('shareLanding.failed')}
            </p>
          ) : null}
          {state.status === 'joining' ? (
            <GameLoader size="md" label={t('shareLanding.joining')} />
          ) : null}
          {state.status === 'joined' ? (
            <div className="flex flex-col gap-3">
              <Button type="button" onClick={() => router.push(`/classroom/${state.stageId}`)}>
                {t('shareLanding.enter')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => router.push('/')}>
                {t('shareLanding.home')}
              </Button>
            </div>
          ) : null}
          {state.status === 'ready' && state.existingStageId ? (
            <div className="flex flex-col gap-3">
              <Button
                type="button"
                onClick={() => router.push(`/?course=${encodeURIComponent(state.existingStageId!)}`)}
              >
                {t('shareLanding.openCopy')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => router.push('/')}>
                {t('shareLanding.home')}
              </Button>
            </div>
          ) : null}
          {(state.status === 'ready' && !state.existingStageId) ||
          (state.status === 'error' && state.meta) ? (
            <div className="flex flex-col gap-3">
              <Button
                type="button"
                data-testid="share-landing-join"
                onClick={() => void join()}
              >
                {t('shareLanding.join')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => router.push('/')}>
                {t('shareLanding.home')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {state.status === 'error' && !state.meta ? (
        <>
          <p role="alert" className="text-sm text-destructive">
            {t('shareLanding.failed')}
          </p>
          <Button type="button" onClick={() => void load()}>
            {t('shareLanding.retry')}
          </Button>
        </>
      ) : null}
    </main>
  );
}
