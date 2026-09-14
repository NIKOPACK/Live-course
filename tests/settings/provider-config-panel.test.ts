// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROVIDERS, type ProviderId } from '@/lib/ai/providers';
import { useSettingsStore } from '@/lib/store/settings';
import { useProviderCredentials } from '@/components/settings/use-provider-credentials';
import { ProviderConfigPanel } from '@/components/settings/provider-config-panel';

vi.mock('@/components/generation/generation-toolbar', () => ({ ModelThinkingControl: () => null }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

// jsdom gaps needed by the Base UI combobox popup.
Element.prototype.scrollIntoView ??= () => {};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const persist = vi.fn<(changes: Record<string, object>) => Promise<void>>();
const navigate = vi.fn<(providerId: ProviderId) => void>();
const configs = useSettingsStore.getInitialState().providersConfig;
function Harness() {
  const [liveConfigs, setLiveConfigs] = useState(configs);
  const credentials = useProviderCredentials(liveConfigs, async (changes) => {
    setLiveConfigs((previous) => {
      const next = { ...previous };
      for (const [key, fields] of Object.entries(changes)) {
        const id = key as ProviderId;
        next[id] = { ...next[id], ...fields };
      }
      return next;
    });
    await persist(changes);
  });
  return createElement(ProviderConfigPanel, {
    provider: PROVIDERS.openai,
    credentials: credentials.values('openai'),
    saving: credentials.isSaving,
    fieldStatus: (field) => credentials.status('openai', field),
    dirty: (field) => credentials.dirty('openai', field),
    providersConfig: configs,
    onConfigChange: (field, value) => credentials.change('openai', field, value),
    onSave: (field) => {
      void credentials.save('openai', field);
    },
    onEditModel: vi.fn(),
    onDeleteModel: vi.fn(),
    onAddModel: vi.fn(),
    isBuiltIn: true,
    onNavigateProvider: navigate,
  });
}
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  persist.mockReset().mockResolvedValue(undefined);
  navigate.mockReset();
  useSettingsStore.setState({ providerId: 'openai', modelId: 'gpt-5.6' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('masks and labels the key; blur keeps a draft; explicit save failure supports field-local retry', async () => {
  const key = container.querySelector<HTMLInputElement>('#llm-api-key-openai')!;
  expect(key.type).toBe('password');
  expect(container.querySelector('label[for="llm-api-key-openai"]')).not.toBeNull();
  await type(key, 'test-only-draft');
  await act(async () => {
    key.focus();
    key.blur();
  });
  expect(persist).not.toHaveBeenCalled();
  const feedback = container.querySelector('#credential-status-openai-apiKey')!;
  expect(feedback.textContent).toContain('settings.unsavedChanges');
  persist.mockRejectedValueOnce(new Error('quota exhausted'));
  await act(async () => feedback.querySelector<HTMLButtonElement>('button')!.click());
  expect(key.value).toBe('test-only-draft');
  expect(key.getAttribute('aria-invalid')).toBe('true');
  expect(feedback.querySelector('[role="alert"]')?.textContent).toBe('settings.saveFailed');
  await act(async () => feedback.querySelector<HTMLButtonElement>('button')!.click());
  expect(persist).toHaveBeenLastCalledWith({ openai: { apiKey: 'test-only-draft' } });
  expect(feedback.textContent).toContain('settings.saveSuccess');
  expect(key.getAttribute('aria-invalid')).toBe('false');
});

it('marks the active model row and selects another model by clicking its row', async () => {
  const rows = [...container.querySelectorAll<HTMLElement>('[role="radiogroup"] [role="radio"]')];
  expect(rows.length).toBe(configs.openai.models.length);
  const initiallyChecked = container.querySelector('[role="radio"][aria-checked="true"]');
  expect(initiallyChecked?.querySelector('.font-mono')?.textContent).toBe('GPT-5.6 Sol');

  const target = rows.find((row) => row.querySelector('.font-mono')?.textContent === 'GPT-5.4 Mini')!;
  await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  expect(useSettingsStore.getState().providerId).toBe('openai');
  expect(useSettingsStore.getState().modelId).toBe('gpt-5.4-mini');
  expect(target.getAttribute('aria-checked')).toBe('true');
  expect(container.querySelectorAll('[role="radio"][aria-checked="true"]')).toHaveLength(1);
});

it('row action buttons do not change the active model', async () => {
  const rows = [...container.querySelectorAll<HTMLElement>('[role="radiogroup"] [role="radio"]')];
  const target = rows.find((row) => row.querySelector('.font-mono')?.textContent === 'GPT-5.4 Mini')!;
  const editButton = target.querySelector<HTMLButtonElement>('button[title="settings.editModel"]')!;
  await act(async () => editButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(useSettingsStore.getState().modelId).toBe('gpt-5.6');
  expect(target.getAttribute('aria-checked')).toBe('false');
});

it('picker searches across providers and switches provider+model together', async () => {
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="input-group-button"]')!;
  await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="settings.activeModel"]',
  )!;
  await type(input, 'claude-sonnet-5');

  const items = [...document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')];
  expect(items.length).toBeGreaterThan(0);
  const target = items.find(
    (item) => item.querySelector('.font-mono')?.textContent === 'Claude Sonnet 5',
  )!;
  expect(target).toBeDefined();
  await act(async () => target.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  expect(useSettingsStore.getState().providerId).toBe('anthropic');
  expect(useSettingsStore.getState().modelId).toBe('claude-sonnet-5');
  expect(navigate).toHaveBeenCalledWith('anthropic');
  // Config-only write: credential persistence never fires for model switching.
  expect(persist).not.toHaveBeenCalled();
});

it('picker reports no matches for an unknown query', async () => {
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="input-group-button"]')!;
  await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="settings.activeModel"]',
  )!;
  await type(input, 'no-such-model-anywhere');
  expect(document.querySelector('[data-slot="combobox-empty"]')?.textContent).toBe(
    'settings.noModelsFound',
  );
});

it('picker only offers models from visible providers', async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(function NarrowHarness() {
        const credentials = useProviderCredentials(configs, async () => {});
        return createElement(ProviderConfigPanel, {
          provider: PROVIDERS.openai,
          credentials: credentials.values('openai'),
          saving: credentials.isSaving,
          fieldStatus: (field) => credentials.status('openai', field),
          dirty: (field) => credentials.dirty('openai', field),
          providersConfig: configs,
          onConfigChange: (field, value) => credentials.change('openai', field, value),
          onSave: vi.fn(),
          onEditModel: vi.fn(),
          onDeleteModel: vi.fn(),
          onAddModel: vi.fn(),
          isBuiltIn: true,
          visibleProviderIds: ['openai'],
        });
      }),
    ),
  );
  const trigger = container.querySelector<HTMLButtonElement>(
    '[data-slot="input-group-button"]',
  )!;
  await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const groupLabels = [...document.querySelectorAll('[data-slot="combobox-label"]')].map((el) =>
    el.textContent?.replace(/\d+$/, ''),
  );
  expect(groupLabels.length).toBe(1);
  expect(document.querySelectorAll('[data-slot="combobox-item"]').length).toBe(
    configs.openai.models.length,
  );
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="settings.activeModel"]',
  )!;
  await type(input, 'claude');
  expect(document.querySelector('[data-slot="combobox-empty"]')?.textContent).toBe(
    'settings.noModelsFound',
  );
});
