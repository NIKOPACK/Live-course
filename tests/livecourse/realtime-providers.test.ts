import { describe, expect, it } from 'vitest';

import { resolveRealtimeClientApiKey } from '@/lib/livecourse/realtime/providers';

describe('resolveRealtimeClientApiKey', () => {
  it('returns nothing when the server already manages the provider', () => {
    expect(
      resolveRealtimeClientApiKey('openai', {
        realtimeProvidersConfig: {
          openai: { apiKey: 'sk-settings', enabled: true, isServerConfigured: true },
        },
        providersConfig: { openai: { apiKey: 'sk-llm' } },
      }),
    ).toBeUndefined();
  });

  it('prefers the dedicated Realtime key over the LLM OpenAI key', () => {
    expect(
      resolveRealtimeClientApiKey('openai', {
        realtimeProvidersConfig: { openai: { apiKey: ' sk-realtime ', enabled: true } },
        providersConfig: { openai: { apiKey: 'sk-llm' } },
      }),
    ).toBe('sk-realtime');
  });

  it('falls back to the saved OpenAI model key when Realtime is empty', () => {
    expect(
      resolveRealtimeClientApiKey('openai', {
        realtimeProvidersConfig: { openai: { apiKey: '  ', enabled: true } },
        providersConfig: { openai: { apiKey: 'sk-llm' } },
      }),
    ).toBe('sk-llm');
  });

  it('does not reuse the LLM key for Volc', () => {
    expect(
      resolveRealtimeClientApiKey('volc', {
        realtimeProvidersConfig: { volc: { apiKey: '', enabled: true } },
        providersConfig: { openai: { apiKey: 'sk-llm' } },
      }),
    ).toBeUndefined();
  });
});
