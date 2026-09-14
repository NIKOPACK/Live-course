import { cn } from '@/lib/utils';

interface GameLoaderProps {
  readonly label?: string;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
}

const SIZE_PX = { sm: 16, md: 24, lg: 32 } as const;

export function GameLoader({ label, size = 'md', className }: GameLoaderProps) {
  const labelled = Boolean(label);
  const px = SIZE_PX[size];

  return (
    <span
      data-testid="game-loader"
      data-size={size}
      role={labelled ? 'status' : 'presentation'}
      aria-busy={labelled ? true : undefined}
      aria-live={labelled ? 'polite' : undefined}
      aria-hidden={labelled ? undefined : true}
      className={cn(
        'inline-flex items-center justify-center gap-2',
        size !== 'sm' && 'flex-col gap-3',
        className,
      )}
    >
      <svg
        className={cn('lc-loader shrink-0', size === 'sm' ? '' : 'text-primary')}
        style={{ width: px, height: px }}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle className="lc-loader-track" cx="12" cy="12" r="9" strokeWidth="2.5" />
        <g className="lc-loader-rotor">
          <circle
            className="lc-loader-arc"
            cx="12"
            cy="12"
            r="9"
            strokeWidth="2.5"
            pathLength={100}
            strokeDasharray="32 68"
          />
        </g>
        <circle className="lc-loader-core" cx="12" cy="12" r="2.4" />
      </svg>
      {label ? (
        <span className="text-center text-sm leading-6 text-muted-foreground">{label}</span>
      ) : null}
    </span>
  );
}
