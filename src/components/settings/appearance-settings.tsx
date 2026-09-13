/** The Appearance section: the theme, and how large the type is. */
'use client';

import { useEffect, useState } from 'react';

import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  applyFontSize,
  clampFontSize,
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STORAGE_KEY,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from '@/lib/font-size';

export function AppearanceSettings() {
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);

  useEffect(() => {
    const stored = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    const parsed = stored ? Number(stored) : DEFAULT_FONT_SIZE;
    const next = clampFontSize(parsed);
    setFontSize(next);
    applyFontSize(next);
  }, []);

  const change = (value: number) => {
    const next = clampFontSize(value);
    setFontSize(next);
    applyFontSize(next);
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(next));
  };

  return (
    <>
      <SettingsGroup title="Theme" data-testid="appearance-theme">
        <div className="p-3">
          <ThemeSwitcher />
        </div>
      </SettingsGroup>
      <SettingsGroup title="Type" data-testid="appearance-type">
        <SettingRow
          label="Font size"
          htmlFor="font-size"
          description={`${MIN_FONT_SIZE}–${MAX_FONT_SIZE} px`}
          stack
        >
          <Slider
            id="font-size"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            value={fontSize}
            onChange={(e) => change(Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <Input
            type="number"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            value={fontSize}
            onChange={(e) => change(Number(e.target.value))}
            className="w-20 tabular-nums"
            aria-label="Font size in pixels"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              change(DEFAULT_FONT_SIZE);
              localStorage.removeItem(FONT_SIZE_STORAGE_KEY);
            }}
          >
            Reset
          </Button>
        </SettingRow>
      </SettingsGroup>
    </>
  );
}
