"use client";

import { useState, useEffect } from "react";

import { Check, Palette } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { THEMES, getSavedTheme, applyTheme, type ThemeDefinition } from "@/lib/themes";

/**
 * Theme preview swatch — shows 4 color dots representing the theme palette
 */
function ThemePreview({ theme, isActive }: { theme: ThemeDefinition; isActive: boolean }) {
  return (
    <div
      className="relative flex items-center gap-1 rounded-md p-1"
      style={{ backgroundColor: theme.preview.bg }}
    >
      <div className="size-3 rounded-sm" style={{ backgroundColor: theme.preview.surface }} />
      <div className="size-3 rounded-sm" style={{ backgroundColor: theme.preview.accent }} />
      <div
        className="size-1.5 rounded-full absolute -top-0.5 -right-0.5"
        style={{ backgroundColor: theme.preview.text }}
      />
      {isActive && (
        <Check className="size-3 absolute -bottom-0.5 -right-0.5 text-t-primary" />
      )}
    </div>
  );
}

/**
 * Theme switcher component — grid of theme cards
 * Persists selection to localStorage and applies via data-theme attribute
 */
export function ThemeSwitcher() {
  const [activeTheme, setActiveTheme] = useState("default");

  useEffect(() => {
    setActiveTheme(getSavedTheme());
  }, []);

  const handleSelect = (themeId: string) => {
    applyTheme(themeId);
    setActiveTheme(themeId);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-t-muted">
        <Palette className="size-3.5" aria-hidden="true" />
        <span>Select a theme</span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {THEMES.map((theme) => {
          const isActive = theme.id === activeTheme;
          return (
            <Button
              key={theme.id}
              variant="outline"
              size="md"
              selected={isActive}
              onClick={() => handleSelect(theme.id)}
              aria-pressed={isActive}
              aria-label={`Apply ${theme.name} theme`}
              className="h-auto justify-start gap-3 px-3 py-2.5 text-left font-normal"
            >
              <ThemePreview theme={theme} isActive={isActive} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {/* The chosen card sits on the theme's accent, where the
                      library's own pairing is right; the rest sit on the page,
                      where three themes set that same colour to their own
                      background and the name would vanish (bw-jqv9). Names
                      only the resting colour, and comes out when that is
                      fixed. */}
                  <span className={isActive ? "text-sm font-medium" : "text-sm font-medium text-t-secondary"}>
                    {theme.name}
                  </span>
                  <Badge
                    variant={theme.mode === 'dark' ? 'secondary' : 'warning'}
                    appearance="light"
                    size="xs"
                    className="uppercase tracking-wide"
                  >
                    {theme.mode}
                  </Badge>
                </div>
                <p className="text-xs text-t-muted truncate">
                  {theme.description}
                </p>
              </div>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
