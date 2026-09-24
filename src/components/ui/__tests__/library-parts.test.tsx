/**
 * The parts added so screens stop building their own (bw-weih.3): each one
 * does the one thing a screen reaches for it to do.
 */

import * as React from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { Search } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Collapsible, CollapsibleContent, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

describe('Spinner and a busy Button', () => {
  it('hides a spinner with no label and names one with a label', () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector('[data-slot="spinner"]')).toHaveAttribute('aria-hidden', 'true');
    render(<Spinner label="Loading files" />);
    expect(screen.getByRole('status', { name: 'Loading files' })).toBeInTheDocument();
  });

  it('draws a spinner before the label and stops taking presses while loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.firstElementChild).toHaveAttribute('data-slot', 'spinner');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is the button it always was when not loading', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it('puts the spinner inside the element it is given as a child', () => {
    render(
      <Button asChild loading>
        <a href="/x">Open</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Open' });
    expect(link.firstElementChild).toHaveAttribute('data-slot', 'spinner');
    expect(link).toHaveAttribute('aria-busy', 'true');
  });

  it('has a twenty-pixel size, icon-only too, and a success tone', () => {
    render(
      <>
        <Button size="2xs">Tiny</Button>
        <Button size="2xs" mode="icon" aria-label="Close" />
        <Button variant="success">Approve</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Tiny' })).toHaveClass('h-5');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('w-5', 'h-5');
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveClass('text-success');
  });
});

describe('Switch', () => {
  it('flips on and off', () => {
    const onChange = vi.fn();
    render(<Switch aria-label="Enabled" onCheckedChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Enabled' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});

describe('Collapsible', () => {
  it('opens and closes from its row', () => {
    render(
      <Collapsible>
        <CollapsibleTriggerRow>Design</CollapsibleTriggerRow>
        <CollapsibleContent>The design</CollapsibleContent>
      </Collapsible>,
    );
    const row = screen.getByRole('button', { name: 'Design' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('The design')).toBeNull();
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('The design')).toBeVisible();
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('The design')).toBeNull();
  });
});

describe('ToggleGroup', () => {
  function Switcher({ onChange }: { onChange: (value: string) => void }) {
    const [value, setValue] = React.useState('preview');
    return (
      <ToggleGroup
        type="single"
        size="2xs"
        value={value}
        onValueChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      >
        <ToggleGroupItem value="preview">Preview</ToggleGroupItem>
        <ToggleGroupItem value="source">Source</ToggleGroupItem>
      </ToggleGroup>
    );
  }

  it('moves the one choice taken, and never leaves none taken', () => {
    const onChange = vi.fn();
    render(<Switcher onChange={onChange} />);
    const preview = screen.getByRole('radio', { name: 'Preview' });
    const source = screen.getByRole('radio', { name: 'Source' });
    expect(preview).toHaveAttribute('data-state', 'on');
    expect(source).toHaveClass('h-5');

    fireEvent.click(source);
    expect(onChange).toHaveBeenLastCalledWith('source');
    expect(source).toHaveAttribute('data-state', 'on');
    expect(preview).toHaveAttribute('data-state', 'off');

    fireEvent.click(source);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(source).toHaveAttribute('data-state', 'on');
  });
});

describe('ButtonGroup', () => {
  it('joins its buttons into one group', () => {
    render(
      <ButtonGroup aria-label="New chat">
        <Button>New Chat</Button>
        <Button aria-label="Options" />
      </ButtonGroup>,
    );
    const group = screen.getByRole('group', { name: 'New chat' });
    expect(group.className).toContain('[&>*:not(:first-child)]:rounded-l-none');
    expect(group.className).toContain('[&>*:not(:last-child)]:rounded-r-none');
  });
});

describe('Input', () => {
  it('is the bare field it always was without slots', () => {
    const { container } = render(<Input aria-label="Name" />);
    const field = screen.getByRole('textbox', { name: 'Name' });
    expect(container.firstElementChild).toBe(field);
    expect(field).toHaveClass('h-9');
  });

  it('draws what it is given at either end, and a small size', () => {
    render(
      <Input
        aria-label="Search commits"
        size="sm"
        start={<Search data-testid="icon" />}
        end={<button type="button">Clear</button>}
      />,
    );
    const field = screen.getByRole('textbox', { name: 'Search commits' });
    expect(field).toHaveClass('h-7', 'text-xs', 'pl-7', 'pr-7');
    expect(screen.getByTestId('icon').closest('[data-slot="input-start"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Clear' }).closest('[data-slot="input-end"]')).not.toBeNull();
  });
});

describe('Progress', () => {
  it('colours the bar by its tone', () => {
    const { container, rerender } = render(<Progress value={40} />);
    const bar = () => container.querySelector('[data-tone]');
    expect(bar()).toHaveAttribute('data-tone', 'default');
    expect(bar()).toHaveClass('bg-primary');
    rerender(<Progress value={95} tone="danger" />);
    expect(bar()).toHaveAttribute('data-tone', 'danger');
    expect(bar()).toHaveClass('bg-destructive');
    rerender(<Progress value={80} tone="warning" />);
    expect(bar()).toHaveClass('bg-warning');
  });
});

describe('ContextMenu', () => {
  it('opens at a right-click and runs the chosen item', () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu>
        <ContextMenuTrigger>A file</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onSelect}>Rename</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem>Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(screen.getByText('A file'), { clientX: 10, clientY: 10 });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onSelect).toHaveBeenCalled();
  });
});

describe('Badge color', () => {
  it('washes the chip in a tag colour', () => {
    render(
      <>
        <Badge color="#3366ff">tint</Badge>
        <Badge color="#3366ff" colorFill="solid">solid</Badge>
        <Badge color="#3366ff" colorFill="faint">faint</Badge>
        <Badge>plain</Badge>
      </>,
    );
    const tint = screen.getByText('tint');
    expect(tint).toHaveStyle({ color: '#3366ff', borderColor: '#3366ff' });
    expect(tint.style.backgroundColor).not.toBe('');
    expect(screen.getByText('solid')).toHaveStyle({ backgroundColor: '#3366ff', color: '#fff' });
    expect(screen.getByText('faint').style.borderColor).not.toBe('');
    expect(screen.getByText('plain').getAttribute('style')).toBeNull();
    expect(tint).not.toHaveAttribute('color');
  });
});
