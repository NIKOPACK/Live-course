// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isProviderInUse } from '@/components/settings/utils';
import { ProviderList } from '@/components/settings/provider-list';
import { AddProviderDialog } from '@/components/settings/add-provider-dialog';
import type { ProviderSettings } from '@/lib/types/settings';
import type { ProviderId } from '@/lib/ai/providers';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function provider(partial: Partial<ProviderSettings>): ProviderSettings {
  return {
    apiKey: '',
    baseUrl: '',
    models: [],
    name: 'P',
    type: 'openai',
    isBuiltIn: true,
    ...partial,
  } as ProviderSettings;
}

// Spec basis: docs/spec/02「设置」— settings must not become a model-ecosystem
// shelf; only providers carrying user/operator intent stay visible.
it('isProviderInUse keeps only providers with user or operator intent', () => {
  expect(isProviderInUse(undefined)).toBe(false);
  // Pristine built-in: hidden.
  expect(isProviderInUse(provider({}))).toBe(false);
  // Keyless built-in with only a registry default URL is NOT user intent.
  expect(isProviderInUse(provider({ requiresApiKey: false }))).toBe(false);
  // Keyless with explicit baseUrl: visible.
  expect(
    isProviderInUse(provider({ requiresApiKey: false, baseUrl: 'http://localhost:11434/v1' })),
  ).toBe(true);
  // API key entered: visible (whitespace-only does not count).
  expect(isProviderInUse(provider({ apiKey: '   ' }))).toBe(false);
  expect(isProviderInUse(provider({ apiKey: 'sk-x' }))).toBe(true);
  // Operator-managed: visible.
  expect(isProviderInUse(provider({ isServerConfigured: true }))).toBe(true);
  // Custom providers are user-created by definition.
  expect(isProviderInUse(provider({ isBuiltIn: false }))).toBe(true);
});

describe('ProviderList visibility', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('renders the empty state with the add entry when nothing is visible', async () => {
    await act(async () =>
      root.render(
        createElement(ProviderList, {
          providers: [],
          selectedProviderId: 'openai' as ProviderId,
          onSelect: vi.fn(),
          onAddProvider: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).toContain('settings.noConfiguredProviders');
    expect(container.textContent).toContain('settings.configureProvidersFirst');
    // The add-provider entry stays reachable in the empty state.
    expect(container.querySelector('button')?.textContent).toContain('settings.addProviderButton');
  });

  it('lists only the providers it is given', async () => {
    await act(async () =>
      root.render(
        createElement(ProviderList, {
          providers: [
            { id: 'openai' as ProviderId, name: 'OpenAI', type: 'openai', models: [] },
            { id: 'kimi' as ProviderId, name: 'Kimi', type: 'openai', models: [] },
          ] as never,
          selectedProviderId: 'openai' as ProviderId,
          onSelect: vi.fn(),
          onAddProvider: vi.fn(),
        }),
      ),
    );
    const names = [...container.querySelectorAll('button span')].map((el) => el.textContent);
    expect(names).toContain('OpenAI');
    expect(names).toContain('Kimi');
    expect(names).not.toContain('Claude');
  });
});

describe('AddProviderDialog catalog', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('offers hidden built-ins for one-click reveal, then the custom form', async () => {
    const onSelectBuiltin = vi.fn();
    await act(async () =>
      root.render(
        createElement(AddProviderDialog, {
          open: true,
          onOpenChange: vi.fn(),
          onAdd: vi.fn(),
          catalogProviders: [
            { id: 'anthropic' as ProviderId, name: 'Claude' },
            { id: 'glm' as ProviderId, name: 'GLM' },
          ],
          onSelectBuiltin,
        }),
      ),
    );
    // Radix dialog portals to body.
    const catalogButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Claude',
    );
    expect(catalogButton).toBeDefined();
    // Custom form still present below the catalog.
    expect(document.body.textContent).toContain('settings.customProvider');
    await act(async () => catalogButton!.click());
    expect(onSelectBuiltin).toHaveBeenCalledWith('anthropic');
  });

  it('renders only the custom form when the catalog is exhausted', async () => {
    await act(async () =>
      root.render(
        createElement(AddProviderDialog, {
          open: true,
          onOpenChange: vi.fn(),
          onAdd: vi.fn(),
          catalogProviders: [],
          onSelectBuiltin: vi.fn(),
        }),
      ),
    );
    expect(document.body.textContent).not.toContain('settings.providerCatalog');
    expect(document.body.textContent).toContain('settings.providerName');
  });
});
