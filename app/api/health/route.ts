import { apiSuccess } from '@/lib/server/api-response';
import { version } from '@/package.json';
import {
  getServerWebSearchProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
} from '@/lib/server/provider-config';

export async function GET() {
  return apiSuccess({
    status: 'ok',
    version,
    capabilities: {
      webSearch: Object.keys(getServerWebSearchProviders()).length > 0,
      imageGeneration: Object.keys(getServerImageProviders()).length > 0,
      videoGeneration: Object.keys(getServerVideoProviders()).length > 0,
      tts: Object.values(getServerTTSProviders()).some((info) => !info.disabled),
    },
  });
}
