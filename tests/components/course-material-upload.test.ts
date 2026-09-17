// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: vi.fn<(file: File) => Promise<string>>(),
  remove: vi.fn<(key: string) => Promise<void>>(),
  push: vi.fn(),
  settings: {
    providerId: 'local',
    modelId: 'local-model',
    pdfProviderId: 'plain-text',
    providersConfig: {
      local: { name: 'Local', isServerConfigured: true, models: [{ id: 'local-model' }] },
    },
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: Object.assign(
    (select: (state: typeof mocks.settings) => unknown) => select(mocks.settings),
    { getState: () => mocks.settings },
  ),
}));
vi.mock('@/lib/store/user-profile', () => ({ useUserProfileStore: { getState: () => ({}) } }));
vi.mock('@/lib/utils/image-storage', () => ({
  storeDocumentBlob: mocks.store,
  deleteDocumentBlob: mocks.remove,
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  listStages: async () => [],
  revokeThumbnailSlideMediaUrls: vi.fn(),
}));
vi.mock('@/lib/store/media-generation', () => ({
  useMediaGenerationStore: { getState: () => ({ revokeObjectUrls: vi.fn() }), setState: vi.fn() },
}));
vi.mock('@/lib/import/use-import-classroom', () => ({
  useImportClassroom: () => ({ importing: false }),
}));
vi.mock('@/lib/import/use-import-pptx', () => ({ useImportPptx: () => ({ importing: false }) }));
vi.mock('@/components/settings', () => ({ SettingsDialog: () => null }));
vi.mock('@/components/language-switcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/components/audio/speech-button', () => ({ SpeechButton: () => null }));
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({ SlideThumbnail: () => null }));
vi.mock('@/components/livecourse/CourseEntryDialog', () => ({ CourseEntryDialog: () => null }));
vi.mock('@/lib/livecourse/session/course-state-repository', () => ({
  createCourseStateRepository: vi.fn(),
}));
vi.mock('@/lib/runtime/store', () => ({ getRuntimeStore: vi.fn() }));
vi.mock('@/lib/runtime/learner-key', () => ({ getLearnerKey: vi.fn() }));

import Page from '@/app/page';

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.store.mockReset();
  mocks.remove.mockReset().mockResolvedValue(undefined);
  mocks.push.mockReset();
  mocks.settings.pdfProviderId = 'plain-text';
  mocks.settings.providersConfig = {
    local: { name: 'Local', isServerConfigured: true, models: [{ id: 'local-model' }] },
  };
  localStorage.clear();
  sessionStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(
    (element) => element.textContent === label || element.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function row(name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[data-upload-status]')].find(
    (element) => element.querySelector('p')?.textContent === name,
  );
  if (!found) throw new Error(`Missing material: ${name}`);
  return found;
}

function file(name: string) {
  return new File(['fractions'], name, { type: 'text/plain', lastModified: 123 });
}

function startButton() {
  return container.querySelector<HTMLButtonElement>('[data-testid="start-generation"]')!;
}

async function click(element: HTMLButtonElement) {
  await act(async () => element.click());
}

async function renderHome() {
  localStorage.setItem('requirementDraft', JSON.stringify('Learn fractions'));
  await act(async () => root!.render(createElement(StrictMode, null, createElement(Page))));
  await act(async () => button('toolbar.courseMaterialUpload').click());
}

async function selectFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

