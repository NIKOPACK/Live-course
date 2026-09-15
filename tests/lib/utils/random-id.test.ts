import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserUuid } from '@/lib/utils/random-id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('createBrowserUuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a UUID when crypto.randomUUID is missing (HTTP / sandboxed iframe)', () => {
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = i + 1;
        return bytes;
      },
    });
    expect(createBrowserUuid()).toMatch(UUID_RE);
  });

  it('does not throw when randomUUID is present but not a function', () => {
    vi.stubGlobal('crypto', {
      randomUUID: undefined,
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(7);
        return bytes;
      },
    });
    expect(() => createBrowserUuid()).not.toThrow();
    expect(createBrowserUuid()).toMatch(UUID_RE);
  });
});
