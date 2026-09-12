/**
 * Where an attachment's bytes live, and how they get there.
 *
 * An attachment used to travel as a base64 `dataUrl` inside the event log. That
 * is fine for a screenshot and ruinous for anything else: the log is what every
 * browser is handed on every snapshot, and it is kept for the life of the chat,
 * so one video would be re-sent in full on every reconnect and stored forever.
 *
 * So the bytes are kept once, in the same content-addressed store the app's own
 * presentation media uses, and the message carries only the name they were kept
 * under. That name is also a real file on disk, which is what lets the agent be
 * handed the file itself rather than a copy of it (bw-oamr.5).
 */
import { request } from '@/lib/api';
import { apiUrl } from '@/lib/api-base';
import type { ImagePayload } from '@/workbench/protocol';

/** Where the store answers for one kept file. */
export function presentationAssetUrl(asset: string): string {
  return apiUrl(`/api/presentation-assets/${encodeURIComponent(asset)}`);
}

/**
 * Where to point at an attachment's bytes.
 *
 * A kept file is fetched from the store; anything written before this — or a
 * picture still being read in the writing box, before its upload has answered —
 * still carries its own bytes and is used as it stands.
 */
export function attachmentSrc(image: Pick<ImagePayload, 'dataUrl'> & { asset?: string }): string {
  return image.asset ? presentationAssetUrl(image.asset) : image.dataUrl;
}

/** How long one file may take to reach the store before it is given up on. */
const UPLOAD_DEADLINE_MS = 5 * 60_000;

/** What the store says about a file it has just kept. */
export interface KeptFile {
  asset: string;
  size: number;
  /** Where it sits on disk, which is what the agent is given. */
  path: string;
}

/**
 * Hands one file to the store and answers with the name it was kept under.
 *
 * The bytes go up base64'd because that is the one way a browser can put them
 * in JSON, and they are read straight off the `dataUrl` that was already made
 * to show the file in the writing box — so the file is read once, not twice.
 */
export async function keepFile(name: string, dataUrl: string): Promise<KeptFile> {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error(`${name} could not be read`);
  const res = await request('/api/workbench/attachment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data: dataUrl.slice(comma + 1) }),
    // The app's usual ten seconds is a reading, not a hundred megabytes over
    // a loopback with a third again of base64 on top. This is the one read in
    // the app whose length is set by how big the thing being sent is.
    deadlineMs: UPLOAD_DEADLINE_MS,
  });
  if (!res.ok) throw new Error((await res.text()) || `${name} could not be kept`);
  return res.json();
}
