'use client';

import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GameLoader } from '@/components/livecourse/GameLoader';
import { TeacherAvatarPoster } from '@/components/livecourse/TeacherAvatarPoster';
import { useI18n } from '@/lib/hooks/use-i18n';

import type {
  AiriVrmAvatarElementApi,
  AiriVrmAvatarStatus,
  AiriVrmLookAt,
  AiriVrmStatusDetail,
} from '@/lib/livecourse/avatar/airi-vrm-element';
import {
  getActiveRealtimeAudioBridge,
  subscribeRealtimeAudioBridge,
} from '@/lib/livecourse/realtime/client/audio-bridge';
import { useAvatarSettingsStore } from '@/lib/store/avatar-settings';
import { cn } from '@/lib/utils';

export type TeacherAvatarMode = 'idle' | 'speaking' | 'thinking';
export type TeacherAvatarExpression = 'neutral' | 'relaxed' | 'think' | 'happy' | 'surprised';
export type { AiriVrmAvatarStatus };

interface TeacherAvatarProps {
  mode: TeacherAvatarMode;
  expression: TeacherAvatarExpression;
  lookAt: AiriVrmLookAt;
  className?: string;
  onStatusChange?: (status: AiriVrmAvatarStatus) => void;
}

const DEFAULT_MODEL_SRC = '/api/livecourse/avatar/model';
const DEFAULT_IDLE_ANIMATION_SRC = '/vendor/airi/idle_loop.vrma';

function configuredSource(value: string | undefined, fallback = ''): string {
  const configured = value?.trim();
  if (configured?.toLowerCase() === 'off') return '';
  return configured || fallback;
}

export function TeacherAvatar({
  mode,
  expression,
  lookAt,
  className,
  onStatusChange,
}: TeacherAvatarProps) {
  const { t } = useI18n();
  const mountRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<AiriVrmAvatarElementApi | null>(null);
  const [status, setStatus] = useState<AiriVrmAvatarStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const avatarEnabled = useAvatarSettingsStore((s) => s.enabled);
  const settingsModelUrl = useAvatarSettingsStore((s) => s.modelUrl);
  const settingsIdleAnimationUrl = useAvatarSettingsStore((s) => s.idleAnimationUrl);
  const trackingMode = useAvatarSettingsStore((s) => s.trackingMode);
  const interactionsEnabled = useAvatarSettingsStore((s) => s.interactionsEnabled);
  const configuredModelSrc =
    settingsModelUrl ||
    configuredSource(process.env.NEXT_PUBLIC_LIVECOURSE_VRM_URL, DEFAULT_MODEL_SRC);
  const modelSrc = avatarEnabled ? configuredModelSrc : '';
  const idleAnimationSrc =
    settingsIdleAnimationUrl ||
    configuredSource(process.env.NEXT_PUBLIC_LIVECOURSE_VRM_IDLE_URL, DEFAULT_IDLE_ANIMATION_SRC);
  const usesBuiltInModel = configuredModelSrc === DEFAULT_MODEL_SRC;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let removeAudioSubscription: (() => void) | undefined;
    let handleStatus: ((event: Event) => void) | undefined;

    const loadAiri = () => import('@/lib/livecourse/avatar/airi-vrm-element');
    void loadAiri()
      .catch(() => loadAiri())
      .then(({ ensureAiriVrmAvatarElement }) => {
        if (disposed) return;
        ensureAiriVrmAvatarElement();

        const avatar = document.createElement('airi-vrm-avatar');
        avatar.className = 'block size-full';
        avatar.modelSrc = modelSrc;
        avatar.idleAnimationSrc = idleAnimationSrc;

        handleStatus = (event) => {
          const detail = (event as CustomEvent<AiriVrmStatusDetail>).detail;
          setStatus(detail.status);
          setError(detail.error ?? null);
        };
        avatar.addEventListener('airi-vrm-status', handleStatus);
        mount.replaceChildren(avatar);
        avatarRef.current = avatar;
        setStatus(avatar.status);

        const connectActiveAudio = () => {
          if (!disposed) {
            avatar.connectAudio(getActiveRealtimeAudioBridge()?.audioNode ?? null);
          }
        };
        removeAudioSubscription = subscribeRealtimeAudioBridge(connectActiveAudio);
        connectActiveAudio();
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      disposed = true;
      removeAudioSubscription?.();
      const avatar = avatarRef.current;
      if (avatar && handleStatus) avatar.removeEventListener('airi-vrm-status', handleStatus);
      avatar?.disconnectAudio();
      avatar?.remove();
      avatarRef.current = null;
    };
  }, [idleAnimationSrc, modelSrc, loadAttempt]);

  useEffect(() => {
    avatarRef.current?.setExpression(expression);
  }, [expression, status]);

  useEffect(() => {
    avatarRef.current?.setLookAt(lookAt);
  }, [lookAt, status]);

  useEffect(() => {
    const avatar = avatarRef.current;
    if (avatar) avatar.trackingMode = trackingMode;
  }, [trackingMode, status]);

  useEffect(() => {
    const avatar = avatarRef.current;
    if (avatar) avatar.interactionsEnabled = interactionsEnabled;
  }, [interactionsEnabled, status]);

  const ready = status === 'ready';
  const failed = status === 'error' || status === 'unsupported';
  const showingPoster = !ready;

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  return (
    <div
      role="group"
      aria-label={t('home.teacherTitle')}
      data-avatar-mode={mode}
      data-avatar-status={status}
      className={cn('lc-avatar relative isolate overflow-hidden', className)}
    >
      <div
        aria-hidden="true"
        data-testid="teacher-stage-bg"
        className="pointer-events-none absolute inset-0"
      />
      {usesBuiltInModel && (
        <TeacherAvatarPoster
          className={cn(
            'z-[1] transition-opacity duration-200 motion-reduce:transition-none',
            showingPoster ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
      <div
        ref={mountRef}
        data-testid="teacher-canvas"
        className={cn(
          'absolute inset-0 z-[2] transition-opacity duration-200 motion-reduce:transition-none',
          ready ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      {avatarEnabled && modelSrc && (status === 'idle' || status === 'loading') && (
        <div
          className="absolute inset-x-0 bottom-0 z-[3] flex justify-center bg-card/90 px-3 py-2"
          role="status"
        >
          <span className="inline-flex items-center gap-2 text-xs leading-5 text-muted-foreground">
            <GameLoader size="sm" />
            {t('home.avatarPreparing')}
          </span>
        </div>
      )}

      {failed && (
        <div
          className="absolute inset-x-0 bottom-0 z-[3] flex items-center gap-2 bg-card/95 px-3 py-1.5"
          role="alert"
        >
          <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />
          <p
            className="min-w-0 flex-1 truncate text-xs leading-5 text-destructive"
            title={error ?? undefined}
          >
            {t('home.avatarUnavailable')}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => {
              setStatus('loading');
              setError(null);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            {t('home.avatarRetry')}
          </Button>
        </div>
      )}
    </div>
  );
}
