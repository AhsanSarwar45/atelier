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
    ? 'This browser does not support notifications.'
    : permission === 'denied'
      ? 'Notifications are blocked in this browser’s site settings.'
      : preferences.device
        ? pushing
          ? 'Enabled on this device, including while Atelier is closed.'
          : 'Enabled on this device, while an Atelier window is open.'
        : 'Show notifications outside the Atelier window.';

  return <>
    <SettingsGroup title="Notify me about" description="Choose what appears in the bell and reaches this device.">
      <SettingRow label="Needs action" description="Permission requests and chats that stopped with an error." htmlFor="notify-action">
        <Checkbox id="notify-action" checked={preferences.needsAction} onCheckedChange={(v) => choose('needsAction', v === true)} />
      </SettingRow>
      <SettingRow label="Other updates" description="Chats that finished and are ready to read." htmlFor="notify-updates">
        <Checkbox id="notify-updates" checked={preferences.updates} onCheckedChange={(v) => choose('updates', v === true)} />
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup title="Desktop and mobile" description="Delivery is configured separately on each device.">
      <SettingRow label="Device notifications" description={deviceDescription}>
        <Button
          size="sm"
          data-testid="enable-device-notifications"
          variant={preferences.device ? 'outline' : 'primary'}
          disabled={busy || permission === 'unsupported' || permission === 'denied'}
          onClick={() => void device()}
        >{preferences.device ? 'Enabled' : 'Enable'}</Button>
      </SettingRow>
      <SettingRow label="Use on a phone" description="Open Atelier in your mobile browser, add it to your home screen, then enable device notifications here. On iOS the home screen step is required before a browser will offer notifications at all." />
    </SettingsGroup>
  </>;
}
