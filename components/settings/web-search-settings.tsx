'use client';

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import { ZHIHU_SEARCH_DBS, type ZhihuSearchDB } from '@/lib/web-search/types';
import { ExternalLink, Eye, EyeOff } from 'lucide-react';

const provider = WEB_SEARCH_PROVIDERS.zhihu;

/**
 * Web search settings — Zhihu Global Search (全网搜索) is the only provider,
 * so this panel is the provider config; there is no provider column to pick.
 */
export function WebSearchSettings() {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);

  const webSearchEnabled = useSettingsStore((state) => state.webSearchEnabled);
  const setWebSearchEnabled = useSettingsStore((state) => state.setWebSearchEnabled);
  const webSearchProvidersConfig = useSettingsStore((state) => state.webSearchProvidersConfig);
  const setWebSearchProviderConfig = useSettingsStore((state) => state.setWebSearchProviderConfig);

  const isServerConfigured = !!webSearchProvidersConfig.zhihu?.isServerConfigured;
  // Managed providers are admin-owned: hide the key/base-URL override inputs.
  const showCredentialFields = !isServerConfigured;

  const buildRequestUrl = (baseUrl: string) => {
    const trimmed = baseUrl.replace(/\/$/, '');
    if (!provider.endpointPath) return trimmed;
    if (trimmed.endsWith(provider.endpointPath)) return trimmed;
    return `${trimmed}${provider.endpointPath}`;
  };

  const zhihuSearchDB: ZhihuSearchDB =
    webSearchProvidersConfig.zhihu?.searchDB === 'realtime' ||
    webSearchProvidersConfig.zhihu?.searchDB === 'static'
      ? webSearchProvidersConfig.zhihu.searchDB
      : 'all';

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <Label className="text-sm">{t('settings.webSearchEnabled')}</Label>
          <p className="text-xs text-muted-foreground">{t('settings.webSearchEnabledHint')}</p>
        </div>
        <Switch
          checked={webSearchEnabled}
          onCheckedChange={setWebSearchEnabled}
          aria-label={t('settings.webSearchEnabled')}
        />
      </div>

      {/* Server-configured notice */}
      {isServerConfigured && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 p-3 text-sm text-blue-700 dark:text-blue-300">
          {t('settings.serverConfiguredNotice')}
        </div>
      )}

      {/* API Key + Base URL Configuration */}
      {showCredentialFields && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">{t('settings.webSearchApiKey')}</Label>
              <div className="relative">
                <Input
                  name="web-search-api-key-zhihu"
                  type={showApiKey ? 'text' : 'password'}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={t('settings.enterApiKey')}
                  value={webSearchProvidersConfig.zhihu?.apiKey || ''}
                  onChange={(e) =>
                    setWebSearchProviderConfig('zhihu', {
                      apiKey: e.target.value,
                    })
                  }
                  className="font-mono text-sm pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  aria-label={t(showApiKey ? 'settings.hideSecret' : 'settings.showSecret')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{t('settings.webSearchApiKeyHint')}</p>
            </div>

            <div className="space-y-2">
              <Label className="text-sm">{t('settings.webSearchBaseUrl')}</Label>
              <Input
                name="web-search-base-url-zhihu"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={provider.defaultBaseUrl || ''}
                value={webSearchProvidersConfig.zhihu?.baseUrl || ''}
                onChange={(e) =>
                  setWebSearchProviderConfig('zhihu', {
                    baseUrl: e.target.value,
                  })
                }
                className="text-sm"
              />
            </div>
          </div>

          {/* Request URL Preview */}
          {(() => {
            const effectiveBaseUrl =
              webSearchProvidersConfig.zhihu?.baseUrl || provider.defaultBaseUrl || '';
            if (!effectiveBaseUrl) return null;
            const fullUrl = buildRequestUrl(effectiveBaseUrl);
            return (
              <p className="text-xs text-muted-foreground break-all">
                {t('settings.requestUrl')}: {fullUrl}
              </p>
            );
          })()}
        </>
      )}

      <div className="space-y-4">
        <div className="space-y-2">
          <Label className="text-sm">{t('settings.zhihuSearchDB')}</Label>
          <Select
            value={zhihuSearchDB}
            onValueChange={(value) =>
              setWebSearchProviderConfig('zhihu', { searchDB: value as ZhihuSearchDB })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ZHIHU_SEARCH_DBS.map((db) => (
                <SelectItem key={db} value={db}>
                  {t(
                    db === 'realtime'
                      ? 'settings.zhihuSearchDBRealtime'
                      : db === 'static'
                        ? 'settings.zhihuSearchDBStatic'
                        : 'settings.zhihuSearchDBAll',
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('settings.zhihuSearchDBHint')}</p>
        </div>

        <div className="space-y-2">
          <Label className="text-sm">{t('settings.zhihuFilter')}</Label>
          <Input
            name="web-search-zhihu-filter"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder='host=="example.com" AND publish_time>=1778494631'
            value={webSearchProvidersConfig.zhihu?.filter || ''}
            onChange={(e) =>
              setWebSearchProviderConfig('zhihu', {
                filter: e.target.value,
              })
            }
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {t('settings.zhihuFilterHint')}
            <a
              href="https://developer.zhihu.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 ml-1.5 text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 hover:underline"
            >
              {t('settings.viewDocs')}
              <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
