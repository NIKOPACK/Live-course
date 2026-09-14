import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AIRI_SAMPLE_MODEL_URL =
  'https://dist.ayaka.moe/vrm-models/VRoid-Hub/AvatarSample-A/AvatarSample_A.vrm';
const MODEL_CACHE_CONTROL =
  'public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000';
const UPSTREAM_TIMEOUT_MS = 60_000;
const DEFAULT_DISK_MIN_BYTES = 1_000_000;

export const runtime = 'nodejs';

interface CachedModel {
  body: ArrayBuffer;
  headers: Record<string, string>;
}

// Self-hosted deployments (systemd/Docker) have no edge cache honoring
// Cache-Control, so every request would otherwise re-fetch this ~26MB file
// from the upstream CDN. Keep an in-process copy and a disk copy so a
// process restart (deploy) does not wait on the CDN again.
let cachedModel: CachedModel | null = null;
let inFlightFetch: Promise<CachedModel | null> | null = null;

function configuredDiskCachePath(): string | null {
  const configured = process.env.LIVECOURSE_AVATAR_CACHE_PATH?.trim();
  return configured || null;
}

function defaultDiskCachePath(): string {
  return path.join(os.homedir(), '.cache', 'livecourse', 'AvatarSample_A.vrm');
}

function diskCachePath(): string {
  return configuredDiskCachePath() ?? defaultDiskCachePath();
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

async function readDiskCache(): Promise<CachedModel | null> {
  try {
    const file = diskCachePath();
    const body = await fs.readFile(file);
    const minBytes = configuredDiskCachePath() ? 1 : DEFAULT_DISK_MIN_BYTES;
    if (body.byteLength < minBytes) return null;
    return {
      body: bufferToArrayBuffer(body),
      headers: {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': String(body.byteLength),
      },
    };
  } catch {
    return null;
  }
}

async function writeDiskCache(model: CachedModel): Promise<void> {
  const minBytes = configuredDiskCachePath() ? 1 : DEFAULT_DISK_MIN_BYTES;
  if (model.body.byteLength < minBytes) return;
  try {
    const file = diskCachePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(model.body));
  } catch {
    // Best-effort: a read-only runtime still has the in-process cache.
  }
}

function upstreamError(): Response {
  return Response.json(
    {
      error: {
        code: 'AVATAR_MODEL_UPSTREAM_ERROR',
        message: 'The 3D teacher model is unavailable',
      },
    },
    { status: 502, headers: { 'Cache-Control': 'no-store' } },
  );
}

async function fetchModel(): Promise<CachedModel | null> {
  try {
    const upstream = await fetch(AIRI_SAMPLE_MODEL_URL, {
      headers: { Accept: 'model/gltf-binary, application/octet-stream' },
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok || !upstream.body) return null;

    const headers: Record<string, string> = {
      'Content-Type': upstream.headers.get('Content-Type') || 'model/gltf-binary',
    };
    for (const name of ['ETag', 'Last-Modified']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }

    const body = await upstream.arrayBuffer();
    headers['Content-Length'] = String(body.byteLength);
    return { body, headers };
  } catch (error) {
    console.error('AIRI avatar model proxy failed', error);
    return null;
  }
}

export async function GET(): Promise<Response> {
  if (!cachedModel) {
    cachedModel = await readDiskCache();
  }
  if (!cachedModel) {
    if (!inFlightFetch) {
      inFlightFetch = fetchModel()
        .then(async (result) => {
          if (result) await writeDiskCache(result);
          return result;
        })
        .finally(() => {
          inFlightFetch = null;
        });
    }
    const result = await inFlightFetch;
    if (!result) return upstreamError();
    cachedModel = result;
  }

  const headers = new Headers({
    'Cache-Control': MODEL_CACHE_CONTROL,
    'Content-Disposition': 'inline; filename="AvatarSample_A.vrm"',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    ...cachedModel.headers,
  });

  return new Response(cachedModel.body, { status: 200, headers });
}
