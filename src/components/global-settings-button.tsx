/**
 * The way out to the settings screen.
 *
 * It is drawn by the shell as the last thing on the first bar
 * (src/components/shell.tsx), not floated over the corner of the window: a
 * control pinned to the viewport belongs to no screen, scrolls with nothing,
 * and lands off the row every other control in the bar is centred on.
 *
 * It does not check which screen it is on. The shell is the only thing that
 * draws it and only the project list and the project screen draw a shell, so
 * the settings screen — the one screen this would point at itself from — never
 * mounts it in the first place.
 */
import Link from "next/link";

import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";

export function GlobalSettingsButton() {
  return (
    // The ink is named from the app's own text scale, which all eleven themes
    // spell out — the button's own quiet variants are written in the borrowed
    // vocabulary (`muted-foreground`, `accent-foreground`) that three of the
    // themes never define, so on those three they fall back to a fixed palette
    // instead of the theme's. `ml-auto` only bites on a bar whose contents do
    // not already reach the right edge. The icon carries its own full strength:
    // the button dims any picture inside it to 60%, which on the light skins
    // drops the gear under the strength a control has to be drawn at.
    <Button
      variant="ghost"
      size="icon"
      className="ml-auto shrink-0 text-t-tertiary hover:bg-surface-overlay hover:text-t-primary"
      asChild
    >
      <Link href="/settings" aria-label="Settings">
        <Settings className="opacity-100" aria-hidden="true" />
      </Link>
    </Button>
  );
}
