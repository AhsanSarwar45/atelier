'use client';

import { useCallback, useEffect, useState } from 'react';

import { subscribeThisDevice, unsubscribeThisDevice } from '@/workbench/device-push';

export interface NotificationPreferences { needsAction: boolean; updates: boolean; device: boolean }
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = { needsAction: true, updates: true, device: false };
const KEY = 'atelier.notification-preferences.v1';

export function readNotificationPreferences(): NotificationPreferences {
  if (typeof window === 'undefined') return DEFAULT_NOTIFICATION_PREFERENCES;
  try { return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; }
  catch { return DEFAULT_NOTIFICATION_PREFERENCES; }
}

export function useNotificationPreferences() {
  const [preferences, setPreferences] = useState(DEFAULT_NOTIFICATION_PREFERENCES);
  useEffect(() => setPreferences(readNotificationPreferences()), []);
  const save = useCallback((next: NotificationPreferences) => {
    localStorage.setItem(KEY, JSON.stringify(next));
    setPreferences(next);
    window.dispatchEvent(new CustomEvent('atelier-notification-preferences', { detail: next }));
  }, []);
  useEffect(() => {
    const changed = (event: Event) => setPreferences((event as CustomEvent<NotificationPreferences>).detail);
    window.addEventListener('atelier-notification-preferences', changed);
    return () => window.removeEventListener('atelier-notification-preferences', changed);
  }, []);
  return { preferences, save };
}

/**
 * What turning device notifications on achieved. `pushing` is the part that
 * matters on a phone: false means notifications still only arrive while a
 * window is open, because the server has no push keys or the browser has no
 * push service (bw-ndlu.3).
 */
export interface DeviceNotificationResult { permission: NotificationPermission; pushing: boolean }

export async function enableDeviceNotifications(preferences: NotificationPreferences): Promise<DeviceNotificationResult> {
  if (!('Notification' in window)) return { permission: 'denied', pushing: false };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted' || !('serviceWorker' in navigator)) return { permission, pushing: false };
  await navigator.serviceWorker.register('/notification-worker.js');
  // A device that cannot be pushed to is still worth having registered: the
  // open page draws through the same worker.
  const pushing = await subscribeThisDevice({ ...preferences, device: true }).catch(() => false);
  return { permission, pushing };
}

/** Stop this device being pushed to, without touching the browser permission. */
export async function disableDeviceNotifications(): Promise<void> {
  await unsubscribeThisDevice().catch(() => undefined);
}

/**
 * Keep the server's copy of what this device wants to hear about in step with
 * the checkboxes. Does nothing when this device was never subscribed.
 */
export async function resendDevicePreferences(preferences: NotificationPreferences): Promise<void> {
  if (!preferences.device) return;
  await subscribeThisDevice(preferences).catch(() => undefined);
}

export async function showDeviceNotification(title: string, body: string, href: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, { body, icon: '/icon-192.png', tag: href, data: { href } });
  } else new Notification(title, { body, icon: '/icon-192.png', tag: href });
}
