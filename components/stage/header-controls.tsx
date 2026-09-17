'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Download,
  FileDown,
  Film,
  Loader2,
  Monitor,
  Moon,
  Package,
  Settings,
  Sun,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useExportPPTX } from '@/lib/export/use-export-pptx';
import { useExportClassroom } from '@/lib/export/use-export-classroom';
import { isLiveCourseEditorEnabled, isVideoExportEnabled } from '@/lib/config/feature-flags';
import { useVideoRenderStore } from '@/lib/store/video-render';
import { CircularProgress } from '@/components/ui/circular-progress';
import { VideoExportDialog } from './video-export-dialog';
import { LanguageSwitcher } from '../language-switcher';
import { SettingsDialog } from '../settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { StageMode } from '@/lib/types/stage';

interface HeaderControlsProps {
  readonly mode?: StageMode;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  /**
   * `default` — the chunky h-9 pill used in the playback Stage Header.
   * `compact` — slightly tighter padding for embedding in CommandBar's
   * right slot (Pro mode chrome already eats height, so the pill backs
   * off ring weight / blur to keep the CommandBar quiet).
   */
  readonly variant?: 'default' | 'compact';
}

/**
 * Stage-level global controls: language picker, theme picker, settings
 * modal trigger, and the Pro Switch. Extracted out of `Header` so the
 * Pro mode CommandBar can absorb the same affordances and the playback
 * Header doesn't need to stay mounted just to host them — Pro mode
 * therefore lands on a single top-chrome bar instead of stacking the
 * Stage Header above the EditShell CommandBar.
 *
 * Only one instance is ever mounted at a time (Stage renders Header
 * for playback and EditShell.CommandBar's trailing slot for edit, but
 * never both), so dropdown / dialog state and refs stay co-located
 * here without cross-instance leakage.
 */
