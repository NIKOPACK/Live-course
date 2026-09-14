// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { useMediaGenerationStore } from '@/lib/store/media-generation';

const mocks = vi.hoisted(() => ({ urls: vi.fn() }));
vi.mock('@/lib/media/use-asset-url', () => ({ useAssetUrls: mocks.urls }));

import { useResolvedHtml } from '@/lib/livecourse/html/use-resolved-html';

let root: Root;
let container: HTMLDivElement;
function Surface({ html }: { html: string }) {
  return createElement('pre', null, useResolvedHtml(html));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.urls.mockReset().mockReturnValue({});
  useMediaGenerationStore.setState({ tasks: {} });
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('resolves durable HTML asset references using the existing asset URL leases', async () => {
  mocks.urls.mockReturnValue({ 'asset-id': 'blob:restored' });
  await act(async () => {
    root.render(
      createElement(Surface, {
        html: '<img src="asset-id"><img src="https://example.test/source.png">',
      }),
    );
  });
  expect(mocks.urls).toHaveBeenCalledWith(['asset-id']);
  expect(container.textContent).toBe(
    '<img src="blob:restored"><img src="https://example.test/source.png">',
  );
});

it('resolves completing placeholders reactively but never takes media from another course', async () => {
  await act(async () => {
    root.render(
      createElement(
        MediaStageProvider,
        { value: 'current' },
        createElement(Surface, { html: '<img src="gen_img_1">' }),
      ),
    );
  });
  const task = {
    elementId: 'asset-id',
    placeholderRef: 'gen_img_1',
    status: 'done' as const,
    type: 'image' as const,
    objectUrl: 'blob:other',
    stageId: 'other',
    prompt: 'Media',
    params: {},
    retryCount: 0,
  };
  await act(async () => {
    useMediaGenerationStore.setState({ tasks: { 'asset-id': task } });
  });
  expect(container.textContent).toBe('<img src="gen_img_1">');
  await act(async () => {
    useMediaGenerationStore.setState({
      tasks: {
        'asset-id': { ...task, stageId: 'current', objectUrl: 'blob:current' },
      },
    });
  });
  expect(container.textContent).toBe('<img src="blob:current">');
});
