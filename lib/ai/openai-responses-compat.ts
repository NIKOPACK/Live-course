import { createLogger } from '@/lib/logger';

const log = createLogger('OpenAIResponsesCompat');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function normalizeResponsesMetadata(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    return response;
  }
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    log.warn('Invalid proxy JSON left unchanged for SDK error handling');
    return response;
  }
  if (!isRecord(body) || !Array.isArray(body.output)) return response;
  let repaired = 0;
  for (const item of body.output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && part.annotations === undefined) {
        part.annotations = [];
        repaired += 1;
      }
    }
  }
  if (!repaired) return response;
  log.info(`Normalized missing annotations on ${repaired} proxy output-text parts`);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
