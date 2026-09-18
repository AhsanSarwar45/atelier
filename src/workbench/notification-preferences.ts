'use client';

import { useCallback, useEffect, useState } from 'react';

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

export async function enableDeviceNotifications(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  const permission = await Notification.requestPermission();
  if (permission === 'granted' && 'serviceWorker' in navigator) await navigator.serviceWorker.register('/notification-worker.js');
  return permission;
}

export async function showDeviceNotification(title: string, body: string, href: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, { body, icon: '/icon-192.png', tag: href, data: { href } });
  } else new Notification(title, { body, icon: '/icon-192.png', tag: href });
}
