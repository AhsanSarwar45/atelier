/**
 * The window: two bars that never move, and one box of work beneath them.
 *
 * The first bar is the project — where you are and how to leave. The second is
 * the tabs, and a slot the open tab fills with its own tools. Everything else
 * is the work, and it is the only thing allowed to scroll: the shell is exactly
 * the height of the window and clips, so a pane that overflows scrolls inside
 * itself instead of carrying the bars off the top of the screen.
 *
 * Design: docs/designs/app-shell.md.
 */
'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

import { Loader2 } from 'lucide-react';
import { createPortal } from 'react-dom';

import { GlobalSettingsButton } from '@/components/global-settings-button';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface Slot {
  node: HTMLElement | null;
  activeTab: string | null;
}

const ToolSlot = createContext<Slot>({ node: null, activeTab: null });

/**
 * `data-shell-bar` is the count the acceptance suite reads: two, and a third
 * cannot appear without saying so.
 */
const BAR = 'flex h-12 shrink-0 items-center gap-2 border-b border-border/40 bg-background/80 px-3';

export function Shell({
  bar,
  barClassName,
  tabs,
  activeTab,
  children,
}: {
  /** The project bar's contents: back, the name, its menu, and what follows the owner. */
  bar: ReactNode;
  /** What a theme adds to the project bar, and nothing else. */
  barClassName?: string;
  /** The tab selector. Omitted on screens that have no tabs — then there is one bar. */
  tabs?: ReactNode;
  activeTab?: string | null;
  children: ReactNode;
}) {
  const [node, setNode] = useState<HTMLElement | null>(null);

  return (
    <div data-testid="shell" className="flex h-dvh flex-col overflow-hidden bg-surface-base">
      <div data-shell-bar data-testid="project-bar" className={cn(BAR, barClassName)}>
        {bar}
        {/* The way out to settings ends every bar, drawn here rather than by
            each page: a control the pages hand in themselves is one a new page
            forgets, and one every page places differently. */}
        <GlobalSettingsButton />
      </div>
      {tabs && (
        <div data-shell-bar data-testid="tab-bar" className={BAR}>
          {tabs}
          <div data-testid="tab-tools" ref={setNode} className="flex min-w-0 flex-1 items-center gap-2" />
        </div>
      )}
      <ToolSlot.Provider value={{ node, activeTab: activeTab ?? null }}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </ToolSlot.Provider>
    </div>
  );
}

/**
 * A tab's own tools, drawn in the second bar.
 *
 * Written where the controls already live rather than lifted into the page that
 * draws the bar: the board's filter row alone holds eleven controls and all of
 * their state. A tab that is mounted but not showing draws nothing — the board
 * stays mounted behind the chat so its cards are not fetched twice.
 */
export function TabTools({ tab, children }: { tab: string; children: ReactNode }) {
  const { node, activeTab } = useContext(ToolSlot);
  if (!node || activeTab !== tab) return null;
  return createPortal(<Toolbar>{children}</Toolbar>, node);
}

/**
 * A row of controls. The bar around it is the chrome, so this draws none of its
 * own; what does not fit slides sideways rather than wrapping and making the
 * bar taller.
 */
export function Toolbar({ label = 'Tools', className, children }: { label?: string; className?: string; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={250}>
      <div role="toolbar" aria-label={label} className={cn('flex min-w-0 flex-1 items-center gap-2 overflow-x-auto', className)}>
        {children}
      </div>
    </TooltipProvider>
  );
}

/**
 * One control on a bar: a picture, with its words in the tooltip and in the
 * name a screen reader hears. A bar of sentences is a bar nobody reads, and the
 * words are still there for whoever needs them (the manager's rule on
 * descriptions, docs/designs/app-shell.md §1.4).
 */
export function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  busy,
  emphasis = 'quiet',
  className,
  ...rest
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Shown in place of the picture while the button's work is being done. */
  busy?: boolean;
  emphasis?: 'quiet' | 'loud';
  className?: string;
} & Omit<React.ComponentProps<typeof Button>, 'children' | 'onClick' | 'disabled' | 'className'>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          mode="icon"
          variant={emphasis === 'loud' ? 'primary' : 'ghost'}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          // A quiet control is inked from the app's own text scale: the button's
          // ghost style names a borrowed colour that three skins paint the same
          // as the bar behind it, and dims the picture to 60% on top of that.
          className={cn(
            emphasis === 'loud'
              ? undefined
              : 'text-t-tertiary hover:bg-surface-overlay hover:text-t-primary [&_svg]:opacity-100',
            className,
          )}
          {...rest}
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
