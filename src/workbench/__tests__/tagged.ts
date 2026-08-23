/**
 * One frame as the app's one connection carries it.
 *
 * A window holds a single socket and every feed arrives on it, each frame
 * naming the feed it came from (src/workbench/live-wire.ts,
 * server/src/routes/live.rs). This is that envelope, so the fake connections
 * in these cases speak the shape the real server speaks rather than each
 * spelling it out again.
 */
export function tagged(tag: string, data: string): { data: string } {
  return { data: JSON.stringify({ tag, data }) };
}
