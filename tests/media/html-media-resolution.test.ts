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

it('keeps the last iframe-safe HTML until replacement blobs finish inlining', async () => {
  const oldUrl = 'blob:asset-before-replacement';
  const newUrl = 'blob:asset-after-replacement';
  let finishReplacement!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo) => {
      if (String(request) === oldUrl) {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'Content-Type': 'image/png' },
        });
      }
      if (String(request) === newUrl) {
        return new Promise<Response>((resolve) => {
          finishReplacement = resolve;
        });
      }
      throw new Error(`Unexpected media request: ${String(request)}`);
    }),
  );
  const html = '<img src="asset-id"><img src="stable-id">';
  mocks.urls.mockReturnValue({ 'asset-id': oldUrl, 'stable-id': oldUrl });
  await act(async () => root.render(createElement(Surface, { html })));
  await vi.waitFor(() => expect(container.textContent).toContain('data:image/png;base64,AQID'));

  mocks.urls.mockReturnValue({ 'asset-id': newUrl, 'stable-id': oldUrl });
  await act(async () => root.render(createElement(Surface, { html })));
  expect(container.textContent).toBe(
    '<img src="data:image/png;base64,AQID"><img src="data:image/png;base64,AQID">',
  );
  await act(async () =>
    finishReplacement(
      new Response(new Uint8Array([4, 5, 6]), { headers: { 'Content-Type': 'image/png' } }),
    ),
  );
  await vi.waitFor(() =>
    expect(container.textContent).toBe(
      '<img src="data:image/png;base64,BAUG"><img src="data:image/png;base64,AQID">',
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

const PARENT_BLOB = 'blob:https://livecourse.nikopack.works/77936aab-deca-44c0-93ca-e5efcbdd16c3';
const INLINED_PNG = `data:image/png;base64,${btoa('\x01\x02\x03')}`;

function stubBlobFetch(url = PARENT_BLOB) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo) => {
      if (String(request) !== url) throw new Error(String(request));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
    }),
  );
}

it('does not publish the unresolved placeholder while parent blobs are still inlining', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  mocks.urls.mockReturnValue({ 'asset-id': PARENT_BLOB });
  await act(async () => {
    root.render(createElement(Surface, { html: '<img src="asset-id">' }));
  });
  expect(container.textContent).toBe(`<img src="${PARENT_BLOB}">`);
  expect(container.textContent).not.toContain(UNRESOLVED_HTML_MEDIA_SRC);
  await act(async () =>
    finish(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toBe(`<img src="${INLINED_PNG}">`));
});

it('inlines literal parent blob URLs already baked into img src', async () => {
  stubBlobFetch();
  await act(async () => {
    root.render(createElement(Surface, { html: `<img src="${PARENT_BLOB}">` }));
  });
  await vi.waitFor(() => expect(container.textContent).toBe(`<img src="${INLINED_PNG}">`));
  expect(container.textContent).not.toContain('blob:');
});

it('inlines parent blob URLs in CSS url() so the sandboxed iframe can paint them', async () => {
  stubBlobFetch();
  await act(async () => {
    root.render(
      createElement(Surface, {
        html: `<style>.hero{background-image:url(${PARENT_BLOB})}</style>`,
      }),
    );
  });
  await vi.waitFor(() =>
    expect(container.textContent).toBe(
      `<style>.hero{background-image:url(${INLINED_PNG})}</style>`,
    ),
  );
  expect(container.textContent).not.toContain('blob:');
});

it('inlines parent blob URLs copied into scripts', async () => {
  stubBlobFetch();
  await act(async () => {
    root.render(
      createElement(Surface, {
        html: `<script>img.src="${PARENT_BLOB}"</script>`,
      }),
    );
  });
  await vi.waitFor(() =>
    expect(container.textContent).toBe(`<script>img.src="${INLINED_PNG}"</script>`),
  );
  expect(container.textContent).not.toContain('blob:');
});

it('resolves JS-assigned lesson image ids so the sandboxed page does not fetch them', async () => {
  mocks.urls.mockReturnValue({ lesson_img_scene_2_1: PARENT_BLOB });
  stubBlobFetch();
  await act(async () => {
    root.render(
      createElement(Surface, {
        html: `<script>board.src="lesson_img_scene_2_1"</script>`,
      }),
    );
  });
  expect(mocks.urls).toHaveBeenCalledWith(['lesson_img_scene_2_1']);
  await vi.waitFor(() =>
    expect(container.textContent).toBe(`<script>board.src="${INLINED_PNG}"</script>`),
  );
  expect(container.textContent).not.toContain('lesson_img_scene_2_1');
});

it('resolves SVG image href lesson ids', async () => {
  mocks.urls.mockReturnValue({ lesson_img_scene_2_1: PARENT_BLOB });
  stubBlobFetch();
  await act(async () => {
    root.render(
      createElement(Surface, {
        html: `<svg><image href="lesson_img_scene_2_1"></image></svg>`,
      }),
    );
  });
  await vi.waitFor(() =>
    expect(container.textContent).toBe(`<svg><image href="${INLINED_PNG}"></image></svg>`),
  );
});

it('resolves CSS url() asset ids through the pool and inlines the blob', async () => {
  mocks.urls.mockReturnValue({ lesson_img_scene_1_1: PARENT_BLOB });
  stubBlobFetch();
  await act(async () => {
    root.render(
      createElement(Surface, {
        html: `<div style="background-image:url(lesson_img_scene_1_1)"></div>`,
      }),
    );
  });
  expect(mocks.urls).toHaveBeenCalledWith(['lesson_img_scene_1_1']);
  await vi.waitFor(() =>
    expect(container.textContent).toBe(`<div style="background-image:url(${INLINED_PNG})"></div>`),
  );
  expect(container.textContent).not.toContain('blob:');
});
