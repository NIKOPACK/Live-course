import { cn } from '@/lib/utils';

/** Captured from the built-in VRM using the same portrait camera and lighting. */
export function TeacherAvatarPoster({ className }: { className?: string }) {
  return (
    <img
      src="/avatars/teacher-avatar-poster.png"
      alt=""
      data-testid="teacher-poster"
      className={cn(
        'pointer-events-none absolute left-1/2 top-0 h-full w-auto max-w-none -translate-x-1/2',
        className,
      )}
    />
  );
}
