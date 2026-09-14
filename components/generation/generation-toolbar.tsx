'use client';

import { useState, useRef, useMemo, useEffect } from 'react';
import { Brain, Paperclip, FileText, X, CheckCircle2, AlertCircle, RotateCcw } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import type {
  ModelInfo,
  ThinkingConfig,
  ThinkingEffort,
  ThinkingLevel,
} from '@/lib/types/provider';
import {
  getDefaultThinkingConfig,
  normalizeThinkingConfig,
  supportsConfigurableThinking,
} from '@/lib/ai/thinking-config';
import { getAcceptStringForProviders, isMimeSupportedByProviders } from '@/lib/document/mime';
import {
  MAX_DOCUMENT_BUNDLE_FILES,
  MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES,
} from '@/lib/document/bundle';
import { dedupeCourseMaterialFiles } from '@/lib/document/course-materials';
import type { CourseMaterialUpload } from '@/lib/types/generation';
import { GameLoader } from '@/components/livecourse/GameLoader';

// ─── Constants ───────────────────────────────────────────────
const MAX_COURSE_MATERIAL_SIZE_MB = 50;
const MAX_COURSE_MATERIAL_SIZE_BYTES = MAX_COURSE_MATERIAL_SIZE_MB * 1024 * 1024;

// ─── Types ───────────────────────────────────────────────────
export interface GenerationToolbarProps {
  courseMaterials: CourseMaterialUpload[];
  onCourseMaterialsAdd: (files: File[]) => void;
  onCourseMaterialRemove: (id: string) => void;
  onCourseMaterialRetry: (id: string) => void;
  disabled?: boolean;
  onPdfError: (error: string | null) => void;
}

