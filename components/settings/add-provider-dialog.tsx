'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Box, Plus } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { MONO_LOGO_PROVIDERS, type ProviderId } from '@/lib/ai/providers';

export interface NewProviderData {
  name: string;
  type: 'openai' | 'anthropic' | 'google';
  baseUrl: string;
  icon: string;
  requiresApiKey: boolean;
  /** Optional explicit /models URL override (kept for parity; unused by manual form). */
  modelsUrl?: string;
}

interface CatalogProviderEntry {
  id: ProviderId;
  name: string;
  icon?: string;
}

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (provider: NewProviderData) => void;
  /** Built-in providers currently hidden from the list; picking one reveals it. */
  catalogProviders?: CatalogProviderEntry[];
  onSelectBuiltin?: (providerId: ProviderId) => void;
}

export function AddProviderDialog({
  open,
  onOpenChange,
  onAdd,
  catalogProviders = [],
  onSelectBuiltin,
}: AddProviderDialogProps) {
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [type, setType] = useState<'openai' | 'anthropic' | 'google'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [icon, setIcon] = useState('');
  const [requiresApiKey, setRequiresApiKey] = useState(true);

  // Reset form when dialog closes (derived state pattern)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setName('');
      setType('openai');
      setBaseUrl('');
      setIcon('');
      setRequiresApiKey(true);
    }
  }

  const handleClose = () => onOpenChange(false);
  const handleAdd = () => onAdd({ name, type, baseUrl, icon, requiresApiKey });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogTitle className="sr-only">{t('settings.addProviderDialog')}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('settings.addProviderDescription')}
        </DialogDescription>
        <div className="space-y-4">
          <div className="pb-3 border-b">
            <h2 className="text-lg font-semibold">{t('settings.addProviderDialog')}</h2>
          </div>

          {/* Built-in catalog: hidden providers the user can bring back */}
          {catalogProviders.length > 0 && (
            <div className="space-y-2">
              <Label>{t('settings.providerCatalog')}</Label>
              <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-0.5">
                {catalogProviders.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => onSelectBuiltin?.(provider.id)}
                    className="flex items-center gap-2 rounded-lg border border-transparent p-2 text-left text-sm transition-colors hover:bg-muted/50 hover:border-border"
                  >
                    {provider.icon ? (
                      <img
                        src={provider.icon}
                        alt=""
                        className={cn(
                          'h-4 w-4 shrink-0 rounded',
                          MONO_LOGO_PROVIDERS.has(provider.id) && 'dark:invert',
                        )}
                        onError={(event) => {
                          (event.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <Box className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{provider.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Custom provider form */}
          {catalogProviders.length > 0 && (
            <div className="flex items-center gap-3 pt-1">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">{t('settings.customProvider')}</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}

          {/* Provider Name */}
          <div className="space-y-2">
            <Label>{t('settings.providerName')}</Label>
            <Input
              placeholder={t('settings.providerNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* API Mode */}
          <div className="space-y-2">
            <Label>{t('settings.providerApiMode')}</Label>
            <div className="grid grid-cols-3 gap-2">
              {(['openai', 'anthropic', 'google'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setType(mode)}
                  className={cn(
                    'p-2 rounded-lg border text-left text-sm transition-colors',
                    type === mode
                      ? 'bg-primary/5 border-primary/50'
                      : 'hover:bg-muted/50 border-transparent',
                  )}
                >
                  {t(
                    mode === 'openai'
                      ? 'settings.apiModeOpenAI'
                      : mode === 'anthropic'
                        ? 'settings.apiModeAnthropic'
                        : 'settings.apiModeGoogle',
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Default Base URL */}
          <div className="space-y-2">
            <Label>{t('settings.defaultBaseUrl')}</Label>
            <Input
              type="url"
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>

          {/* Icon URL */}
          <div className="space-y-2">
            <Label>{t('settings.providerIcon')}</Label>
            <Input
              type="url"
              placeholder="https://example.com/icon.svg"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
            />
          </div>

          {/* Requires API Key */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="requires-api-key"
              checked={requiresApiKey}
              onCheckedChange={(checked) => setRequiresApiKey(checked as boolean)}
            />
            <label htmlFor="requires-api-key" className="text-sm cursor-pointer">
              {t('settings.requiresApiKey')}
            </label>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t">
            <Button variant="outline" size="sm" onClick={handleClose}>
              {t('settings.cancelEdit')}
            </Button>
            <Button size="sm" onClick={handleAdd} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              {t('settings.addProviderButton')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
