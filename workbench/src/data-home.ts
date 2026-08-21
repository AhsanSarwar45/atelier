/**
 * Where this machine keeps this program's data.
 *
 * The app is the one authority on this — `server/src/identity.rs` declares the
 * name, and asks the operating system where a program of that name files its
 * data — and it hands its answer down when it starts this helper. So the rule
 * below is only reached when the helper is started by hand, which the browser
 * checks do.
 *
 * It has to give the same answer the app would. It used to know one machine's
 * way of naming that folder and only one, so on an Apple or a Windows machine
 * the helper wrote every chat into a folder the app never reads, and the chats
 * vanished somewhere between the helper and the screen (bw-8um.3.14).
 *
 * On its own, with no database behind it, so the rule can be read and checked
 * without opening anything.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

/** The three names a machine files this program's data under. Not ours to choose. */
const QUALIFIER = 'com';
const ORGANISATION = 'weselow';
const APPLICATION = 'atelier';

/**
 * What the app said when it started this helper. The one authority, when there
 * is one to ask.
 */
export const HANDED_DOWN = 'ATELIER_DATA_DIR';

export function dataHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const said = env[HANDED_DOWN];
  if (said) return said;
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', `${QUALIFIER}.${ORGANISATION}.${APPLICATION}`);
  }
  if (platform === 'win32') {
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(roaming, ORGANISATION, APPLICATION, 'data');
  }
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), APPLICATION);
}
