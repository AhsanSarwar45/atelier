/**
 * The words the app puts on a moment.
 *
 * Three of them, and they build on each other: the day, the clock, and the two
 * together for a place that has no day heading over it to lean on. They lived
 * in the chat rail, which is the only screen that had a use for them — until
 * the tray needed to say when a notification appeared (bw-zvgc), and importing
 * the whole rail into the shell's bar to borrow two lines of date formatting
 * would have been the wrong trade. Here they belong to neither screen.
 */

/**
 * One formatter each, made once. `toLocaleDateString` builds a new formatter
 * on every call, and the chat rail asks for a heading per row on every redraw.
 * Made on first use, so a test that sets the clock's zone still gets it.
 */
let dayFormat: Intl.DateTimeFormat | undefined;
let clockFormat: Intl.DateTimeFormat | undefined;

/** Today, Yesterday, then the date itself. */
export function dayHeading(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(then)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  dayFormat ??= new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  return dayFormat.format(then);
}

/**
 * The clock alone. In the rail the day is already the heading above the row,
 * and a full date in a 288px rail is cut off mid-year, which tells the owner
 * nothing.
 */
export function clockTime(iso: string): string {
  clockFormat ??= new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  return clockFormat.format(new Date(iso));
}

/**
 * When a notification appeared, for a tray with no headings in it.
 *
 * The clock on its own for today, which is nearly every row and the case worth
 * keeping short, and the day in front of it otherwise. Not "5 minutes ago": a
 * tray sits open on a phone for as long as the owner leaves it there, and a
 * relative word is wrong the moment it is drawn unless something keeps
 * redrawing it. A clock time is true whenever it is read.
 */
export function whenItAppeared(iso: string, now = new Date()): string {
  const day = dayHeading(iso, now);
  return day === 'Today' ? clockTime(iso) : `${day} ${clockTime(iso)}`;
}
