import { cn } from '~/utils';

export default function GoogleMinimalIcon({ className = '' }: { className?: string }) {
  return (
    <img
      src="/assets/google-icon.svg"
      alt="Google Icon"
      className={cn('h-4 w-4', className)}
    />
  );
}