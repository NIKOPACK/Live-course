'use client';

import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useRouter } from 'next/navigation';
import type { StageMode } from '@/lib/types/stage';
import { HeaderControls } from './stage/header-controls';

interface HeaderProps {
  readonly currentSceneTitle: string;
  readonly mode?: StageMode;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
}

export function Header({ currentSceneTitle, mode, canEdit, onToggleEditMode }: HeaderProps) {
  const { t } = useI18n();
  const router = useRouter();

  return (
    <>
      <header className="z-10 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-gray-200/70 bg-white/85 px-6 backdrop-blur-md dark:border-gray-800 dark:bg-gray-950/85">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <button
            onClick={() => router.push('/')}
            className="grid size-10 shrink-0 place-items-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
            title={t('generation.backToHome')}
          >
            <ArrowLeft className="size-5" />
          </button>
          {/* Title block — hidden when `mode === 'edit'`. Header lives
              inside `PlaybackChromeRoot`, which is unmounted by `Stage`
              once mode flips to 'edit', so in steady state this branch
              is always taken. The guard exists for the ~280ms
              AnimatePresence exit window where the playback chrome
              is still rendering its exit animation while `mode` has
              already flipped — without the guard, this title would
              briefly stack on top of the incoming EditChromeRoot's
              CommandBar title during the cross-fade. */}
          {mode !== 'edit' && (
            <div className="flex min-w-0 flex-col">
              <span className="mb-0.5 text-[10px] font-medium text-gray-500 dark:text-gray-400">
                {t('stage.currentScene')}
              </span>
              <h1
                className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100"
                suppressHydrationWarning
              >
                {currentSceneTitle || t('common.loading')}
              </h1>
            </div>
          )}
        </div>

        <HeaderControls mode={mode} canEdit={canEdit} onToggleEditMode={onToggleEditMode} />
      </header>
    </>
  );
}
