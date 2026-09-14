export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Warm the ~26MB teacher VRM into memory/disk so the first homepage
  // visitor after a process start does not wait on the upstream CDN.
  const { GET } = await import('@/app/api/livecourse/avatar/model/route');
  void GET().catch(() => undefined);
}
