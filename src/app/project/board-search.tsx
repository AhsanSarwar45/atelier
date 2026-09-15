/**
 * The board as a search source (bw-21a2.7).
 *
 * Every card on the board, found by what it says — its title, description,
 * comments, notes, design and labels — and narrowed by what it is:
 * `comment:cache status:open type:bug under:bw-12 after:7d`. Each card is
 * listed once with the places in it that matched, and opening one opens the
 * card. The box, the controls and the AI search are shared with every search
 * (src/search); this is the board's keys and how a card is drawn
 * (server/src/routes/beads/search.rs).
 */
'use client';

import { useMemo } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import { addressWith, cardWasPushed } from '@/lib/address';
import * as api from '@/lib/api';
import { ISSUE_TYPES } from '@/lib/issue-types';
import { Excerpt, Heading, PLACE, TITLE } from '@/search/parts';
import { Marked, Search } from '@/search/search';
import type { Choice, FilterSpec, Found, SearchSource, Segment } from '@/search/source';
import type { Grammar } from '@/search/syntax';
import { STATES } from '@/types';

export interface CardSnippet {
  field: 'description' | 'comment' | 'notes' | 'design' | 'label';
  author: string | null;
  segments: Segment[];
}

export interface CardMatch {
  id: string;
  title: string;
  titleSegments: Segment[] | null;
  status: string;
  issueType: string | null;
  priority: number | null;
  parentId: string | null;
  updatedAt: string | null;
  matches: number;
  snippets: CardSnippet[];
}

/** A card an agent found. */
export interface FoundCard extends Found {
  id: string;
  title: string;
  status: string;
  issueType: string | null;
  priority: number | null;
  updatedAt: string | null;
}

export const CARD_SCOPES: Choice[] = [
  { value: 'title', label: 'Title' },
  { value: 'desc', label: 'Description' },
  { value: 'comment', label: 'Comments' },
  { value: 'notes', label: 'Notes' },
  { value: 'design', label: 'Design' },
  { value: 'label', label: 'Labels' },
];

/** The states a card can be stored in; cancelled is closed and marked, never stored. */
const STORED = STATES.filter((state) => state.id !== 'cancelled');

const WHEN = ['today', 'yesterday', '7d', '30d', '1y'];

export const BOARD_GRAMMAR: Grammar = {
  keys: {
    title: 'title', name: 'title', id: 'title',
    desc: 'desc', description: 'desc', body: 'desc',
    comment: 'comment', comments: 'comment',
    notes: 'notes', note: 'notes',
    design: 'design',
    label: 'label', labels: 'label', tag: 'label', tags: 'label',
    in: 'in',
    status: 'status', state: 'status', is: 'status',
    type: 'type', kind: 'type',
    priority: 'priority', prio: 'priority',
    under: 'under', parent: 'under', epic: 'under',
    owner: 'owner', assignee: 'owner',
    after: 'after', since: 'after',
    before: 'before', until: 'before',
    on: 'on', during: 'on',
  },
  offered: ['title', 'desc', 'comment', 'notes', 'design', 'label', 'in', 'status', 'type', 'priority', 'under', 'owner', 'after', 'before', 'on'],
  values: {
    in: CARD_SCOPES.map((s) => s.value),
    status: STORED.map((s) => s.id),
    type: ISSUE_TYPES.map((t) => t.value),
    priority: ['0', '1', '2', '3', '4'],
    after: WHEN,
    before: WHEN,
    on: ['today', 'yesterday'],
  },
};

const FILTERS: FilterSpec[] = [
  { key: 'status', label: 'Status', choices: STORED.map((s) => ({ value: s.id, label: s.label })) },
  { key: 'type', label: 'Type', choices: ISSUE_TYPES.map((t) => ({ value: t.value, label: t.label })) },
  { key: 'priority', label: 'Priority', choices: ['0', '1', '2', '3', '4'].map((p) => ({ value: p, label: `P${p}` })) },
  {
    key: 'after',
    label: 'Changed',
    choices: [
      { value: 'today', label: 'Today' },
      { value: '7d', label: 'Past week' },
      { value: '30d', label: 'Past month' },
      { value: '1y', label: 'Past year' },
    ],
  },
];

