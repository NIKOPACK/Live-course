import { cn } from '@/lib/utils';

interface LiveCourseMarkProps {
  readonly className?: string;
  readonly showLabel?: boolean;
  readonly size?: 'compact' | 'hero';
  readonly dark?: boolean;
}

export function LiveCourseMark({
  className,
  showLabel = true,
  size = 'compact',
  dark = false,
}: LiveCourseMarkProps) {
  if (!showLabel) return null;

  const hero = size === 'hero';

  return (
    <span className={cn('inline-flex items-center gap-2.5', className)} aria-label="LiveCourse">
      <span
        className={cn(
          'font-semibold tracking-normal',
          hero ? 'text-4xl md:text-5xl' : 'text-base',
          dark ? 'text-white' : 'text-slate-900 dark:text-white',
        )}
      >
        Live
        <span className={dark ? 'text-teal-200' : 'text-primary'}>Course</span>
      </span>
    </span>
  );
}
