'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Loader2,
  Check,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  RotateCcw,
  Plus,
  Zap,
  Settings2,
  Trash2,
  Sparkles,
  Wrench,
  FileText,
  Send,
  Download,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ModelPicker } from './model-picker';
import { useSettingsStore } from '@/lib/store/settings';
import type { ProviderConfig, ProviderId } from '@/lib/ai/providers';
import type { ProvidersConfig } from '@/lib/types/settings';
import { createVerifyModelRequest, formatContextWindow } from './utils';
import { cn } from '@/lib/utils';
import { modelIdsMatch } from '@/lib/ai/model-aliases';
import { getThinkingConfigKey, supportsConfigurableThinking } from '@/lib/ai/thinking-config';
import { ModelThinkingControl } from '@/components/generation/generation-toolbar';
import type {
  ProviderCredentials,
  CredentialField,
  FieldSaveStatus,
} from './use-provider-credentials';

interface ProviderConfigPanelProps {
  provider: ProviderConfig;
  credentials: ProviderCredentials;
  saving: boolean;
  fieldStatus: (field: CredentialField) => FieldSaveStatus;
  dirty: (field: CredentialField) => boolean;
  providersConfig: ProvidersConfig;
  onConfigChange: <K extends CredentialField>(field: K, value: ProviderCredentials[K]) => void;
  onSave: (field: CredentialField) => void;
  onEditModel: (index: number) => void;
  onDeleteModel: (index: number) => void;
  onAddModel: () => void;
  /** Merge probed model ids into the provider's list; returns the count added. */
  onModelsFetched?: (ids: string[]) => number;
  /** Optional explicit /models URL override (from a preset). */
  modelsUrl?: string;
  onResetToDefault?: () => void; // Reset provider to default configuration
  isBuiltIn: boolean; // To determine if reset button should be shown
  /** After picking another provider's model, the parent reveals that provider. */
  onNavigateProvider?: (providerId: ProviderId) => void;
  /** Restrict the active-model picker to these (visible/in-use) providers. */
  visibleProviderIds?: readonly ProviderId[];
}

