/** The phone breakpoint shared with Tailwind's `sm` boundary. */
export const PHONE_SCREEN = '(max-width: 639px)';
export const NOT_PHONE_SCREEN = '(min-width: 640px)';

export function isPhoneScreen(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(PHONE_SCREEN).matches);
}

