/**
 * One of Atelier's own things — a card, a chat, a skill — as the one badge it is
 * drawn as wherever it is named.
 *
 * A reference is written into the composer, sent, and read back in the
 * transcript, and the reader must see the same badge at every step: the card's
 * id with its status colour, the chat's name beside its provider's mark, the
 * skill's name beside the skill mark (bw-mi3s.1). So there is one face here,
 * `ReferenceFace`, and two ways of wearing it:
 *
 * - `ReferenceBadge`, in a message: a control that opens what it names.
 * - `referenceBadgeElement`, in the composer: the same face rendered to DOM,
 *   because CodeMirror draws the writing box and takes an element, not a tree.
 *   It is a drawing of text still being edited, so it opens nothing and lets the
 *   click through to place a caret — the same rule as a file badge there.
 *
 * Only the wrapper differs; the badge, its classes, its icon and its words are
 * built by the same code, so the two cannot drift.
 */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { renderToStaticMarkup } from 'react-dom/server';

import { CircleDot, MessageSquare, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { addressWith, cardWasPushed } from '@/lib/address';
import { classesFor } from '@/lib/state-styles';
import { cn } from '@/lib/utils';
import type { BeadStatus } from '@/types';
import { BrandIcon, brandName } from '@/workbench/brand-icon';
import type { Brand } from '@/workbench/protocol';

/** What a badge needs to know to draw one reference. */
export type Reference =
  | { kind: 'bead'; id: string; status?: BeadStatus }
  | {
      kind: 'chat';
      id: string;
      /** The chat's name, or null while it is not known yet. */
      name: string | null;
      brand?: Brand;
      /** The project the chat is in, when it is known. */
      projectId?: string | null;
    }
  | {
      kind: 'skill';
      id: string;
      /** The skill's name in the library, or null to show its id. */
      name: string | null;
      description?: string;
    };

/** Each provider's own colour, the same hues its provider badge mixes. */
const BRAND_COLOR: Record<Brand, string> = {
  claude: 'border-[#d97757]/40 bg-[#d97757]/10 text-[#d97757] hover:bg-[#d97757]/15',
  codex: 'border-[#10a37f]/40 bg-[#10a37f]/10 text-[#10a37f] hover:bg-[#10a37f]/15',
  local: 'border-[#8b5cf6]/40 bg-[#8b5cf6]/10 text-[#8b5cf6] hover:bg-[#8b5cf6]/15',
};

const SKILL_COLOR = 'border-[#e0a526]/40 bg-[#e0a526]/10 text-[#c98f10] dark:text-[#e0a526] hover:bg-[#e0a526]/15';

/** The words a badge shows. */
export function referenceLabel(ref: Reference): string {
  if (ref.kind === 'bead') return ref.id;
  if (ref.kind === 'chat') return ref.name || 'Chat';
  return ref.name || ref.id;
}

/** What the pointer says over it. */
export function referenceTitle(ref: Reference): string {
  if (ref.kind === 'bead') return `Open ${ref.id}`;
  if (ref.kind === 'chat') return `Open chat${ref.brand ? ` · ${brandName(ref.brand)}` : ''}`;
  return ref.description ? `Skill · ${ref.description}` : 'Skill';
}

/*
 * Every reference is one line at its size's height, like every other chip. A
 * long chat or skill name ends in an ellipsis; it used to be let wrap, which in
 * the `@` menu broke a skill's name into a column of letters (bw-mydas.1).
 */
const ONE_LINE = 'min-w-0 max-w-full';

function referenceClass(ref: Reference): string {
  if (ref.kind === 'bead') return cn(ONE_LINE, classesFor(ref.status).badge);
  if (ref.kind === 'chat') return cn(ONE_LINE, ref.brand ? BRAND_COLOR[ref.brand] : classesFor(undefined).badge);
  return cn(ONE_LINE, SKILL_COLOR);
}

/** The marks every badge carries, whichever way it is drawn. */
function referenceMarks(ref: Reference): Record<string, string> {
  return {
    'data-reference-kind': ref.kind,
    'data-reference-id': ref.id,
    ...(ref.kind === 'bead' ? { 'data-bead-id': ref.id, ...(ref.status ? { 'data-bead-status': ref.status } : {}) } : {}),
    ...(ref.kind === 'chat' && ref.brand ? { 'data-brand': ref.brand } : {}),
  };
}

/** The icon and the words — the inside of every badge. */
export function ReferenceFace({ reference }: { reference: Reference }) {
  const icon =
    reference.kind === 'bead' ? (
      <CircleDot className="mr-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
    ) : reference.kind === 'chat' ? (
      reference.brand ? (
        <BrandIcon brand={reference.brand} className="mr-0.5 size-3" />
      ) : (
        <MessageSquare className="mr-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      )
    ) : (
      <Sparkles className="mr-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
    );
  return (
    <>
      {icon}
      <span className="min-w-0 truncate">{referenceLabel(reference)}</span>
    </>
  );
}

const BADGE = { variant: 'primary', appearance: 'outline', shape: 'circle' } as const;


/**
 * The badge as a drawing: no control, nothing to open. What the composer
 * renders to DOM, and what a message draws where there is nothing to open with.
 */
export function ReferenceBadgeLook({
  reference,
  size = 'sm',
  className,
  testId = 'reference-badge',
}: {
  reference: Reference;
  size?: 'sm' | 'xs';
  className?: string;
  testId?: string;
}) {
  return (
    <Badge asChild {...BADGE} size={size} className={cn(referenceClass(reference), className)}>
      <span data-testid={testId} {...referenceMarks(reference)}>
        <ReferenceFace reference={reference} />
      </span>
    </Badge>
  );
}

/** The badge as a control that opens what it names, for a sent message. */
export function ReferenceBadge({
  reference,
  projectId,
  size = 'sm',
  testId = 'reference-badge',
  title,
  className,
}: {
  reference: Reference;
  /** The project the reader is in, which a card is opened in. */
  projectId: string | null;
  size?: 'sm' | 'xs';
  testId?: string;
  /** What the pointer says, when the badge stands for more than it names. */
  title?: string;
  className?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const open = () => {
    if (reference.kind === 'bead') {
      // Pushed, and the rest of the address kept: the card opens over what the
      // reader was reading, and Back closes it again.
      cardWasPushed();
      router.push(addressWith(params, { id: projectId, card: reference.id }));
    } else if (reference.kind === 'chat') {
      router.push(addressWith(params, { id: reference.projectId ?? projectId, tab: 'chat', chat: reference.id, card: null }));
    } else {
      router.push('/settings?section=library');
    }
  };
  return (
    /* The button inside takes `size="none"`: the badge around it is what sizes
       it. The button is here for what it does — the pointer, the focus ring —
       not for a box of its own (bw-s5op.2). */
    <Tooltip label={title ?? referenceTitle(reference)}>
      <Badge asChild {...BADGE} size={size} className={cn(referenceClass(reference), className)}>
        <Button
          type="button"
          variant="foreground"
          size="none"
          className="relative before:absolute before:-inset-2.5 before:content-['']"
          data-testid={testId}
          {...referenceMarks(reference)}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
        >
          <ReferenceFace reference={reference} />
        </Button>
      </Badge>
    </Tooltip>
  );
}

/**
 * The same badge as a DOM element, for the composer.
 *
 * Rendered from the component rather than rebuilt by hand, so the composer's
 * badge is the message's badge down to the class list (bw-e9p5.1 is what a hand
 * built second copy turned into).
 */
export function referenceBadgeElement(reference: Reference): HTMLElement {
  const holder = document.createElement('span');
  holder.innerHTML = renderToStaticMarkup(
    <ReferenceBadgeLook reference={reference} className="mx-0.5 cursor-default select-none" testId="composer-reference" />,
  );
  return (holder.firstElementChild as HTMLElement | null) ?? holder;
}
