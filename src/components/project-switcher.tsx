/**
 * The project's name in the bar, and the short way from it to another project.
 *
 * The manager asked for it off the running app: "the project name should be
 * [name] v (chevron) that will open a popup where we show the recent projects
 * (5 or something) where we can quick switch between projects" (bw-r8dg).
 *
 * The name was a heading, so moving between two projects was the house, the
 * list, and then the card — three presses to go where the reader was ten
 * minutes ago. The list of where he was is already kept: every visit touches
 * the project and the server orders the list by `last_opened DESC`, so what is
 * offered here costs one call and no new bookkeeping.
 *
 * It draws as what the width is. A phone gets a sheet up from the bottom edge,
 * where a thumb is, and a wider screen gets a panel under the name it came
 * from — the same rows either way, written once below.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import Link from 'next/link';

import { ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Row } from '@/components/ui/row';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import * as api from '@/lib/api';
import { recentOthers } from '@/lib/recent-projects';
import { usePhoneScreen } from '@/lib/screen-width';
import { cn } from '@/lib/utils';
import type { Project } from '@/types';

const TITLE = 'Recent projects';

export function ProjectSwitcher({
  projectId,
  name,
  nameClassName,
}: {
  /** The project the bar is naming, which is the one left out of the list. */
  projectId: string | null;
  name: string;
  /** How the bar spells a name; the terminal skin spells it its own way. */
  nameClassName?: string;
}) {
  const phone = usePhoneScreen();
  const [open, setOpen] = useState(false);
  // `null` until the first answer is in, which is what tells "still asking"
  // apart from "there is nobody else" — two very different sheets.
  const [others, setOthers] = useState<Project[] | null>(null);

  // Asked each time it is opened rather than once: the list is an ordering by
  // when each project was last visited, and visiting is exactly what the
  // reader has been doing since the last time he looked. The previous answer
  // stays on screen while the new one is fetched, so a second opening does not
  // blink.
  useEffect(() => {
    if (!open) return;
    let listening = true;
    api.projects
      .list()
      .then((list) => {
        if (listening) setOthers(recentOthers(list, projectId));
      })
      .catch(() => {
        if (listening) setOthers([]);
      });
    return () => {
      listening = false;
    };
  }, [open, projectId]);

  const leave = useCallback(() => setOpen(false), []);

  const trigger = (
    // The library's button at the size that draws no box of its own: the name
    // is a heading that happens to open something, so it keeps the bar's own
    // type and the bar's own spacing. A lozenge's worth of padding here would
    // put the name somewhere no other bar in the app has it (bw-r8dg.1).
    <Button
      variant="ghost"
      size="inherit"
      data-testid="project-switch"
      // `size="inherit"` turns the phone's 44px floor off rather than merely
      // escaping it (globals.css), and this is the control a thumb reaches for
      // most on this screen. The band gives the reach back without painting a
      // box: it grows up and down from the middle and takes its width from the
      // name's own edges, so the bar's spacing is untouched (bw-r8dg.2).
      data-reach="row"
      // Named by the name it draws, and by nothing else. A label here would
      // replace that name with a sentence — and the heading this control sits
      // inside takes ITS name from what is underneath, so the screen's heading
      // would have stopped being the project's name (bw-r8dg.2).
      aria-haspopup="dialog"
      className="flex min-w-0 items-center gap-1 text-left text-t-primary transition-opacity hover:bg-transparent hover:opacity-80"
    >
      <span data-testid="project-name" className={cn('truncate', nameClassName)}>
        {name}
      </span>
      <ChevronDown
        className="h-4 w-4 shrink-0 text-t-tertiary transition-transform"
        // The arrow turns over while the list is up, so the control says which
        // of its two states it is in without a second picture.
        style={{ transform: open ? 'rotate(180deg)' : undefined }}
        aria-hidden
      />
    </Button>
  );

  const list = (
    <div data-testid="project-switch-list" className="flex flex-col">
      {others === null ? (
        <p className="px-4 py-3 text-sm text-t-tertiary">Looking for recent projects…</p>
      ) : others.length === 0 ? (
        <>
          <p className="px-4 py-3 text-sm text-t-tertiary">No other projects yet.</p>
          <Row asChild ruled inset="md" data-testid="project-switch-all">
            <Link href="/" onClick={leave}>
              All projects
            </Link>
          </Row>
        </>
      ) : (
        others.map((project) => (
          // A link, not a handler: the row keeps middle-click and "open in a
          // new tab", which is how a reader compares two projects rather than
          // trading one for the other.
          <Row
            key={project.id}
            asChild
            ruled
            inset="md"
            data-testid="project-switch-row"
            data-project-id={project.id}
          >
            <Link href={`/project?id=${encodeURIComponent(project.id)}`} onClick={leave}>
              <span className="block truncate text-sm">{project.name}</span>
            </Link>
          </Row>
        ))
      )}
    </div>
  );

  if (phone) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        {/* `asChild` so the control in the bar is the button written above and
            not a second one wrapped around it. */}
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          hideClose
          aria-describedby={undefined}
          data-testid="project-switch-panel"
          // Up from the edge the thumb is at, and no taller than it needs: the
          // rows are the panel, so the padding a sheet brings by default is
          // taken off and given to the heading alone.
          className="max-h-[70dvh] gap-0 overflow-y-auto p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetTitle className="px-4 pb-2 pt-4 text-sm font-medium text-t-tertiary">
            {TITLE}
          </SheetTitle>
          {list}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        data-testid="project-switch-panel"
        className="w-64 overflow-hidden p-0"
      >
        <p className="px-4 pb-2 pt-3 text-sm font-medium text-t-tertiary">{TITLE}</p>
        {list}
      </PopoverContent>
    </Popover>
  );
}
