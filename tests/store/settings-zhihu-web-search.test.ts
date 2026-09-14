import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings';

describe('zhihu web search settings', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      webSearchEnabled: false,
      webSearchProviderId: 'zhihu',
    });
  });

  it('includes zhihu in the default provider config', () => {
    const config = useSettingsStore.getState().webSearchProvidersConfig.zhihu;
    expect(config).toMatchObject({
      apiKey: '',
      baseUrl: 'https://developer.zhihu.com',
      enabled: true,
      requiresApiKey: true,
      searchDB: 'all',
      filter: '',
    });
    expect(useSettingsStore.getState().webSearchEnabled).toBe(false);
  });

  it('persists Zhihu filter, searchDB, and the generation switch', () => {
    const s = useSettingsStore.getState();
    s.setWebSearchEnabled(true);
    s.setWebSearchProvider('zhihu');
    s.setWebSearchProviderConfig('zhihu', {
      apiKey: 'zhihu-secret',
      searchDB: 'realtime',
      filter: 'host=="example.com"',
    });

    const state = useSettingsStore.getState();
    expect(state.webSearchEnabled).toBe(true);
    expect(state.webSearchProviderId).toBe('zhihu');
    expect(state.webSearchProvidersConfig.zhihu).toMatchObject({
      apiKey: 'zhihu-secret',
      searchDB: 'realtime',
      filter: 'host=="example.com"',
    });
  });

  it('keeps zhihu selected when it is disabled — it is the only provider', () => {
    const s = useSettingsStore.getState();
    s.setWebSearchProvider('zhihu');
    s.setWebSearchProviderConfig('zhihu', { enabled: false });
    // Zhihu-only: the fallback default is zhihu itself.
    expect(useSettingsStore.getState().webSearchProviderId).toBe('zhihu');
  });

  it('ignores leftover provider ids instead of writing them into config', () => {
    const s = useSettingsStore.getState();
    s.setWebSearchProvider('tavily' as never);
    s.setWebSearchProviderConfig('bocha' as never, { apiKey: 'stale' });
    expect(useSettingsStore.getState().webSearchProviderId).toBe('zhihu');
    expect(Object.keys(useSettingsStore.getState().webSearchProvidersConfig)).toEqual(['zhihu']);
    expect('bocha' in useSettingsStore.getState().webSearchProvidersConfig).toBe(false);
  });
});
