// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useProviderCredentials,
  type CredentialConfigs,
} from '@/components/settings/use-provider-credentials';

const configs = {
  custom: { apiKey: 'old-key', baseUrl: 'https://example.test/v1', requiresApiKey: true },
  second: { apiKey: '', baseUrl: '', requiresApiKey: true },
};
let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useProviderCredentials>;
const persist = vi.fn<(changes: Record<string, object>) => Promise<void>>();
function Harness({ values = configs }: { values?: CredentialConfigs }) {
  const credentials = useProviderCredentials(values, persist);
  useLayoutEffect(() => {
    current = credentials;
  });
  return null;
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  persist.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('explicit provider credential saves (S1 settings; no W/C/L)', () => {
  it('keeps edits local until Save, including a key cleared to an empty string', async () => {
    await act(async () => current.change('custom', 'apiKey', ''));
    expect(current.values('custom').apiKey).toBe('');
    expect(configs.custom.apiKey).toBe('old-key');
    expect(persist).not.toHaveBeenCalled();
    await act(async () => current.save());
    expect(persist).toHaveBeenCalledExactlyOnceWith({ custom: { apiKey: '' } });
    await act(async () =>
      root.render(
        createElement(Harness, {
          values: { ...configs, custom: { ...configs.custom, apiKey: '' } },
        }),
      ),
    );
    expect(current.status('custom', 'apiKey')).toBe('saved');
  });

  it('reports saving until acknowledgement and prevents duplicate saves', async () => {
    let resolve!: () => void;
    persist.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await act(async () => current.change('custom', 'baseUrl', 'https://new.test/v1'));
    let pending!: Promise<void>;
    await act(async () => {
      pending = current.save();
    });
    expect(current.isSaving).toBe(true);
    expect(current.status('custom', 'baseUrl')).toBe('saving');
    await act(async () => current.save());
    expect(persist).toHaveBeenCalledOnce();
    await act(async () => {
      resolve();
      await pending;
    });
    await act(async () =>
      root.render(
        createElement(Harness, {
          values: { ...configs, custom: { ...configs.custom, baseUrl: 'https://new.test/v1' } },
        }),
      ),
    );
    expect(current.status('custom', 'baseUrl')).toBe('saved');
    expect(current.isSaving).toBe(false);
  });

  it('retains failed fields across store rehydration and retries one edited field', async () => {
    persist.mockRejectedValueOnce(new Error('storage unavailable'));
    await act(async () => {
      current.change('custom', 'apiKey', 'draft-key');
      current.change('custom', 'baseUrl', 'https://new.test/v1');
    });
    await act(async () => current.save());
    expect(current.saveStatus).toBe('error');
    expect(current.status('custom', 'apiKey')).toBe('error');
    expect(current.status('custom', 'baseUrl')).toBe('error');
    await act(async () =>
      root.render(
        createElement(Harness, {
          values: { ...configs, custom: { ...configs.custom, apiKey: 'rehydrated-key' } },
        }),
      ),
    );
    expect(current.values('custom').apiKey).toBe('draft-key');
    await act(async () => current.change('custom', 'apiKey', 'corrected-key'));
    expect(current.status('custom', 'apiKey')).toBe('idle');
    await act(async () => current.save('custom', 'apiKey'));
    expect(persist).toHaveBeenLastCalledWith({ custom: { apiKey: 'corrected-key' } });
    await act(async () =>
      root.render(
        createElement(Harness, {
          values: { ...configs, custom: { ...configs.custom, apiKey: 'corrected-key' } },
        }),
      ),
    );
    expect(current.status('custom', 'apiKey')).toBe('saved');
    expect(current.status('custom', 'baseUrl')).toBe('error');
    expect(current.values('custom').baseUrl).toBe('https://new.test/v1');
  });

  it('retains separate drafts when selecting another provider and saves only edits', async () => {
    await act(async () => {
      current.change('custom', 'apiKey', 'one');
      current.change('second', 'requiresApiKey', false);
    });
    expect(current.values('custom').apiKey).toBe('one');
    expect(current.values('second').requiresApiKey).toBe(false);
    await act(async () => current.save());
    expect(persist).toHaveBeenCalledWith({
      custom: { apiKey: 'one' },
      second: { requiresApiKey: false },
    });
  });
});

it('does not apply an old success receipt to new values from the store', async () => {
  await act(async () => current.change('custom', 'apiKey', 'saved-key'));
  await act(async () => current.save());
  await act(async () =>
    root.render(
      createElement(Harness, {
        values: { ...configs, custom: { ...configs.custom, apiKey: 'saved-key' } },
      }),
    ),
  );
  expect(current.status('custom', 'apiKey')).toBe('saved');
  await act(async () =>
    root.render(
      createElement(Harness, {
        values: { ...configs, custom: { ...configs.custom, apiKey: 'external-pending-key' } },
      }),
    ),
  );
  expect(current.status('custom', 'apiKey')).toBe('idle');
  expect(current.saveStatus).toBe('idle');
});

it('exposes newly managed drafts for discard while allowing other providers to save', async () => {
  await act(async () => current.change('custom', 'apiKey', 'unsaved-key'));
  await act(async () =>
    root.render(
      createElement(Harness, {
        values: { ...configs, custom: { ...configs.custom, isServerConfigured: true } },
      }),
    ),
  );
  expect(current.blockedProviders).toEqual(['custom']);
  await act(async () => current.change('second', 'baseUrl', 'https://new.test/v1'));
  await act(async () => current.save());
  expect(persist).toHaveBeenCalledExactlyOnceWith({ second: { baseUrl: 'https://new.test/v1' } });
  expect(current.values('custom').apiKey).toBe('unsaved-key');
  await act(async () => current.discard('custom'));
  expect(current.blockedProviders).toEqual([]);
  expect(current.dirty('custom', 'apiKey')).toBe(false);
});