export function HeaderControls({
  mode,
  canEdit,
  onToggleEditMode,
  variant = 'default',
}: HeaderControlsProps) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);

  // Export plumbing — uses the stage / media task stores to check
  // readiness, then hands off to the export hooks. Available in both
  // playback and edit chrome so the icon's screen position is stable
  // across mode swaps (was previously in `Header` only, missing from
  // CommandBar's right cluster).
  const scenes = useStageStore((s) => s.scenes);
  const generatingOutlines = useStageStore((s) => s.generatingOutlines);
  const failedOutlines = useStageStore((s) => s.failedOutlines);
  const mediaTasks = useMediaGenerationStore((s) => s.tasks);
  const { exporting: isExporting, exportPPTX, exportResourcePack } = useExportPPTX();
  const { exporting: isExportingZip, exportClassroomZip } = useExportClassroom();
  const editorEnabled = isLiveCourseEditorEnabled();
  // Learner classroom chrome must not expose PPTX / MP4 / ZIP export
  // (docs/spec/04-detailed-design.md §4). Editor chrome may still use it.
  const showExportMenu = editorEnabled && mode === 'edit';
  const videoExportEnabled = showExportMenu && isVideoExportEnabled();
  // Video render lives in a global store so its progress ring stays on the
  // export button even after the menu closes / scenes switch mid-render.
  const videoRendering = useVideoRenderStore(
    (s) => s.status === 'compiling' || s.status === 'rendering',
  );
  const videoRenderPercent = useVideoRenderStore((s) => s.percent);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  const canExport =
    scenes.length > 0 &&
    generatingOutlines.length === 0 &&
    failedOutlines.length === 0 &&
    Object.values(mediaTasks).every((task) => task.status === 'done' || task.status === 'failed');

  const handleClickOutside = useCallback(
    (e: MouseEvent) => {
      if (exportMenuOpen && exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    },
    [exportMenuOpen],
  );
  useEffect(() => {
    if (!exportMenuOpen) return;
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [exportMenuOpen, handleClickOutside]);

  const compact = variant === 'compact';

  // Self-contained spacing so the control cluster is identical regardless of
  // host. The playback Header (`gap-4`) and the edit CommandBar's trailing
  // slot (`gap-2`) would otherwise impose different inter-control spacing on
  // these fragment children, making the pill/switch/export cluster visibly
  // shift width and position across the mode swap. A fixed internal gap keeps
  // the cluster pixel-stable; both hosts pad to `px-8`, so the right edge
  // anchors identically too.
  return (
    <div className="flex shrink-0 items-center gap-2">
      <div
        className={cn(
          'flex shrink-0 items-center gap-1 rounded-md border bg-gray-50/80 shadow-sm backdrop-blur-md dark:bg-gray-900/80',
          compact
            ? 'border-zinc-200/70 px-1 py-0.5 dark:border-zinc-700/70'
            : 'border-gray-200/70 px-1 py-0.5 dark:border-gray-700/70',
        )}
      >
        {/* Language — Radix DropdownMenu so its menu portals to body
            and never gets clipped by an ancestor's overflow-hidden. */}
        <LanguageSwitcher />

        {/* Theme — same Portal-backed DropdownMenu pattern. Non-modal keeps
            Radix from body scroll-locking a fixed-height classroom layout. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              className="grid size-9 place-items-center rounded-md text-gray-500 transition-colors hover:bg-white hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              aria-label={t('settings.theme')}
            >
              {theme === 'light' && <Sun className="w-4 h-4" />}
              {theme === 'dark' && <Moon className="w-4 h-4" />}
              {theme === 'system' && <Monitor className="w-4 h-4" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="min-w-[140px]">
            <DropdownMenuItem
              onSelect={() => setTheme('light')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'light' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Sun className="w-4 h-4" />
              {t('settings.themeOptions.light')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('dark')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'dark' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Moon className="w-4 h-4" />
              {t('settings.themeOptions.dark')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('system')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'system' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Monitor className="w-4 h-4" />
              {t('settings.themeOptions.system')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Settings */}
        <button
          onClick={() => setSettingsOpen(true)}
          className="group grid size-9 place-items-center rounded-md text-gray-500 transition-colors hover:bg-white hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          aria-label={t('settings.title')}
        >
          <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
        </button>
      </div>

      {/* Pro Switch — toggle property: on/off both clickable, not a
          one-way "Done" button. Disabled only when the current scene
          can't be entered (pending/generating/etc.). Fades in with its
          host bar on the mode swap (no cross-bar layoutId morph: the
          playback Header and edit CommandBar have different left-side
          widths, so morphing made the pill visibly drift). */}
      {onToggleEditMode && editorEnabled && (
        <label
          className={cn(
            'inline-flex h-9 shrink-0 items-center gap-2 rounded-md border bg-white/70 px-2.5 shadow-sm backdrop-blur-md transition-colors duration-200 dark:bg-gray-900/70',
            compact && 'h-8',
            mode === 'edit'
              ? 'border-violet-500/60 dark:border-violet-400/60'
              : 'border-gray-100/50 dark:border-gray-700/50',
            !canEdit && mode !== 'edit'
              ? 'opacity-60 cursor-not-allowed'
              : 'cursor-pointer hover:border-violet-400/60 dark:hover:border-violet-500/50',
          )}
          // When disabled (e.g. the course-complete placeholder), explain why
          // on hover and point the user to a real scene instead of a bare
          // "Edit course" label they can't act on.
          title={
            !canEdit && mode !== 'edit'
              ? t('stage.proModeDisabledHint')
              : mode === 'edit'
                ? t('stage.doneEditing')
                : t('stage.editCourse')
          }
        >
          <span
            className={cn(
              'select-none text-[11px] font-semibold tabular-nums transition-colors duration-200',
              mode === 'edit'
                ? 'text-violet-600 dark:text-violet-300'
                : 'text-gray-500 dark:text-gray-400',
            )}
          >
            {t('edit.proMode')}
          </span>
          <Switch
            checked={mode === 'edit'}
            onCheckedChange={onToggleEditMode}
            disabled={!canEdit && mode !== 'edit'}
            aria-label={mode === 'edit' ? t('stage.doneEditing') : t('stage.editCourse')}
            className="data-[state=checked]:bg-violet-600 dark:data-[state=checked]:bg-violet-500"
          />
        </label>
      )}

      {/* Export / Download — editor chrome only. The classroom header
          must not expose PPTX / MP4 / ZIP (docs/spec/04 §4). */}
      {showExportMenu ? (
        <div className="relative" ref={exportRef}>
          <button
            onClick={() => {
              if (canExport && !isExporting && !isExportingZip) {
                setExportMenuOpen(!exportMenuOpen);
              }
            }}
            disabled={!canExport || isExporting || isExportingZip}
            title={
              canExport
                ? isExporting || isExportingZip
                  ? t('export.exporting')
                  : t('export.pptx')
                : t('share.notReady')
            }
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-md transition-colors',
              canExport && !isExporting && !isExportingZip
                ? 'text-gray-400 dark:text-gray-500 hover:bg-white dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 hover:shadow-sm'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed opacity-50',
            )}
            aria-label={t('export.pptx')}
          >
            {isExporting || isExportingZip ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : videoRendering ? (
              // Persistent ring: video render runs in the background; keep it
              // visible on the button whether or not the menu is open.
              <CircularProgress value={videoRenderPercent} size={20} className="text-primary" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </button>
          {exportMenuOpen && (
            <div className="absolute top-full mt-2 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg overflow-hidden z-50 min-w-[200px]">
              <button
                onClick={() => {
                  setExportMenuOpen(false);
                  exportPPTX();
                }}
                className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2.5"
              >
                <FileDown className="w-4 h-4 text-gray-400 shrink-0" />
                <span>{t('export.pptx')}</span>
              </button>
              <button
                onClick={() => {
                  setExportMenuOpen(false);
                  exportResourcePack();
                }}
                className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2.5"
              >
                <Package className="w-4 h-4 text-gray-400 shrink-0" />
                <div>
                  <div>{t('export.resourcePack')}</div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t('export.resourcePackDesc')}
                  </div>
                </div>
              </button>
              <button
                onClick={() => {
                  setExportMenuOpen(false);
                  exportClassroomZip();
                }}
                disabled={isExportingZip}
                className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2.5"
              >
                <Archive className="w-4 h-4 text-gray-400 shrink-0" />
                <div>
                  <div>{t('export.classroomZip')}</div>
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">
                    {t('export.classroomZipDesc')}
                  </div>
                </div>
              </button>
              {videoExportEnabled && (
                <button
                  onClick={() => {
                    setExportMenuOpen(false);
                    setVideoDialogOpen(true);
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-2.5 border-t border-gray-200 dark:border-gray-700"
                >
                  <Film className="w-4 h-4 text-gray-400 shrink-0" />
                  <div>
                    <div>{t('export.video')}</div>
                    <div className="text-[11px] text-gray-400 dark:text-gray-500">
                      {t('export.videoDesc')}
                    </div>
                  </div>
                </button>
              )}
            </div>
          )}
        </div>
      ) : null}

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {videoExportEnabled && (
        <VideoExportDialog open={videoDialogOpen} onOpenChange={setVideoDialogOpen} />
      )}
    </div>
  );
}
