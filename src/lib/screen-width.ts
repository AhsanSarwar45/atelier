/**
 * What the app calls a phone, in one place.
 *
 * The boundary is Tailwind's `md` (768px), which is where every phone sheet in
 * the app already switches: the chat's two rails, the Files tab's tree, and the
 * agent-files browser's own two columns are all written `md:`. It used to say
 * `sm` (640px) here while the CSS said `md`, so between 640 and 767 a rail
 * decided by this file that it was on a wide screen and defaulted itself OPEN,
 * and the CSS then drew it as a fixed sheet over the reading — the app holding
 * two answers to one question (bw-e3dw.9).
 *
 * `md` is also the only stop that clears the Files tab's arithmetic: a 288px
 * rail beside a 320px minimum viewer needs 608px before both can be honoured.
 *
 * Anything asking "is this a phone" asks here. The case beside this file fails
 * a source file that reaches for `matchMedia` with a width of its own.
 */
export const PHONE_SCREEN = '(max-width: 767px)';
export const NOT_PHONE_SCREEN = '(min-width: 768px)';

export function isPhoneScreen(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(PHONE_SCREEN).matches);
}
