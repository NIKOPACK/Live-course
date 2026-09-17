'use client';

import { useEffect, useMemo, useState } from 'react';
import { Box, FileText, Send, Sparkles, Wrench, Zap } from 'lucide-react';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  useComboboxAnchor,
} from '@/components/ui/combobox';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { modelIdsMatch } from '@/lib/ai/model-aliases';
import { MONO_LOGO_PROVIDERS } from '@/lib/ai/providers';
import type { ModelInfo, ProviderId } from '@/lib/ai/providers';
import type { ProvidersConfig } from '@/lib/types/settings';
import { cn } from '@/lib/utils';
import { formatContextWindow } from './utils';

interface ModelPickerOption {
  providerId: ProviderId;
  providerName: string;
  providerIcon?: string;
  model: ModelInfo;
}

interface ModelPickerGroup {
  value: ProviderId;
  label: string;
  icon?: string;
  items: ModelPickerOption[];
}

interface ModelPickerProps {
  providersConfig: ProvidersConfig;
  /** After a cross-provider selection the parent reveals that provider's panel. */
  onNavigateProvider?: (providerId: ProviderId) => void;
  /**
   * Restrict pickable models to these providers (the visible/in-use list).
   * Hidden built-ins keep their catalog data but stay out of the picker.
   * Defaults to every provider in providersConfig.
   */
  providerIds?: readonly ProviderId[];
}

/**
 * Cross-provider active-model picker (spec: docs/spec/02-product-manual.md「设置」—
 * model choice is plain config storage; per-field save semantics stay untouched).
 * Groups every configured provider's models into one searchable list so switching
 * providers no longer requires locating the provider in the middle column first.
 */
export function ModelPicker({
  providersConfig,
  onNavigateProvider,
  providerIds,
}: ModelPickerProps) {
  const { t } = useI18n();
  const anchor = useComboboxAnchor();

  // Inside a modal dialog, react-remove-scroll blocks wheel scrolling for
  // body-portaled popups; rendering into the dialog content keeps both pointer
  // and wheel interactions working. Falls back to the body portal otherwise.
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalContainer(
      (anchor.current?.closest('[data-slot="dialog-content"]') as HTMLElement | null) ?? null,
    );
  }, [anchor]);

  const activeProviderId = useSettingsStore((state) => state.providerId);
  const activeModelId = useSettingsStore((state) => state.modelId);
  const setModel = useSettingsStore((state) => state.setModel);

  const providerDisplayName = (providerId: ProviderId, fallback: string) => {
    const key = `settings.providerNames.${providerId}`;
    const translated = t(key);
    return translated !== key ? translated : fallback;
  };

  const groups = useMemo<ModelPickerGroup[]>(
    () =>
      (providerIds ?? (Object.keys(providersConfig) as ProviderId[]))
        .map((id) => [id, providersConfig[id]] as const)
        .filter((entry): entry is readonly [ProviderId, ProvidersConfig[ProviderId]] =>
          Boolean(entry[1]),
        )
        .map(([id, config]) => ({
          value: id,
          label: providerDisplayName(id, config.name),
          icon: config.icon,
          items: (config.models ?? []).map((model) => ({
            providerId: id,
            providerName: providerDisplayName(id, config.name),
            providerIcon: config.icon,
            model,
          })),
        }))
        .filter((group) => group.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- providerDisplayName is stable per locale
    [providersConfig, providerIds, t],
  );

  const currentValue = useMemo<ModelPickerOption | null>(() => {
    for (const group of groups) {
      const hit = group.items.find((option) =>
        modelIdsMatch(option.providerId, option.model.id, activeModelId),
      );
      if (group.value === activeProviderId && hit) return hit;
    }
    return null;
  }, [groups, activeProviderId, activeModelId]);

  const totalModels = groups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <Combobox<ModelPickerOption>
      items={groups}
      value={currentValue}
      disabled={totalModels === 0}
      autoHighlight
      itemToStringLabel={(option) => option.model.name}
      itemToStringValue={(option) => option.model.id}
      isItemEqualToValue={(option, value) =>
        option.providerId === value.providerId &&
        modelIdsMatch(option.providerId, option.model.id, value.model.id)
      }
      filter={(option, query) => {
        const q = query.trim().toLowerCase();
        if (!q) return true;
        return (
          option.model.name.toLowerCase().includes(q) ||
          option.model.id.toLowerCase().includes(q) ||
          option.providerName.toLowerCase().includes(q)
        );
      }}
      onValueChange={(option) => {
        if (!option) return;
        setModel(option.providerId, option.model.id);
        if (option.providerId !== activeProviderId) {
          onNavigateProvider?.(option.providerId);
        }
      }}
    >
      <div ref={anchor} className="w-full">
        <ComboboxInput
          className="w-full"
          placeholder={totalModels === 0 ? t('settings.noModelsAdded') : t('settings.searchModels')}
          aria-label={t('settings.activeModel')}
        />
      </div>
      <ComboboxContent anchor={anchor} container={portalContainer ?? undefined}>
        <ComboboxEmpty>{t('settings.noModelsFound')}</ComboboxEmpty>
        <ComboboxList>
          {(group: ModelPickerGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel className="flex items-center gap-1.5">
                {group.icon ? (
                  <img
                    src={group.icon}
                    alt=""
                    className={cn(
                      'h-3.5 w-3.5 rounded',
                      MONO_LOGO_PROVIDERS.has(group.value) && 'dark:invert',
                    )}
                    onError={(event) => {
                      (event.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <Box className="h-3.5 w-3.5" />
                )}
                <span className="truncate">{group.label}</span>
                <span className="ml-auto tabular-nums">{group.items.length}</span>
              </ComboboxLabel>
              <ComboboxCollection>
                {(option: ModelPickerOption) => (
                  <ComboboxItem key={option.model.id} value={option}>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {option.model.name}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
                      {option.model.capabilities?.vision && (
                        <span title={t('settings.capabilities.vision')}>
                          <Sparkles className="h-3 w-3" />
                        </span>
                      )}
                      {option.model.capabilities?.tools && (
                        <span title={t('settings.capabilities.tools')}>
                          <Wrench className="h-3 w-3" />
                        </span>
                      )}
                      {option.model.capabilities?.streaming && (
                        <span title={t('settings.capabilities.streaming')}>
                          <Zap className="h-3 w-3" />
                        </span>
                      )}
                      {option.model.contextWindow && (
                        <span
                          className="flex items-center gap-0.5"
                          title={t('settings.contextWindow')}
                        >
                          <FileText className="h-3 w-3" />
                          <span className="text-[10px] tabular-nums">
                            {formatContextWindow(option.model.contextWindow)}
                          </span>
                        </span>
                      )}
                      {option.model.outputWindow && (
                        <span
                          className="flex items-center gap-0.5"
                          title={t('settings.outputWindow')}
                        >
                          <Send className="h-3 w-3" />
                          <span className="text-[10px] tabular-nums">
                            {formatContextWindow(option.model.outputWindow)}
                          </span>
                        </span>
                      )}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
