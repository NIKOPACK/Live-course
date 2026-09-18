import { describe, expect, it } from 'vitest';
import { selectClassroomRealtimeTransport } from '@/lib/livecourse/realtime/client/select-transport';

describe('selectClassroomRealtimeTransport', () => {
  it('prefers server-configured Volc over the OpenAI default id', () => {
    expect(
      selectClassroomRealtimeTransport({
        realtimeProvidersConfig: {
          openai: { apiKey: '' },
          volc: { isServerConfigured: true, apiKey: '' },
        },
      }),
    ).toBe('volc');
  });

  it('does not fall through to OpenAI Realtime when only Volc is missing', () => {
    expect(
      selectClassroomRealtimeTransport({
        realtimeProvidersConfig: {
          openai: { apiKey: '', isServerConfigured: false },
          volc: { apiKey: '', isServerConfigured: false },
        },
      }),
    ).toBeNull();
  });

  it('uses OpenAI when that channel has a key or server config', () => {
    expect(
      selectClassroomRealtimeTransport({
        realtimeProvidersConfig: {
          openai: { isServerConfigured: true },
          volc: {},
        },
      }),
    ).toBe('openai');
  });
});
