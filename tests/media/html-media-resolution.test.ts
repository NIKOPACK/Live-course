// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { useMediaGenerationStore } from '@/lib/store/media-generation';

const mocks = vi.hoisted(() => ({ urls: vi.fn() }));
vi.mock('@/lib/media/use-asset-url', () => ({ useAssetUrls: mocks.urls }));

import { UNRESOLVED_HTML_MEDIA_SRC } from '@/lib/livecourse/html/media';
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
  vi.unstubAllGlobals();
});

it('resolves durable HTML asset references using the existing asset URL leases', async () => {
  mocks.urls.mockReturnValue({ 'asset-id': 'blob:restored' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo) => {
      if (String(url) !== 'blob:restored') throw new Error(String(url));
      return new Response(new Uint8Array([9, 8, 7]), { headers: { 'Content-Type': 'image/jpeg' } });
    }),
  );
  await act(async () => {
    root.render(
      createElement(Surface, {
        html: '<img src="asset-id"><img src="https://example.test/source.png">',
      }),
    );
  });
  expect(mocks.urls).toHaveBeenCalledWith(['asset-id']);
  await vi.waitFor(() =>
    expect(container.textContent).toBe(
      `<img src="data:image/jpeg;base64,${btoa('\x09\x08\x07')}"><img src="https://example.test/source.png">`,
    ),
  );
});

it('resolves completing placeholders reactively but never takes media from another course', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo) => {
      if (String(url) !== 'blob:current') throw new Error(String(url));
      return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/gif' } });
    }),
  );
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
  expect(container.textContent).toBe(`<img src="${UNRESOLVED_HTML_MEDIA_SRC}">`);
  await act(async () => {
    useMediaGenerationStore.setState({
      tasks: {
        'asset-id': { ...task, stageId: 'current', objectUrl: 'blob:current' },
      },
    });
  });
  await vi.waitFor(() => {
    expect(container.textContent).toContain('data:image/gif;base64,');
    expect(container.textContent).not.toContain('blob:');
  });
});

it('does not let unresolved lesson image ids hit the classroom route', async () => {
  await act(async () => {
    root.render(
      createElement(Surface, {
        html: '<img src="lesson_img_scene_1_1"><img src="https://example.test/ok.png">',
      }),
    );
  });
  expect(container.textContent).toBe(
    `<img src="${UNRESOLVED_HTML_MEDIA_SRC}"><img src="https://example.test/ok.png">`,
  );
});
