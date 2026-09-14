import type { RealtimeProviderId, RealtimeProviderSettings } from '@/lib/types/settings';

export const REALTIME_PROVIDERS: Record<
  RealtimeProviderId,
  { id: RealtimeProviderId; icon: string }
> = {
  openai: { id: 'openai', icon: '/logos/openai.svg' },
  volc: { id: 'volc', icon: '/logos/doubao.svg' },
};

export function resolveRealtimeClientApiKey(
  providerId: RealtimeProviderId,
  settings: {
    realtimeProvidersConfig?: Partial<Record<RealtimeProviderId, RealtimeProviderSettings>>;
    providersConfig?: Partial<Record<string, { apiKey?: string }>>;
  },
): string | undefined {
  const config = settings.realtimeProvidersConfig?.[providerId];
  if (config?.isServerConfigured) return undefined;
  const dedicated = config?.apiKey?.trim();
  if (dedicated) return dedicated;
  if (providerId === 'openai') {
    return settings.providersConfig?.openai?.apiKey?.trim() || undefined;
  }
  return undefined;
}
