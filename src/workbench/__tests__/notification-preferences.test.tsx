import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { readNotificationPreferences, useNotificationPreferences } from '@/workbench/notification-preferences';

describe('notification preferences', () => {
  beforeEach(() => localStorage.clear());

  it('starts with both notification types visible and device delivery off', () => {
    expect(readNotificationPreferences()).toEqual({ needsAction: true, updates: true, device: false });
  });

  it('keeps a device choice for the next screen', () => {
    const { result } = renderHook(() => useNotificationPreferences());
    act(() => result.current.save({ needsAction: false, updates: true, device: true }));
    expect(readNotificationPreferences()).toEqual({ needsAction: false, updates: true, device: true });
  });
});
