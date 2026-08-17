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
    // `dim` is the bar's quiet control: the theme's muted ink, its full
    // strength under the pointer. `ml-auto` only bites on a bar whose contents
    // do not already reach the right edge.
    <Button variant="dim" size="icon" className="ml-auto shrink-0" asChild>
      <Link href="/settings" aria-label="Settings">
        <Settings aria-hidden="true" />
      </Link>
    </Button>
  );
}