// docs/spec/01 J1.2/J1.3, 02 首页, 05 S2: actual selection and submission
// boundaries. Only browser persistence/router and unrelated homepage surfaces
// are substituted; the upload toolbar, homepage and draft cache remain real.
describe('course material upload', () => {
  it('persists selected files independently before submission and exposes partial failure without losing the draft', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    mocks.store.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await renderHome();
    await selectFiles([
      new File(['fractions'], 'notes.txt', { type: 'text/plain' }),
      new File(['practice'], 'exercises.txt', { type: 'text/plain' }),
    ]);
    expect(mocks.store).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('[data-upload-status="uploading"]')).toHaveLength(2);
    await act(async () => {
      first.resolve('stable-notes');
      second.reject(new Error('Storage quota exceeded'));
    });
    expect(document.querySelectorAll('[data-upload-status="completed"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-upload-status="failed"]')).toHaveLength(1);
    expect(document.body.textContent).toContain('Storage quota exceeded');
    expect(container.querySelector('textarea')?.value).toBe('Learn fractions');
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('generationSession')).toBeNull();
  });

  it('retries only the failed file once for batched clicks and submits stable keys in selection order', async () => {
    mocks.store.mockResolvedValueOnce('stable-notes').mockRejectedValueOnce(new Error('Quota'));
    await renderHome();
    await selectFiles([file('notes.txt'), file('exercises.txt')]);
    expect(startButton().disabled).toBe(true);
    const retry = deferred<string>();
    mocks.store.mockReturnValueOnce(retry.promise);
    const retryButton = button('upload.retryMaterial', row('exercises.txt'));
    await act(async () => {
      retryButton.click();
      retryButton.click();
    });
    expect(mocks.store).toHaveBeenCalledTimes(3);
    expect(row('notes.txt').dataset.uploadStatus).toBe('completed');
    expect(row('exercises.txt').dataset.uploadStatus).toBe('uploading');
    await act(async () => retry.resolve('stable-exercises'));
    const start = startButton();
    await act(async () => {
      start.click();
      start.click();
    });
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/generation-preview');
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    expect(button('toolbar.courseMaterialUpload', container).disabled).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('[data-testid="goal-example"]')].every(
        (example) => example.disabled,
      ),
    ).toBe(true);
    const saved = JSON.parse(sessionStorage.getItem('generationSession')!);
    expect(saved.documentSources).toEqual([
      expect.objectContaining({ name: 'notes.txt', storageKey: 'stable-notes', order: 1 }),
      expect.objectContaining({ name: 'exercises.txt', storageKey: 'stable-exercises', order: 2 }),
    ]);
    expect(saved.pdfStorageKey).toBe('stable-notes');
    expect(saved.requirements).toEqual({ requirement: 'Learn fractions', webSearch: false });
    expect(mocks.store).toHaveBeenCalledTimes(3);
    expect(mocks.remove).not.toHaveBeenCalled();
    await act(async () => root!.unmount());
    root = undefined;
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('retains successful uploads and draft after sessionStorage failure and retries without storing blobs again', async () => {
    mocks.store.mockResolvedValueOnce('stable-notes');
    await renderHome();
    await selectFiles([file('notes.txt')]);
    const originalSet = Storage.prototype.setItem;
    const attempts: string[] = [];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === 'generationSession') {
        attempts.push(value);
        if (attempts.length === 1) throw new Error('Session storage full');
      }
      originalSet.call(this, key, value);
    });
    await click(startButton());
    expect(document.body.textContent).toContain('Session storage full');
    expect(container.querySelector('textarea')?.value).toBe('Learn fractions');
    expect(row('notes.txt').dataset.uploadStatus).toBe('completed');
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(startButton().disabled).toBe(false);
    expect(container.querySelector('textarea')?.disabled).toBe(false);
    expect(button('toolbar.courseMaterialUpload', container).disabled).toBe(false);
    await click(startButton());
    expect(JSON.parse(attempts[1]).sessionId).toBe(JSON.parse(attempts[0]).sessionId);
    expect(mocks.store).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledOnce();
  });

  it('keeps the same identity and material keys when navigation fails and the draft is resubmitted', async () => {
    mocks.store.mockResolvedValueOnce('stable-notes');
    mocks.push.mockImplementationOnce(() => {
      throw new Error('Navigation failed');
    });
    await renderHome();
    await selectFiles([file('notes.txt')]);
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    await click(startButton());
    expect(document.body.textContent).toContain('Navigation failed');
    expect(sessionStorage.getItem('generationSession')).toBeNull();
    expect(mocks.remove).not.toHaveBeenCalled();
    await click(startButton());
    const sessions = writes.mock.calls
      .filter(([key]) => key === 'generationSession')
      .map(([, value]) => JSON.parse(value));
    expect(sessions[1]).toEqual(sessions[0]);
    expect(mocks.store).toHaveBeenCalledOnce();
  });

  it('removes a failed item without discarding a successful one and submits only that successful key', async () => {
    mocks.store.mockRejectedValueOnce(new Error('Quota')).mockResolvedValueOnce('stable-exercises');
    await renderHome();
    await selectFiles([file('notes.txt'), file('exercises.txt')]);
    await click(button('toolbar.removeCourseMaterial', row('notes.txt')));
    expect(document.querySelectorAll('[data-upload-status]')).toHaveLength(1);
    await click(startButton());
    expect(JSON.parse(sessionStorage.getItem('generationSession')!).documentSources).toEqual([
      expect.objectContaining({ storageKey: 'stable-exercises', order: 1 }),
    ]);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.store).toHaveBeenCalledTimes(2);
  });

  it('waits for an in-flight write before removing its blob, with no late resurrection', async () => {
    const pending = deferred<string>();
    mocks.store.mockReturnValueOnce(pending.promise);
    await renderHome();
    await selectFiles([file('notes.txt')]);
    await click(button('toolbar.removeCourseMaterial', row('notes.txt')));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(startButton().disabled).toBe(true);
    await act(async () => pending.resolve('late-notes'));
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('late-notes');
    expect(document.querySelectorAll('[data-upload-status]')).toHaveLength(0);
    expect(startButton().disabled).toBe(false);
  });

  it('finishes removing a pending file even when that upload subsequently fails', async () => {
    const pending = deferred<string>();
    mocks.store.mockReturnValueOnce(pending.promise);
    await renderHome();
    await selectFiles([file('notes.txt')]);
    await click(button('toolbar.removeCourseMaterial', row('notes.txt')));
    await act(async () => pending.reject(new Error('Aborted write')));
    expect(document.querySelectorAll('[data-upload-status]')).toHaveLength(0);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('preserves a failed removal for explicit retry and does not call it successful', async () => {
    mocks.store.mockResolvedValueOnce('stable-notes');
    mocks.remove.mockRejectedValueOnce(new Error('Delete blocked'));
    await renderHome();
    await selectFiles([file('notes.txt')]);
    await click(button('toolbar.removeCourseMaterial', row('notes.txt')));
    expect(row('notes.txt').textContent).toContain('Delete blocked');
    expect(startButton().disabled).toBe(true);
    await click(button('toolbar.removeCourseMaterial', row('notes.txt')));
    expect(mocks.remove.mock.calls).toEqual([['stable-notes'], ['stable-notes']]);
    expect(document.querySelectorAll('[data-upload-status]')).toHaveLength(0);
  });

  it('does not automatically retry a failed cache deletion after switching document providers', async () => {
    mocks.settings.pdfProviderId = 'mineru';
    mocks.store.mockResolvedValueOnce('stable-pdf');
    mocks.remove.mockRejectedValueOnce(new Error('Delete blocked'));
    await renderHome();
    await selectFiles([new File(['pdf'], 'notes.pdf', { type: 'application/pdf' })]);
    expect(row('notes.pdf').dataset.uploadStatus).toBe('completed');
    mocks.settings.pdfProviderId = 'plain-text';
    await act(async () => root!.render(createElement(StrictMode, null, createElement(Page))));
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('stable-pdf');
    expect(row('notes.pdf').textContent).toContain('Delete blocked');
    await click(button('toolbar.removeCourseMaterial', row('notes.pdf')));
    expect(mocks.remove).toHaveBeenCalledTimes(2);
  });

  it('cleans up both completed and late uploads on unmount without a second delete for a pending removal', async () => {
    const uploading = deferred<string>();
    const deleting = deferred<void>();
    mocks.store.mockResolvedValueOnce('stable-notes').mockReturnValueOnce(uploading.promise);
    mocks.remove.mockReturnValueOnce(deleting.promise);
    await renderHome();
    await selectFiles([file('notes.txt'), file('exercises.txt')]);
    await click(button('toolbar.removeCourseMaterial', row('notes.txt')));
    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => {
      uploading.resolve('late-exercises');
      deleting.resolve();
    });
    expect(mocks.remove.mock.calls).toEqual([['stable-notes'], ['late-exercises']]);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('generationSession')).toBeNull();
    expect(localStorage.getItem('requirementDraft')).toBe(JSON.stringify('Learn fractions'));
  });

  it('deduplicates file selection and drop in one event batch, including under StrictMode', async () => {
    const pending = deferred<string>();
    mocks.store.mockReturnValue(pending.promise);
    await renderHome();
    const material = file('notes.txt');
    const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
    const dropZone = document.querySelector('button.border-dashed')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [material] });
    const drop = new Event('drop', { bubbles: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [material] } });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      dropZone.dispatchEvent(drop);
    });
    expect(mocks.store).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('[data-upload-status]')).toHaveLength(1);
    await act(async () => pending.resolve('stable-notes'));
  });

  it('blocks keyboard submission while uploading instead of submitting a partial or empty source list', async () => {
    const pending = deferred<string>();
    mocks.store.mockReturnValueOnce(pending.promise);
    await renderHome();
    await selectFiles([file('notes.txt')]);
    await act(async () =>
      container
        .querySelector('textarea')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
        ),
    );
    expect(mocks.push).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('generationSession')).toBeNull();
    expect(startButton().getAttribute('aria-busy')).toBe('false');
    await act(async () => pending.resolve('stable-notes'));
  });

  it('allows starting with no materials and never writes learning state or calls an upstream', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Unexpected upstream');
    });
    vi.stubGlobal('fetch', fetch);
    await renderHome();
    await click(startButton());
    expect(
      JSON.parse(sessionStorage.getItem('generationSession')!).documentSources,
    ).toBeUndefined();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const { getRuntimeStore } = await import('@/lib/runtime/store');
    const { getLearnerKey } = await import('@/lib/runtime/learner-key');
    expect(getRuntimeStore).not.toHaveBeenCalled();
    expect(getLearnerKey).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('persists real bytes in IndexedDB and transfers the readable key to the generation session without rewriting it', async () => {
    const storage = await vi.importActual<typeof import('@/lib/utils/image-storage')>(
      '@/lib/utils/image-storage',
    );
    const stored = deferred<string>();
    mocks.store.mockImplementation(async (material) => {
      const key = await storage.storeDocumentBlob(material);
      stored.resolve(key);
      return key;
    });
    mocks.remove.mockImplementation(storage.deleteDocumentBlob);
    const material = file('notes.txt');
    // jsdom File lacks arrayBuffer; browser File implements it. Keep the real
    // storage path and supply only that missing platform method for these bytes.
    Object.defineProperty(material, 'arrayBuffer', {
      value: async () => new TextEncoder().encode('fractions').buffer,
    });
    await renderHome();
    await selectFiles([material]);
    let key = '';
    await act(async () => {
      key = await stored.promise;
    });
    expect(row('notes.txt').dataset.uploadStatus).toBe('completed');
    await click(startButton());
    expect(
      JSON.parse(sessionStorage.getItem('generationSession')!).documentSources[0].storageKey,
    ).toBe(key);
    await act(async () => root!.unmount());
    root = undefined;
    const blob = await storage.loadDocumentBlob(key);
    expect(blob?.type).toBe('text/plain');
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob!);
    });
    expect(text).toBe('fractions');
    expect(mocks.store).toHaveBeenCalledOnce();
    expect(mocks.remove).not.toHaveBeenCalled();
    await storage.deleteDocumentBlob(key);
    expect(await storage.loadDocumentBlob(key)).toBeNull();
    const { db } = await import('@/lib/utils/database');
    db.close();
  });
});

