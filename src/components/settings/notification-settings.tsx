'use client';

import { useState } from 'react';
import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { enableDeviceNotifications, useNotificationPreferences } from '@/workbench/notification-preferences';

export function NotificationSettings() {
  const { preferences, save } = useNotificationPreferences();
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported');
  const choose = (key: 'needsAction' | 'updates', checked: boolean) => save({ ...preferences, [key]: checked });
  const device = async () => {
    const next = await enableDeviceNotifications();
    setPermission(next);
    save({ ...preferences, device: next === 'granted' });
  };
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
      <SettingRow label="Device notifications" description={permission === 'unsupported' ? 'This browser does not support notifications.' : permission === 'denied' ? 'Notifications are blocked in this browser’s site settings.' : preferences.device ? 'Enabled on this device.' : 'Show notifications outside the Atelier window.'}>
        <Button size="sm" variant={preferences.device ? 'outline' : 'primary'} disabled={permission === 'unsupported' || permission === 'denied'} onClick={() => void device()}>{preferences.device ? 'Enabled' : 'Enable'}</Button>
      </SettingRow>
      <SettingRow label="Use on a phone" description="Open Atelier in your mobile browser, add it to your home screen, then enable device notifications here. Notifications arrive while Atelier is connected. Background remote push needs a push service and is not configured." />
    </SettingsGroup>
  </>;
}