export function ProviderConfigPanel({
  provider,
  credentials,
  saving,
  fieldStatus,
  dirty,
  providersConfig,
  onConfigChange,
  onSave,
  onEditModel,
  onDeleteModel,
  onAddModel,
  onModelsFetched,
  modelsUrl,
  onResetToDefault,
  isBuiltIn,
  onNavigateProvider,
  visibleProviderIds,
}: ProviderConfigPanelProps) {
  const { t } = useI18n();
  const activeProviderId = useSettingsStore((state) => state.providerId);
  const activeModelId = useSettingsStore((state) => state.modelId);
  const setModel = useSettingsStore((state) => state.setModel);
  const thinkingConfigs = useSettingsStore((state) => state.thinkingConfigs);
  const setThinkingConfig = useSettingsStore((state) => state.setThinkingConfig);

  const { apiKey, baseUrl, requiresApiKey } = credentials;
  const [showApiKey, setShowApiKey] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'fetching' | 'success' | 'error'>('idle');
  const [fetchMessage, setFetchMessage] = useState('');

  // Connection/probe results belong to the selected provider, not to another draft.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset transient feedback on provider selection.
    setTestStatus('idle');
    setTestMessage('');
    setFetchStatus('idle');
    setFetchMessage('');
    setShowApiKey(false);
  }, [provider.id]);

  const handleApiKeyChange = (value: string) => onConfigChange('apiKey', value);
  const handleBaseUrlChange = (value: string) => onConfigChange('baseUrl', value);
  const handleRequiresApiKeyChange = (value: boolean) => onConfigChange('requiresApiKey', value);

  const fieldFeedback = (field: CredentialField) => (
    <div
      id={`credential-status-${provider.id}-${field}`}
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
          {fieldStatus(field) === 'error' ? t('common.retry') : t('settings.save')}
        </Button>
      )}
    </div>
  );

  const handleTestApi = useCallback(async () => {
    setTestStatus('testing');
    setTestMessage('');

    const availableModels = providersConfig[provider.id]?.models || [];

    if (availableModels.length === 0) {
      setTestStatus('error');
      setTestMessage(t('settings.noModelsAvailable') || 'No models available for testing');
      return;
    }

    const testModelId = availableModels[0].id;

    try {
      const response = await fetch('/api/verify-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          createVerifyModelRequest({
            providerId: provider.id,
            modelId: testModelId,
            apiKey,
            baseUrl,
            providerType: provider.type,
            requiresApiKey,
          }),
        ),
      });

      const data = await response.json();

      if (data.success) {
        setTestStatus('success');
        setTestMessage(t('settings.connectionSuccess'));
      } else {
        setTestStatus('error');
        setTestMessage(data.error || t('settings.connectionFailed'));
      }
    } catch (_error) {
      setTestStatus('error');
      setTestMessage(t('settings.connectionFailed'));
    }
  }, [apiKey, baseUrl, provider.id, provider.type, requiresApiKey, providersConfig, t]);

  const effectiveBaseUrl = baseUrl || provider.defaultBaseUrl || '';

  // Probe the provider's /models endpoint and merge results into the model list.
  const handleFetchModels = useCallback(async () => {
    setFetchStatus('fetching');
    setFetchMessage('');
    try {
      const response = await fetch('/api/provider/probe-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: effectiveBaseUrl,
          apiKey,
          modelsUrl,
          providerId: provider.id,
        }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        const ids: string[] = (data.models || []).map((m: { id: string }) => m.id);
        const added = onModelsFetched?.(ids) ?? 0;
        setFetchStatus('success');
        setFetchMessage(
          t('settings.fetchModelsResult')
            .replace('{added}', String(added))
            .replace('{total}', String(ids.length)),
        );
      } else if (response.status === 404) {
        setFetchStatus('error');
        setFetchMessage(t('settings.fetchModelsNoEndpoint'));
      } else if (response.status === 401) {
        setFetchStatus('error');
        setFetchMessage(t('settings.fetchModelsAuthError'));
      } else {
        setFetchStatus('error');
        setFetchMessage(data.error || t('settings.fetchModelsFailed'));
      }
    } catch {
      setFetchStatus('error');
      setFetchMessage(t('settings.fetchModelsFailed'));
    }
  }, [apiKey, effectiveBaseUrl, modelsUrl, onModelsFetched, provider.id, t]);

  const models = providersConfig[provider.id]?.models || [];
  const activeModel =
    activeProviderId === provider.id
      ? models.find((model) => modelIdsMatch(provider.id, model.id, activeModelId))
      : undefined;
  const activeThinkingConfig = activeModel
    ? thinkingConfigs[getThinkingConfigKey(provider.id, activeModel.id)]
    : undefined;
  const isServerConfigured = providersConfig[provider.id]?.isServerConfigured;
  // When the operator pins an allowed model list (MODELS env/yaml), the model
  // catalog is admin-managed too — view-only, no add/edit/delete. Without a
  // pinned list the server manages only credentials and the user curates models.
  const modelsLocked = !!providersConfig[provider.id]?.serverModels?.length;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="space-y-3 rounded-lg border border-border/60 bg-muted/15 p-4">
        <div>
          <Label className="text-base">{t('settings.activeModel')}</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('settings.activeModelDescription')}
          </p>
        </div>
        <ModelPicker
          providersConfig={providersConfig}
          onNavigateProvider={onNavigateProvider}
          providerIds={visibleProviderIds}
        />

        {activeModel && supportsConfigurableThinking(activeModel.capabilities?.thinking) && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
            <Label>{t('toolbar.thinking')}</Label>
            <ModelThinkingControl
              model={activeModel}
              config={activeThinkingConfig}
              onChange={(config) => setThinkingConfig(provider.id, activeModel.id, config)}
              t={t}
            />
          </div>
        )}
      </div>

      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* Managed providers are admin-owned: the operator's key and base URL are
          authoritative and not overridable here, so the editing inputs are hidden. */}
      {!isServerConfigured && (
        <>
          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor={`llm-api-key-${provider.id}`}>{t('settings.apiSecret')}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id={`llm-api-key-${provider.id}`}
                  name={`llm-api-key-${provider.id}`}
                  aria-describedby={`credential-status-${provider.id}-apiKey`}
                  aria-invalid={fieldStatus('apiKey') === 'error'}
                  type={showApiKey ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => handleApiKeyChange(e.target.value)}
                  disabled={saving || !requiresApiKey}
                  className="h-8 pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  aria-label={t(showApiKey ? 'settings.hideSecret' : 'settings.showSecret')}
                  aria-pressed={showApiKey}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  disabled={saving || !requiresApiKey}
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTestApi}
                disabled={testStatus === 'testing' || (requiresApiKey && !apiKey)}
                className="gap-1.5"
              >
                {testStatus === 'testing' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Zap className="h-3.5 w-3.5" />
                    {t('settings.testConnection')}
                  </>
                )}
              </Button>
            </div>
            {fieldFeedback('apiKey')}
            {testMessage && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm overflow-hidden',
                  testStatus === 'success' && 'bg-green-50 text-green-700 border border-green-200',
                  testStatus === 'error' && 'bg-red-50 text-red-700 border border-red-200',
                )}
              >
                <div className="flex items-start gap-2 min-w-0">
                  {testStatus === 'success' && <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />}
                  {testStatus === 'error' && <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
                  <p className="flex-1 min-w-0 break-all">{testMessage}</p>
                </div>
              </div>
            )}
            <div className="flex items-center space-x-2">
              <Checkbox
                id={`requires-api-key-${provider.id}`}
                checked={requiresApiKey}
                disabled={saving}
                aria-describedby={`credential-status-${provider.id}-requiresApiKey`}
                onCheckedChange={(checked) => {
                  handleRequiresApiKeyChange(checked as boolean);
                }}
              />
              <label
                htmlFor={`requires-api-key-${provider.id}`}
                className="text-sm cursor-pointer text-muted-foreground"
              >
                {t('settings.requiresApiKey')}
              </label>
            </div>
            {fieldFeedback('requiresApiKey')}
          </div>

          {/* API Host */}
          <div className="space-y-2">
            <Label htmlFor={`llm-base-url-${provider.id}`}>{t('settings.apiHost')}</Label>
            <Input
              id={`llm-base-url-${provider.id}`}
              name={`llm-base-url-${provider.id}`}
              disabled={saving}
              aria-describedby={`credential-status-${provider.id}-baseUrl`}
              aria-invalid={fieldStatus('baseUrl') === 'error'}
              type="url"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={
                provider.baseUrlPlaceholder ||
                provider.defaultBaseUrl ||
                'https://api.example.com/v1'
              }
              value={baseUrl}
              onChange={(e) => handleBaseUrlChange(e.target.value)}
              className="h-8"
            />
            {fieldFeedback('baseUrl')}
            {provider.alternateBaseUrls && provider.alternateBaseUrls.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {provider.alternateBaseUrls.map((alt) => {
                  const active = (baseUrl || provider.defaultBaseUrl) === alt.url;
                  return (
                    <button
                      key={alt.url}
                      disabled={saving}
                      type="button"
                      onClick={() => {
                        handleBaseUrlChange(alt.url);
                      }}
                      className={cn(
                        'px-2 py-0.5 text-xs rounded-md border transition-colors',
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-muted-foreground border-border hover:bg-muted',
                      )}
                    >
                      {t(alt.label)}
                    </button>
                  );
                })}
              </div>
            )}
            {(() => {
              const effectiveBaseUrl = baseUrl || provider.defaultBaseUrl || '';
              if (!effectiveBaseUrl) return null;

              // Generate endpoint path based on provider type
              let endpointPath = '';
              switch (provider.type) {
                case 'openai':
                  endpointPath = '/chat/completions';
                  break;
                case 'azure':
                  endpointPath = '/v1/responses?api-version=v1';
                  break;
                case 'anthropic':
                  endpointPath = '/messages';
                  break;
                case 'google':
                  endpointPath = '/models/[model]';
                  break;
                default:
                  endpointPath = '';
              }

              const fullUrl = effectiveBaseUrl + endpointPath;

              return (
                <p className="text-xs text-muted-foreground break-all">
                  {t('settings.requestUrl')}: {fullUrl}
                </p>
              );
            })()}
          </div>
        </>
      )}

      {/* Model catalog management */}
      <div className="space-y-3">
        {provider.id === 'azure' && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300">
            {t('settings.azureDeploymentHint')}
          </div>
        )}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Label className="text-base">{t('settings.models')}</Label>
            {modelsLocked && (
              <span className="text-[10px] px-1 py-0 h-4 leading-4 rounded bg-muted text-muted-foreground">
                {t('settings.serverConfigured')}
              </span>
            )}
          </div>
          {!modelsLocked && (
            <div className="flex items-center gap-2 flex-wrap">
              {isBuiltIn && onResetToDefault && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowResetDialog(true)}
                  className="gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('settings.reset')}
                </Button>
              )}
              {provider.supportsModelDiscovery !== false && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleFetchModels}
                  disabled={
                    fetchStatus === 'fetching' || (requiresApiKey && !apiKey && !isServerConfigured)
                  }
                  className="gap-1.5"
                >
                  {fetchStatus === 'fetching' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {t('settings.fetchModels')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={onAddModel} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                {t('settings.addNewModel')}
              </Button>
            </div>
          )}
        </div>

        {/* Fetch-models result message */}
        {fetchMessage && (
          <div
            className={cn(
              'rounded-lg p-2.5 text-xs',
              fetchStatus === 'success' && 'bg-green-50 text-green-700 border border-green-200',
              fetchStatus === 'error' && 'bg-amber-50 text-amber-700 border border-amber-200',
            )}
          >
            {fetchMessage}
          </div>
        )}

        <div className="space-y-1.5" role="radiogroup" aria-label={t('settings.activeModel')}>
          {models.map((model, index) => {
            const isActiveModel =
              activeProviderId === provider.id &&
              modelIdsMatch(provider.id, model.id, activeModelId);
            const selectThisModel = () => {
              if (!isActiveModel) setModel(provider.id, model.id);
            };
            return (
              <div
                key={model.id}
                role="radio"
                aria-checked={isActiveModel}
                tabIndex={0}
                title={isActiveModel ? t('settings.currentlyUsing') : undefined}
                onClick={selectThisModel}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectThisModel();
                  }
                }}
                className={cn(
                  'flex items-center justify-between rounded-lg border p-3 cursor-pointer transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActiveModel
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border/50 bg-card hover:border-primary/30 hover:bg-muted/40',
                )}
              >
                <div className="flex-1">
                  <div className="font-mono text-sm font-medium mb-1.5">{model.name}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {/* Capabilities */}
                    <div className="flex items-center gap-1">
                      {model.capabilities?.vision && (
                        <div title={t('settings.capabilities.vision')}>
                          <Sparkles className="h-3 w-3" />
                        </div>
                      )}
                      {model.capabilities?.tools && (
                        <div title={t('settings.capabilities.tools')}>
                          <Wrench className="h-3 w-3" />
                        </div>
                      )}
                      {model.capabilities?.streaming && (
                        <div title={t('settings.capabilities.streaming')}>
                          <Zap className="h-3 w-3" />
                        </div>
                      )}
                    </div>
                    {/* Context Window */}
                    {model.contextWindow && (
                      <span className="flex items-center gap-0.5">
                        <FileText className="h-3 w-3" />
                        <span className="text-[10px]">
                          {formatContextWindow(model.contextWindow)}
                        </span>
                      </span>
                    )}
                    {/* Output Window */}
                    {model.outputWindow && (
                      <span className="flex items-center gap-0.5">
                        <Send className="h-3 w-3" />
                        <span className="text-[10px]">
                          {formatContextWindow(model.outputWindow)}
                        </span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Edit/Delete Buttons — hidden when the model catalog is server-managed */}
                <div className="flex items-center gap-1">
                  {isActiveModel && (
                    <span
                      className="mr-1 inline-flex size-6 items-center justify-center rounded-full bg-primary/10 text-primary"
                      title={t('settings.currentlyUsing')}
                    >
                      <Check className="size-3.5" />
                    </span>
                  )}
                  {!modelsLocked && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2"
                        onClick={(event) => {
                          event.stopPropagation();
                          onEditModel(index);
                        }}
                        title={t('settings.editModel')}
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteModel(index);
                        }}
                        title={t('settings.deleteModel')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Reset Confirmation Dialog */}
      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.resetToDefault')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.resetConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowResetDialog(false);
                onResetToDefault?.();
              }}
            >
              {t('settings.confirmReset')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