// ─── Component ───────────────────────────────────────────────
export function GenerationToolbar({
  courseMaterials,
  onCourseMaterialsAdd,
  onCourseMaterialRemove,
  onCourseMaterialRetry,
  disabled = false,
  onPdfError,
}: GenerationToolbarProps) {
  const { t } = useI18n();
  const pdfProviderId = useSettingsStore((s) => s.pdfProviderId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Course material handler. `plain-text` is always active alongside the
  // user-selected extractor so txt/md files remain uploadable without
  // configuring an external service.
  const activeDocumentProviderIds = useMemo(
    () => [pdfProviderId, 'plain-text'] as const,
    [pdfProviderId],
  );
  const acceptForCurrentProvider = useMemo(
    () => getAcceptStringForProviders(activeDocumentProviderIds),
    [activeDocumentProviderIds],
  );

  // If the user switches to a provider that doesn't support already attached
  // materials, drop only the incompatible files so the eventual extraction
  // request matches the current provider capability.
  useEffect(() => {
    if (disabled) return;
    const unsupportedMaterials = courseMaterials.filter(
      (file) =>
        !isMimeSupportedByProviders(
          { mimeType: file.type, fileName: file.name },
          activeDocumentProviderIds,
        ),
    );
    if (unsupportedMaterials.length === 0) return;

    for (const file of unsupportedMaterials) {
      // A failed deletion remains available for the learner's explicit retry.
      if (file.removing || file.removalError) continue;
      onCourseMaterialRemove(file.id);
    }
    onPdfError(t('upload.unsupportedCourseMaterial'));
    // Intentionally omit callbacks/t from deps: adding them would re-run this
    // provider capability cleanup on unrelated parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocumentProviderIds, courseMaterials, disabled]);

  const handleFilesSelect = (incomingFiles: File[]) => {
    if (disabled) return;
    const supportedFiles = incomingFiles.filter((file) =>
      isMimeSupportedByProviders(
        { mimeType: file.type, fileName: file.name },
        activeDocumentProviderIds,
      ),
    );
    if (supportedFiles.length === 0) {
      onPdfError(t('upload.unsupportedCourseMaterial'));
      return;
    }
    if (supportedFiles.length !== incomingFiles.length) {
      onPdfError(t('upload.unsupportedCourseMaterial'));
      return;
    }
    if (supportedFiles.some((file) => file.size > MAX_COURSE_MATERIAL_SIZE_BYTES)) {
      onPdfError(t('upload.fileTooLarge'));
      return;
    }

    const dedupedFiles = dedupeCourseMaterialFiles(courseMaterials, supportedFiles);
    if (dedupedFiles.length === 0) return;

    if (courseMaterials.length + dedupedFiles.length > MAX_DOCUMENT_BUNDLE_FILES) {
      onPdfError(t('upload.courseMaterialCountLimit', { n: MAX_DOCUMENT_BUNDLE_FILES }));
      return;
    }

    const totalSize =
      courseMaterials.reduce((sum, file) => sum + file.size, 0) +
      dedupedFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES) {
      onPdfError(
        t('upload.courseMaterialTotalSizeLimit', {
          n: Math.floor(MAX_DOCUMENT_BUNDLE_TOTAL_SIZE_BYTES / 1024 / 1024),
        }),
      );
      return;
    }

    onPdfError(null);
    onCourseMaterialsAdd(dedupedFiles);
  };

  const pillCls =
    'inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const pillMuted = `${pillCls} text-muted-foreground hover:bg-muted hover:text-foreground`;
  const pillActive = `${pillCls} bg-accent text-accent-foreground hover:bg-accent/80`;

  return (
    <div data-testid="home-prompt-toolbar" className="flex flex-wrap items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={courseMaterials.length > 0 ? pillActive : pillMuted}
            aria-label={t('toolbar.courseMaterialUpload')}
            disabled={disabled}
          >
            <Paperclip className="size-4 shrink-0" aria-hidden="true" />
            {courseMaterials.length > 0 ? (
              <span className="max-w-[100px] truncate sm:max-w-[160px]">
                {courseMaterials.length === 1
                  ? courseMaterials[0].name
                  : t('toolbar.courseMaterialsSelected', { n: courseMaterials.length })}
              </span>
            ) : (
              <span className="text-start">{t('toolbar.courseMaterialUpload')}</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-3">
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept={acceptForCurrentProvider}
            multiple
            disabled={disabled}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) handleFilesSelect(files);
              event.target.value = '';
            }}
          />
          <div className="space-y-3">
            <button
              type="button"
              disabled={disabled}
              className={cn(
                'flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed p-4 transition-colors',
                isDragging ? 'border-primary bg-accent' : 'border-border hover:border-primary/60',
              )}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                const files = Array.from(event.dataTransfer.files ?? []);
                if (files.length > 0) handleFilesSelect(files);
              }}
            >
              <Paperclip className="mb-1.5 size-5 text-muted-foreground/50" />
              <span className="text-xs font-medium">{t('toolbar.courseMaterialUpload')}</span>
              <span className="mt-0.5 text-center text-[10px] text-muted-foreground/60">
                {t('upload.courseMaterialSizeLimit')}
              </span>
            </button>

            {courseMaterials.length > 0 && (
              <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                {[...courseMaterials]
                  .sort((a, b) => a.order - b.order)
                  .map((file) => (
                    <div
                      key={file.id}
                      data-upload-status={file.status}
                      aria-busy={file.status === 'uploading' || file.removing}
                      className="flex items-start gap-2 rounded-lg border border-border/50 px-2 py-2"
                    >
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent">
                        <FileText className="size-4 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" title={file.name}>
                          {file.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                        <p
                          role="status"
                          className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"
                        >
                          {file.removing || file.status === 'uploading' ? (
                            <GameLoader size="sm" />
                          ) : file.status === 'completed' ? (
                            <CheckCircle2 className="size-3 shrink-0 text-emerald-600" />
                          ) : (
                            <AlertCircle className="size-3 shrink-0 text-destructive" />
                          )}
                          {file.removing
                            ? t('upload.materialRemoving')
                            : file.status === 'uploading'
                              ? t('upload.materialUploading')
                              : file.status === 'completed'
                                ? t('upload.materialCompleted')
                                : t('upload.materialFailed')}
                        </p>
                        {(file.status === 'failed' || file.removalError) && (
                          <p role="alert" className="mt-1 break-words text-xs text-destructive">
                            {file.removalError ?? (file.status === 'failed' ? file.error : '')}
                          </p>
                        )}
                        {file.status === 'failed' && !file.removing && (
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => onCourseMaterialRetry(file.id)}
                            className="mt-1 inline-flex min-h-8 items-center gap-1 text-xs font-medium text-primary disabled:opacity-50"
                          >
                            <RotateCcw className="size-3" />
                            {t('upload.retryMaterial')}
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={disabled || file.removing}
                        onClick={() => onCourseMaterialRemove(file.id)}
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
                        aria-label={t('toolbar.removeCourseMaterial')}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {courseMaterials.some(
        (file) => file.status !== 'completed' || file.removing || file.removalError,
      ) && (
        <p role="status" className="w-full text-xs text-muted-foreground">
          {t('upload.materialsNotReady')}
        </p>
      )}
    </div>
  );
}

function formatThinkingValue(value?: string, t?: (key: string) => string) {
  if (!value) return '';
  if (value === 'none') return t ? t('toolbar.off') : 'off';
  if (t && (value === 'dynamic' || value === 'on' || value === 'off' || value === 'auto')) {
    return t(`toolbar.${value}`);
  }
  return value === 'xhigh' ? 'x-high' : value;
}

export function ModelThinkingControl({
  model,
  config,
  onChange,
  t,
}: {
  model?: ModelInfo;
  config?: ThinkingConfig;
  onChange: (config: ThinkingConfig | undefined) => void;
  t: (key: string) => string;
}) {
  const thinking = model?.capabilities?.thinking;
  if (!supportsConfigurableThinking(thinking)) return null;

  const effective = normalizeThinkingConfig(thinking, config) ?? getDefaultThinkingConfig(thinking);
  const applyConfig = (next: ThinkingConfig) => {
    onChange(normalizeThinkingConfig(thinking, next));
  };

  const applyBudget = (value: number | undefined) => {
    applyConfig({ ...effective, mode: effective?.mode ?? 'enabled', budgetTokens: value });
  };
  const defaultEnabledBudget =
    typeof thinking.defaultBudgetTokens === 'number' && thinking.defaultBudgetTokens > 0
      ? thinking.defaultBudgetTokens
      : (thinking.budgetRange?.step ?? thinking.budgetRange?.min);
  const applyAutoBudget = () => {
    applyConfig({ ...effective, mode: 'auto', enabled: undefined, budgetTokens: -1 });
  };
  const applyBudgetMode = (mode: 'disabled' | 'enabled' | 'auto') => {
    if (mode === 'auto') {
      applyAutoBudget();
      return;
    }

    applyConfig({
      ...effective,
      mode,
      enabled: mode === 'enabled',
      budgetTokens:
        mode === 'enabled' && effective?.budgetTokens === -1
          ? defaultEnabledBudget
          : effective?.budgetTokens,
    });
  };
  const applySimpleMode = (mode: 'disabled' | 'enabled' | 'auto') => {
    applyConfig({
      ...effective,
      mode,
      enabled: mode === 'enabled' ? true : mode === 'disabled' ? false : undefined,
    });
  };

  const selectTriggerCls =
    'h-6 min-w-[84px] rounded-full border-0 bg-violet-100 px-2 py-0 !text-[10px] font-medium leading-none text-violet-700 shadow-none focus-visible:ring-0 data-[size=sm]:h-6 dark:bg-violet-900/40 dark:text-violet-200 [&_svg]:size-3';
  const selectItemCls = 'py-1 text-xs';
  const hasAutoBudget =
    (thinking.control === 'toggle-budget' || thinking.control === 'budget-only') &&
    !!thinking.budgetRange?.allowDynamic;
  const autoBudgetMode =
    effective?.budgetTokens === -1 && thinking.budgetRange?.allowDynamic
      ? 'auto'
      : effective?.mode === 'disabled'
        ? 'disabled'
        : 'enabled';
  const simpleMode =
    thinking.control === 'mode' && effective?.mode === 'auto'
      ? 'auto'
      : effective?.mode === 'disabled'
        ? 'disabled'
        : 'enabled';

  return (
    <div
      className="flex min-w-0 shrink-0 items-center gap-1"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Brain className="size-3.5 shrink-0 text-violet-500" />
      <div className="flex min-w-0 items-center gap-0.5 rounded-full border border-violet-200/70 bg-white/65 p-0.5 dark:border-violet-800/70 dark:bg-violet-950/25">
        {hasAutoBudget && (
          <Select
            value={autoBudgetMode}
            onValueChange={(mode) => applyBudgetMode(mode as 'disabled' | 'enabled' | 'auto')}
          >
            <SelectTrigger
              size="sm"
              className="h-6 min-w-[76px] rounded-full border-0 bg-violet-100 px-2 py-0 !text-[10px] font-medium leading-none text-violet-700 shadow-none focus-visible:ring-0 data-[size=sm]:h-6 dark:bg-violet-900/40 dark:text-violet-200 [&_svg]:size-3"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[96px]">
              {thinking.control === 'toggle-budget' && (
                <SelectItem value="disabled" className={selectItemCls}>
                  {t('toolbar.off')}
                </SelectItem>
              )}
              <SelectItem value="enabled" className={selectItemCls}>
                {t('toolbar.on')}
              </SelectItem>
              <SelectItem value="auto" className={selectItemCls}>
                {t('toolbar.auto')}
              </SelectItem>
            </SelectContent>
          </Select>
        )}

        {(thinking.control === 'toggle' ||
          (thinking.control === 'toggle-budget' && !hasAutoBudget) ||
          thinking.control === 'mode') && (
          <Select
            value={simpleMode}
            onValueChange={(mode) => applySimpleMode(mode as 'disabled' | 'enabled' | 'auto')}
          >
            <SelectTrigger
              size="sm"
              className="h-6 min-w-[76px] rounded-full border-0 bg-violet-100 px-2 py-0 !text-[10px] font-medium leading-none text-violet-700 shadow-none focus-visible:ring-0 data-[size=sm]:h-6 dark:bg-violet-900/40 dark:text-violet-200 [&_svg]:size-3"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[96px]">
              {thinking.control === 'mode' && (
                <SelectItem value="auto" className={selectItemCls}>
                  {t('toolbar.auto')}
                </SelectItem>
              )}
              <SelectItem value="disabled" className={selectItemCls}>
                {t('toolbar.off')}
              </SelectItem>
              <SelectItem value="enabled" className={selectItemCls}>
                {t('toolbar.on')}
              </SelectItem>
            </SelectContent>
          </Select>
        )}

        {thinking.control === 'level' && !!thinking.levelValues?.length && (
          <Select
            value={effective?.level ?? thinking.defaultLevel ?? thinking.levelValues[0]}
            onValueChange={(level) =>
              applyConfig({ ...effective, mode: 'enabled', level: level as ThinkingLevel })
            }
          >
            <SelectTrigger size="sm" className={selectTriggerCls}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[96px]">
              {thinking.levelValues.map((level: ThinkingLevel) => (
                <SelectItem key={level} value={level} className={selectItemCls}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {thinking.control === 'effort' && !!thinking.effortValues?.length && (
          <Select
            value={effective?.effort ?? thinking.defaultEffort ?? thinking.effortValues[0]}
            onValueChange={(effort) =>
              applyConfig({
                ...effective,
                mode: effort === 'none' ? 'disabled' : 'enabled',
                effort: effort as ThinkingEffort,
              })
            }
          >
            <SelectTrigger size="sm" className={selectTriggerCls}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="min-w-[104px]">
              {thinking.effortValues.map((effort: ThinkingEffort) => (
                <SelectItem key={effort} value={effort} className={selectItemCls}>
                  {formatThinkingValue(effort, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {(thinking.control === 'toggle-budget' || thinking.control === 'budget-only') &&
          thinking.budgetRange &&
          (!hasAutoBudget || autoBudgetMode === 'enabled') && (
            <label className="ml-0.5 grid h-6 shrink-0 grid-cols-[auto_60px] items-stretch overflow-hidden rounded-full border border-violet-200/70 bg-background dark:border-violet-800/70">
              <span className="grid h-[22px] shrink-0 place-items-center border-r border-violet-200/70 bg-muted/30 px-2 font-sans text-[11px] font-medium leading-[22px] text-muted-foreground dark:border-violet-800/70">
                {t('toolbar.thinkingBudget')}
              </span>
              <input
                type="text"
                inputMode="numeric"
                aria-label={t('toolbar.thinkingBudget')}
                disabled={effective?.mode === 'disabled'}
                value={
                  typeof effective?.budgetTokens === 'number' && effective.budgetTokens !== -1
                    ? effective.budgetTokens
                    : ''
                }
                placeholder={`${thinking.budgetRange.min}-${thinking.budgetRange.max}`}
                title={`${thinking.budgetRange.min}-${thinking.budgetRange.max} tokens`}
                onChange={(event) => {
                  const rawValue = event.target.value.trim();
                  if (!/^\d*$/.test(rawValue)) return;
                  const value = rawValue ? Number(rawValue) : undefined;
                  applyBudget(value);
                }}
                className="block h-[22px] w-[60px] border-0 bg-transparent px-1 py-0 text-center font-sans text-[11px] font-medium leading-[22px] tabular-nums outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              />
            </label>
          )}
      </div>
    </div>
  );
}