const TIPS = [
  { example: 'under:bw-12', meaning: 'Under a card' },
  { example: 'after:2026-09-01', meaning: 'Changed since a day' },
];

const FIELD: Record<CardSnippet['field'], string> = {
  description: 'Description',
  comment: 'Comment',
  notes: 'Notes',
  design: 'Design',
  label: 'Label',
};

const stateLabel = (status: string) => STATES.find((s) => s.id === status)?.label ?? status;

function Meta({ card, matches }: { card: { status: string; issueType: string | null; priority: number | null; updatedAt: string | null }; matches?: number }) {
  return (
    <>
      <span data-testid="search-card-status">{stateLabel(card.status)}</span>
      {card.issueType && (
        <>
          <span>·</span>
          <span className="capitalize">{card.issueType}</span>
        </>
      )}
      {card.priority !== null && (
        <>
          <span>·</span>
          <span className="font-mono">P{card.priority}</span>
        </>
      )}
      {card.updatedAt && (
        <>
          <span>·</span>
          <span className="font-mono">{new Date(card.updatedAt).toLocaleDateString()}</span>
        </>
      )}
      {!!matches && <span className="rounded bg-muted px-1 font-mono">{matches}</span>}
    </>
  );
}

function Head({ id, title, children }: { id: string; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <Heading
      title={
        <>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{id}</span>
          <span data-testid="search-card-title" className={TITLE}>
            {title}
          </span>
        </>
      }
      meta={children}
    />
  );
}

/** The board's cards, as the shared search draws and opens them. */
export function useBoardSearch(projectPath: string): SearchSource<CardMatch, FoundCard> {
  const router = useRouter();
  const params = useSearchParams();

  return useMemo(() => {
    const go = (id: string) => {
      cardWasPushed();
      router.push(addressWith(params, { tab: 'board', card: id }));
    };
    return {
      words: {
        label: 'Search the board',
        placeholder: 'Search the board…',
        nothing: 'No cards.',
        grammar: BOARD_GRAMMAR,
        scopes: CARD_SCOPES,
        filters: FILTERS,
        tips: TIPS,
        sorts: [
          { value: 'relevance', label: 'Best' },
          { value: 'newest', label: 'Newest' },
          { value: 'priority', label: 'Priority' },
        ],
        find: async (q, sort, cursor) => {
          const query = new URLSearchParams({ path: projectPath, q, sort, cursor: String(cursor) });
          const answer = await api.request(`/api/beads/search?${query}`);
          if (!answer.ok) return { items: [], next: null };
          const page = (await answer.json()) as { cards: CardMatch[]; next: number | null };
          return { items: page.cards, next: page.next };
        },
        groups: (cards) =>
          cards.map((card) => ({
            key: card.id,
            testId: 'search-card',
            attrs: { 'data-card-id': card.id },
            head: {
              key: card.id,
              testId: 'search-card-open',
              open: () => go(card.id),
              body: (
                <Head id={card.id} title={card.titleSegments ? <Marked segments={card.titleSegments} /> : card.title}>
                  <Meta card={card} matches={card.matches} />
                </Head>
              ),
            },
            places: card.snippets.map((snippet, i) => ({
              key: `${card.id}-${i}`,
              testId: 'search-card-hit',
              attrs: { 'data-card-id': card.id, 'data-field': snippet.field },
              className: PLACE,
              open: () => go(card.id),
              body: (
                <Excerpt label={snippet.field === 'comment' && snippet.author ? snippet.author : FIELD[snippet.field]}>
                  <Marked segments={snippet.segments} />
                </Excerpt>
              ),
            })),
          })),
      },
      ask: {
        label: 'Describe the card',
        placeholder: 'Describe the card…',
        nothing: 'No cards.',
        url: '/api/beads/search/ask',
        body: { path: projectPath },
        row: (card) => ({
          key: card.id,
          testId: 'ai-search-card',
          attrs: { 'data-card-id': card.id },
          open: () => go(card.id),
          body: (
            <Head id={card.id} title={card.title}>
              <Meta card={card} />
            </Head>
          ),
        }),
      },
    };
  }, [projectPath, router, params]);
}

export function BoardSearchPanel({ projectPath, onClose }: { projectPath: string; onClose: () => void }) {
  const source = useBoardSearch(projectPath);
  return <Search source={source} onClose={onClose} />;
}