describe('homepage learning entry', () => {
  it('keeps the brand, teacher and single learning entry together in the classroom hero', async () => {
    await act(async () => root!.render(createElement(StrictMode, null, createElement(Page))));
    const hero = container.querySelector('main > #new-lesson')!;
    expect(hero.getAttribute('aria-labelledby')).toBe('home-title');
    expect(hero.querySelector('.lc-home-brand')?.textContent).toBe('LiveCourse');
    expect(hero.querySelector('h1')?.textContent).toBe('home.heroTitle');
    expect(hero.querySelectorAll('aside')).toHaveLength(1);
    expect(hero.querySelector('[data-testid="teacher-poster"]')).not.toBeNull();
    expect(hero.querySelectorAll('textarea')).toHaveLength(1);
    expect(hero.querySelectorAll('[data-testid="start-generation"]')).toHaveLength(1);
    expect(container.querySelector('#recent-classrooms')?.parentElement).toBe(hero.parentElement);
  });

  it('labels the goal, explains the next step and exposes upload without opening a menu', async () => {
    await act(async () => root!.render(createElement(StrictMode, null, createElement(Page))));
    const textarea = container.querySelector('textarea')!;
    expect(container.querySelector('label')?.htmlFor).toBe(textarea.id);
    expect(textarea.getAttribute('aria-describedby')).toBe('goal-next-step');
    expect(container.querySelector('#goal-next-step')?.textContent).toBe('home.nextStepHint');
    expect(button('toolbar.courseMaterialUpload', container).textContent).toContain(
      'toolbar.courseMaterialUpload',
    );
    expect(container.querySelectorAll('[data-testid="start-generation"]')).toHaveLength(1);
    expect(startButton().disabled).toBe(true);
    expect(container.querySelectorAll('button[aria-label="settings.title"]')).toHaveLength(1);
  });

  it('keeps model selection out of the prompt composer', async () => {
    await act(async () => root!.render(createElement(StrictMode, null, createElement(Page))));
    await act(async () => Promise.resolve());
    expect(container.querySelector('[data-testid="home-model-picker"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="home-prompt-toolbar"]')?.textContent,
    ).not.toContain('toolbar.configureProvider');
    expect(container.querySelector('button[aria-label*=" / "]')).toBeNull();
    expect(container.querySelector('[data-testid="configure-model-hint"]')).toBeNull();
  });

  it('points missing class models to Settings instead of the composer', async () => {
    mocks.settings.providersConfig = {
      local: { name: 'Local', isServerConfigured: false, models: [] },
    };
    await act(async () => root!.render(createElement(StrictMode, null, createElement(Page))));
    await act(async () => Promise.resolve());
    const hint = container.querySelector('[data-testid="configure-model-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('home.configureModelHint');
    expect(
      container.querySelector('[data-testid="home-prompt-toolbar"]')?.textContent,
    ).not.toContain('toolbar.configureProvider');
  });

  it('fills and focuses the existing goal textbox from examples without submitting', async () => {
    await act(async () => root!.render(createElement(StrictMode, null, createElement(Page))));
    await act(async () => Promise.resolve());
    const textarea = container.querySelector('textarea');
    const examples = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="goal-example"]'),
    ];
    expect(examples).toHaveLength(3);
    await act(async () => examples[0].click());
    expect(textarea?.value).toBe('home.exampleGoal1');
    expect(document.activeElement).toBe(textarea);
    expect(startButton().disabled).toBe(false);
    expect(mocks.push).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(localStorage.getItem('requirementDraft')).toBe(JSON.stringify('home.exampleGoal1')),
    );
    expect(container.querySelector('[data-testid="recent-empty-shelf"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="start-generation"]')).not.toBeNull();
  });

  it('returns from the empty recent shelf to the goal without losing the draft', async () => {
    await renderHome();
    const scrollIntoView = vi.fn();
    container.querySelector('#new-lesson')!.scrollIntoView = scrollIntoView;
    await click(button('home.recentEmptyAction', container));
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(container.querySelector('textarea'));
    expect(container.querySelector('textarea')?.value).toBe('Learn fractions');
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
