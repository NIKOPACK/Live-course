import { afterEach, expect, it, vi } from 'vitest';
import { version } from '@/package.json';

vi.mock('@/lib/server/provider-config', () => ({
  getServerWebSearchProviders: () => ({}),
  getServerImageProviders: () => ({}),
  getServerVideoProviders: () => ({}),
  getServerTTSProviders: () => ({}),
}));

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, '0.0.0'])(
  'reports the built package version when npm metadata is %s',
  async (npmVersion) => {
    vi.resetModules();
    vi.stubEnv('npm_package_version', npmVersion);
    const { GET } = await import('@/app/api/health/route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      status: 'ok',
      version,
      capabilities: {
        webSearch: false,
        imageGeneration: false,
        videoGeneration: false,
        tts: false,
      },
    });
  },
);
