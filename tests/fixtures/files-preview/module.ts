/** A fixture with enough grammar in it to be worth highlighting. */
export const GREETING = 'hello';

export function greet(name: string): string {
  if (!name) return GREETING;
  return `${GREETING}, ${name}`;
}
