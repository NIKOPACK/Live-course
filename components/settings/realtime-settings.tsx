'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/lib/hooks/use-i18n';
import { REALTIME_PROVIDERS } from '@/lib/livecourse/realtime/providers';
import type { RealtimeProviderId } from '@/lib/types/settings';
import { cn } from '@/lib/utils';

import type {
  CredentialField,
  FieldSaveStatus,
  ProviderCredentials,
} from './use-provider-credentials';

interface RealtimeSettingsProps {
  selectedProviderId: RealtimeProviderId;
  credentials: ProviderCredentials;
  saving: boolean;
  isServerConfigured: boolean;
  fieldStatus: (field: CredentialField) => FieldSaveStatus;
  dirty: (field: CredentialField) => boolean;
  onConfigChange: <K extends CredentialField>(field: K, value: ProviderCredentials[K]) => void;
  onSave: (field: CredentialField) => void;
}

export function RealtimeSettings({
  selectedProviderId,
  credentials,
  saving,
  isServerConfigured,
  fieldStatus,
  dirty,
  onConfigChange,
  onSave,
}: RealtimeSettingsProps) {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);
  const [prevProviderId, setPrevProviderId] = useState(selectedProviderId);
  if (selectedProviderId !== prevProviderId) {
    setPrevProviderId(selectedProviderId);
    setShowApiKey(false);
  }

  const provider = REALTIME_PROVIDERS[selectedProviderId];
  const hintKey =
    selectedProviderId === 'openai' ? 'settings.realtime.openaiHint' : 'settings.realtime.volcHint';

  const fieldFeedback = (field: CredentialField) => (
    <div
      id={`realtime-credential-status-${selectedProviderId}-${field}`}
      className={cn(
        'flex min-h-5 items-center gap-2 text-xs',
        fieldStatus(field) === 'idle' && !dirty(field) && 'hidden',
      )}
    >
      <span
        role={fieldStatus(field) === 'error' ? 'alert' : 'status'}
        className={fieldStatus(field) === 'error' ? 'text-destructive' : 'text-muted-foreground'}
      >
        {fieldStatus(field) === 'saving' && t('settings.saving')}
        {fieldStatus(field) === 'saved' && t('settings.saveSuccess')}
        {fieldStatus(field) === 'error' && t('settings.saveFailed')}
        {fieldStatus(field) === 'idle' && dirty(field) && t('settings.unsavedChanges')}
      </span>
      {dirty(field) && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          disabled={saving}
          onClick={() => onSave(field)}
        >
          {fieldStatus(field) === 'error' ? t('home.retryLoad') : t('settings.save')}
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-6 max-w-3xl">
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
          {t('settings.realtime.serverConfiguredNotice')}
        </div>
      )}

      {!isServerConfigured && (
        <div className="space-y-2">
          <Label htmlFor={`realtime-api-key-${provider.id}`} className="text-sm">
            {t('settings.realtime.apiKey')}
          </Label>
          <div className="relative">
            <Input
              id={`realtime-api-key-${provider.id}`}
              data-testid="realtime-api-key"
              name={`realtime-api-key-${provider.id}`}
              type={showApiKey ? 'text' : 'password'}
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t('settings.enterApiKey')}
              value={credentials.apiKey}
              onChange={(event) => onConfigChange('apiKey', event.target.value)}
              className="pr-10 font-mono text-sm"
            />
            <button
              type="button"
              onClick={() => setShowApiKey((current) => !current)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showApiKey ? t('settings.hideSecret') : t('settings.showSecret')}
            >
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {fieldFeedback('apiKey')}
          <p className="text-xs text-muted-foreground">{t(hintKey)}</p>
        </div>
      )}
    </div>
  );
}
