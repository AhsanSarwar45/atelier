/**
 * The second set of parts screens were building by hand (bw-weih.3): the
 * popover at a point, the sheet held in a box, the editor's tabs and the table.
 */

import * as React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { PointerAnchor, PopoverAtPoint } from '@/components/ui/point-anchor';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PointerAnchor as OldPointerAnchor } from '@/workbench/menu-anchor';

describe('a popover or a menu at a point', () => {
  it('opens a popover beside a rectangle, anchored in the body whatever holds it', () => {
    render(
      <div style={{ transform: 'translateX(0)' }} data-testid="rail">
        <Popover open>
          <PopoverAtPoint at={{ left: 40, top: 120, width: 80, height: 16 }} />
          <PopoverContent>Copy text</PopoverContent>
        </Popover>
      </div>,
    );
    const anchor = screen.getByTestId('popover-point-anchor');
    expect(anchor.parentElement).toBe(document.body);
    expect(screen.getByTestId('rail').contains(anchor)).toBe(false);
    expect(anchor).toHaveStyle({ position: 'fixed', left: '40px', top: '120px', width: '80px', height: '16px' });
    expect(screen.getByText('Copy text')).toBeInTheDocument();
  });

  it('opens a menu at the pointer, and the old import is the same anchor', () => {
    expect(OldPointerAnchor).toBe(PointerAnchor);
    render(
      <DropdownMenu open>
        <PointerAnchor at={{ left: 5, top: 7 }} />
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const anchor = screen.getByTestId('pointer-anchor');
    expect(anchor.parentElement).toBe(document.body);
    expect(anchor).toHaveStyle({ left: '5px', top: '7px', width: '0px', height: '0px' });
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
  });
});

describe('a sheet held inside a box', () => {
  function Drawer({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
    return (
      <div data-testid="work-area" style={{ position: 'relative' }}>
        <div data-testid="bar">
          <Sheet contained onOpenChange={onOpenChange}>
            <SheetTrigger>Chats</SheetTrigger>
            <SheetContent side="left" data-testid="drawer" aria-describedby={undefined}>
              <SheetTitle>Chats</SheetTitle>
              <button type="button">A chat</button>
            </SheetContent>
          </Sheet>
        </div>
        <button type="button">Elsewhere</button>
      </div>
    );
  }

  it('draws inside the box, not over the window, and leaves the bar pressable', () => {
    render(<Drawer />);
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    const drawer = screen.getByTestId('drawer');
    expect(screen.getByTestId('work-area').contains(drawer)).toBe(true);
    expect(drawer).toHaveClass('absolute');
    expect(drawer).not.toHaveClass('fixed');
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toHaveClass('absolute', 'inset-0');
    // Not modal: nothing outside it is hidden from a screen reader.
    expect(screen.getByRole('button', { name: 'Elsewhere' })).not.toHaveAttribute('aria-hidden');
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('closes on Escape and on its dimming', () => {
    const onOpenChange = vi.fn();
    render(<Drawer onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    fireEvent.keyDown(screen.getByTestId('drawer'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('drawer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    fireEvent.click(document.querySelector('[data-slot="sheet-overlay"]')!);
    expect(screen.queryByTestId('drawer')).toBeNull();
  });

  it('is still the window-wide sheet it always was without the option', () => {
    render(
      <div data-testid="work-area">
        <Sheet defaultOpen>
          <SheetContent data-testid="drawer" aria-describedby={undefined}>
            <SheetTitle>Card</SheetTitle>
          </SheetContent>
        </Sheet>
      </div>,
    );
    const drawer = screen.getByTestId('drawer');
    expect(screen.getByTestId('work-area').contains(drawer)).toBe(false);
    expect(drawer).toHaveClass('fixed');
  });
});

describe('editor tabs', () => {
  function Strip({ onClose }: { onClose: (which: string) => void }) {
    const [value, setValue] = React.useState('a.ts');
    return (
      <Tabs value={value} onValueChange={setValue}>
        <TabsList variant="strip" aria-label="Open files">
          <TabsTrigger value="a.ts" onClose={() => onClose('a.ts')} closeLabel="Close a.ts">
            a.ts
          </TabsTrigger>
          <TabsTrigger value="b.ts" onClose={() => onClose('b.ts')} closeLabel="Close b.ts">
            b.ts
          </TabsTrigger>
        </TabsList>
        <TabsContent value="a.ts">A</TabsContent>
        <TabsContent value="b.ts">B</TabsContent>
      </Tabs>
    );
  }

  it('closes a tab from its cross without making it the current one', () => {
    const onClose = vi.fn();
    render(<Strip onClose={onClose} />);
    const b = screen.getByRole('tab', { name: 'b.ts' });
    expect(b).toHaveAttribute('data-state', 'inactive');
    const cross = screen.getByRole('button', { name: 'Close b.ts' });
    fireEvent.mouseDown(cross);
    fireEvent.click(cross);
    expect(onClose).toHaveBeenCalledWith('b.ts');
    expect(b).toHaveAttribute('data-state', 'inactive');
    expect(screen.getByRole('tab', { name: 'a.ts' })).toHaveAttribute('data-state', 'active');
  });

  it('keeps the cross out of the tab, reachable from the keyboard, and closes on a middle click', () => {
    const onClose = vi.fn();
    render(<Strip onClose={onClose} />);
    const cross = screen.getByRole('button', { name: 'Close a.ts' });
    expect(screen.getByRole('tab', { name: 'a.ts' }).contains(cross)).toBe(false);
    expect(cross).not.toHaveAttribute('tabindex', '-1');
    cross.focus();
    expect(cross).toHaveFocus();
    fireEvent(
      screen.getByRole('tab', { name: 'a.ts' }).parentElement!,
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    );
    expect(onClose).toHaveBeenCalledWith('a.ts');
  });

  it('draws the strip look, and the pill of choices as it was', () => {
    render(<Strip onClose={() => {}} />);
    expect(screen.getByRole('tablist', { name: 'Open files' })).toHaveClass('border-b', 'bg-surface-inset/40');
    render(
      <Tabs defaultValue="x">
        <TabsList aria-label="Plain">
          <TabsTrigger value="x">X</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole('tablist', { name: 'Plain' })).toHaveClass('rounded-lg', 'bg-muted');
    expect(screen.getByRole('tab', { name: 'X' })).toHaveClass('h-10', 'rounded-md');
  });
});

describe('Table', () => {
  it('draws a header and rows, scrolling sideways in its own box', () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>web</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(container.querySelector('[data-slot="table-container"]')).toHaveClass('overflow-x-auto');
    expect(screen.getByRole('table')).toHaveClass('w-max', 'min-w-full', 'text-xs');
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveClass('px-3', 'py-2', 'font-medium');
    expect(screen.getByRole('cell', { name: 'web' })).toHaveClass('text-muted-foreground');
  });
});
