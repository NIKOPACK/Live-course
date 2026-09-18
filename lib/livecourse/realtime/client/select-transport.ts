export type ClassroomRealtimeTransport = 'volc' | 'openai';

type RealtimeProviderConfig = {
  isServerConfigured?: boolean;
  apiKey?: string;
};

export function isRealtimeProviderReady(config?: RealtimeProviderConfig): boolean {
  return Boolean(config?.isServerConfigured || config?.apiKey?.trim());
}

/**
 * Pick the classroom voice transport after server providers have loaded.
 * Volc is preferred when the operator configured VOLCENGINE_REALTIME_API_KEY.
 * Do not fall through to OpenAI Realtime unless that channel is actually usable;
 * otherwise Firefox can hang in AudioContext.resume() with no network request.
 */
export function selectClassroomRealtimeTransport(state: {
  realtimeProvidersConfig?: Record<string, RealtimeProviderConfig | undefined>;
}): ClassroomRealtimeTransport | null {
  const config = state.realtimeProvidersConfig;
  if (isRealtimeProviderReady(config?.volc)) return 'volc';
  if (isRealtimeProviderReady(config?.openai)) return 'openai';
  return null;
}
