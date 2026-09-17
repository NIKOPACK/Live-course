import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteStageData: vi.fn(),
  listStages: vi.fn(),
}));

vi.mock('@/lib/utils/stage-storage', () => ({
  deleteStageData: mocks.deleteStageData,
  listStages: mocks.listStages,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  deleteUserClassroom,
  ShowcaseClassroomDeleteError,
} from '@/lib/classroom/delete-user-classroom';

describe('deleteUserClassroom', () => {
  beforeEach(() => {
    mocks.deleteStageData.mockReset().mockResolvedValue(undefined);
    mocks.listStages.mockReset().mockResolvedValue([]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 } satisfies Pick<Response, 'ok' | 'status'>),
    );
  });

  it('refuses the showcase id before any network or local cascade', async () => {
    await expect(deleteUserClassroom('fourier-intro')).rejects.toBeInstanceOf(
      ShowcaseClassroomDeleteError,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.deleteStageData).not.toHaveBeenCalled();
  });

  it('treats DELETE 404 as server success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);
    await expect(deleteUserClassroom('stage-local-only')).resolves.toBeUndefined();
    expect(mocks.deleteStageData).toHaveBeenCalledExactlyOnceWith('stage-local-only');
  });

  it('does not run the local cascade when DELETE is 500', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);
    await expect(deleteUserClassroom('stage-1')).rejects.toThrow(/DELETE \/api\/classroom failed: 500/);
    expect(mocks.deleteStageData).not.toHaveBeenCalled();
  });

  it('fails and keeps the session caller-visible when the document is still listed', async () => {
    mocks.deleteStageData.mockRejectedValueOnce(new Error('locked'));
    mocks.listStages.mockResolvedValueOnce([{ id: 'stage-1' }]);
    await expect(deleteUserClassroom('stage-1')).rejects.toThrow('locked');
  });

  it('succeeds when deleteStageData throws after the document left the list', async () => {
    mocks.deleteStageData.mockRejectedValueOnce(new Error('partial cascade'));
    mocks.listStages.mockResolvedValueOnce([]);
    await expect(deleteUserClassroom('stage-1')).resolves.toBeUndefined();
  });
});
