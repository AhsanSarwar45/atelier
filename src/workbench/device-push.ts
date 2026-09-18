'use client';

/**
 * Signing this device up to be pushed to.
 *
 * Drawing a notification from the open page only works while the page is
 * open, which on a phone means "for a few seconds after you look away". So
 * the browser's own push service is told where to reach this device, the
 * server keeps that address, and the notification is sent to it whether or
 * not any window survives (bw-ndlu.3).
 */

import { request } from '@/lib/api';
import type { NotificationPreferences } from '@/workbench/notification-preferences';

/** What the server stores to be able to reach one browser on one device. */
export interface PushRegistration {
  endpoint: string;
  p256dh: string;
  auth: string;
  needsAction: boolean;
  updates: boolean;
}

/**
 * A VAPID key travels as base64url and `applicationServerKey` wants bytes.
 * `atob` only reads standard base64, so the two swapped characters are put
 * back and the padding the encoder dropped is restored.
 */
export function vapidKeyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(padded);
  // Built on an ArrayBuffer of its own rather than with `Uint8Array.from`,
  // because `applicationServerKey` will not take a view that might be sitting
  // on shared memory.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The two per-subscription secrets, as base64url, which is how they are sent. */
function keysOf(subscription: PushSubscription): { p256dh: string; auth: string } {
  const encode = (name: 'p256dh' | 'auth') => {
    const key = subscription.getKey(name);
    if (!key) throw new Error(`the push subscription carries no ${name} key`);
    return btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return { p256dh: encode('p256dh'), auth: encode('auth') };
}

export function canPush(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

/**
 * Subscribe this device and tell the server where it lives.
 *
 * Returns false when the server has no push keys configured, which is not an
 * error: the app still draws notifications from the open page, and the
 * settings screen says so.
 */
export async function subscribeThisDevice(preferences: NotificationPreferences): Promise<boolean> {
  if (!canPush()) return false;

  const answer = await request('/api/push/key');
  if (!answer.ok) return false;
  const { key } = (await answer.json()) as { key: string | null };
  if (!key) return false;

  const registration = await navigator.serviceWorker.ready;
  // An existing subscription made against a different key can never be
  // decrypted by this server, so it is replaced rather than reused.
  const existing = await registration.pushManager.getSubscription();
  const wanted = vapidKeyToBytes(key);
  if (existing) {
    const sameKey = existing.options.applicationServerKey
      && new Uint8Array(existing.options.applicationServerKey).every((b, i) => b === wanted[i]);
    if (!sameKey) await existing.unsubscribe();
  }

  const subscription = (await registration.pushManager.getSubscription())
    ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted }));

  const body: PushRegistration = {
    endpoint: subscription.endpoint,
    ...keysOf(subscription),
    needsAction: preferences.needsAction,
    updates: preferences.updates,
  };
  const stored = await request('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return stored.ok;
}

/** Tell the server to stop pushing here, and drop the browser's subscription. */
export async function unsubscribeThisDevice(): Promise<void> {
  if (!canPush()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await request('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => undefined);
  await subscription.unsubscribe();
}
