// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { RealtimeSettings } from '@/components/settings/realtime-settings';
import { useProviderCredentials } from '@/components/settings/use-provider-credentials';
import type { RealtimeProviderId } from '@/lib/types/settings';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const persist = vi.fn<(changes: Record<string, object>) => Promise<void>>();

function Harness() {
  const [configs, setConfigs] = useState({
    openai: { apiKey: '', baseUrl: '', requiresApiKey: true },
  });
  const credentials = useProviderCredentials(configs, async (changes) => {
    setConfigs((previous) => {
      const next = { ...previous };
      for (const [key, fields] of Object.entries(changes)) {
        const id = key as RealtimeProviderId;
        next[id] = { ...next[id], ...fields };
      }
      return next;
    });
    await persist(changes);
  });
  return createElement(RealtimeSettings, {
    selectedProviderId: 'openai',
    credentials: credentials.values('openai'),
    saving: credentials.isSaving,
    isServerConfigured: false,
    fieldStatus: (field) => credentials.status('openai', field),
    dirty: (field) => credentials.dirty('openai', field),
    onConfigChange: (field, value) => credentials.change('openai', field, value),
    onSave: (field) => {
      void credentials.save('openai', field);
    },
  });
}

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  persist.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

it('saves a masked Realtime key through explicit field save', async () => {
  await act(async () => root!.render(createElement(Harness)));
  const input = container.querySelector<HTMLInputElement>('[data-testid="realtime-api-key"]');
  expect(input?.type).toBe('password');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'sk-live',
    );
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const save = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'settings.save',
  );
  expect(save).toBeTruthy();
  await act(async () => save!.click());
  expect(persist).toHaveBeenCalledWith({ openai: { apiKey: 'sk-live' } });
});
