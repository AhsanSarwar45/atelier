'use client';

/**
 * An address the reader opens Atelier at: the address, a copy, and an edit.
 *
 * Every address in settings is the same three controls in the same order, so
 * one of them is never a field with a Save while the next is a line of text
 * with a link buried in a sentence. Where the address is actually changed
 * differs — Tailscale's is renamed at Tailscale — and that is what `onEdit`
 * or `editHref` is for. What does not differ is the shape.
 */

import * as React from 'react';

import { Check, Copy, Pencil } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function AddressRow({
  address,
  editLabel,
  editHref,
  onEdit,
  copied,
  onCopy,
  ...rest
}: {
  address: string;
  /** What editing this one means, for the button's label. Left out when the
   *  row is something to copy and run rather than something to change here. */
  editLabel?: string;
  /** Where the address is really changed, when that is somewhere else. */
  editHref?: string;
  /** What changing it does, when it is done here. */
  onEdit?: () => void;
  /** The address the reader just copied, so the tick lands on the right row. */
  copied: string | null;
  onCopy: (address: string) => void;
  'data-testid'?: string;
}) {
  return (
    <div className="flex w-full items-center gap-2" data-testid={rest['data-testid']}>
      <Badge
        asChild
        variant="secondary"
        appearance="light"
        size="sm"
        className="min-w-0 flex-1 justify-start font-mono"
      >
        <code className="truncate">{address}</code>
      </Badge>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onCopy(address)}
        aria-label={`Copy ${address}`}
        data-testid="address-copy"
      >
        {copied === address ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
      {!editLabel ? null : editHref ? (
        <Button size="sm" variant="outline" asChild aria-label={editLabel} data-testid="address-edit">
          <a href={editHref} target="_blank" rel="noreferrer noopener">
            <Pencil className="size-4" />
          </a>
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={onEdit}
          aria-label={editLabel}
          data-testid="address-edit"
        >
          <Pencil className="size-4" />
        </Button>
      )}
    </div>
  );
}
