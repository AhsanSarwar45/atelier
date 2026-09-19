'use client';

import { useEffect, useState } from 'react';

import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  disableDeviceNotifications,
  enableDeviceNotifications,
  resendDevicePreferences,
  useNotificationPreferences,
} from '@/workbench/notification-preferences';

export function NotificationSettings() {
  const { preferences, save } = useNotificationPreferences();
  // The screens are built ahead of time, so the first render happens with no
  // browser at all and every one of these questions answers "no". Asking again
  // once mounted is what stops the button being drawn permanently disabled on
  // a browser that supports notifications perfectly well (bw-ndlu.3).
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('unsupported');
  useEffect(() => setPermission('Notification' in window ? Notification.permission : 'unsupported'), []);
  // Whether this device is signed up to be pushed to, which is the difference
  // between a notification arriving with the app closed and one arriving only
  // while a window is open (bw-ndlu.3).
  const [pushing, setPushing] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = (key: 'needsAction' | 'updates', checked: boolean) => {
    const next = { ...preferences, [key]: checked };
    save(next);
    // The server pushes by what it was last told, so the checkboxes have to
    // reach it too, not only this browser's storage.
    void resendDevicePreferences(next);
  };

  const device = async () => {
    setBusy(true);
    try {
      if (preferences.device) {
        await disableDeviceNotifications();
        setPushing(false);
        save({ ...preferences, device: false });
        return;
      }
      const { permission: next, pushing: subscribed } = await enableDeviceNotifications(preferences);
      setPermission(next);
      setPushing(subscribed);
      save({ ...preferences, device: next === 'granted' });
    } finally {
      setBusy(false);
    }
  };

  const deviceDescription = permission === 'unsupported'
    ? 'Not supported by this browser'
    : permission === 'denied'
      ? 'Blocked in this browser’s site settings'
      : preferences.device
        ? pushing
          ? 'On, even when Atelier is closed'
          : 'On while an Atelier window is open'
        : 'Show outside the Atelier window';

  return <>
    <SettingsGroup title="Notifications">
      <SettingRow label="Needs action" description="Permission requests and errors" htmlFor="notify-action">
        <Checkbox id="notify-action" checked={preferences.needsAction} onCheckedChange={(v) => choose('needsAction', v === true)} />
      </SettingRow>
      <SettingRow label="Other updates" description="Chats that finished" htmlFor="notify-updates">
        <Checkbox id="notify-updates" checked={preferences.updates} onCheckedChange={(v) => choose('updates', v === true)} />
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title="This device">
      <SettingRow label="Device notifications" description={deviceDescription}>
        <Button
          size="sm"
          data-testid="enable-device-notifications"
          variant={preferences.device ? 'outline' : 'primary'}
          disabled={busy || permission === 'unsupported' || permission === 'denied'}
          onClick={() => void device()}
        >{preferences.device ? 'Enabled' : 'Enable'}</Button>
      </SettingRow>
      <SettingRow label="Mobile notifications" description="Add Atelier to your home screen, then enable notifications" />
    </SettingsGroup>
  </>;
}
