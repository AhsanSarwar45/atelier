/**
 * One report exercising every part and every block kind, shared by this
 * card's own tests and (later) the screen-work card that puts the address
 * bar and contents rail around a report — kept here rather than inlined in
 * a single test file so that card can import it too.
 */
import type { ReportSpec } from '@/components/report/types';

// A 1x1 transparent PNG — real image bytes, small enough to inline, so an
// `<img>` actually has something to decode rather than an empty string.
export const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export const REPORT_FIXTURE: ReportSpec = {
  slug: 'demo',
  project: 'demo-project',
  title: 'Demo report',
  eyebrow: 'Weekly',
  actions: {
    none: false,
    fyi: null,
    questions: [
      {
        id: 'q1',
        ask: 'Ship the new onboarding flow this week?',
        options: [
          { label: 'Yes, ship it', say: 'Ship the onboarding flow this week.', pick: true },
          { label: 'Hold for now', say: 'Hold the onboarding flow.' },
        ],
        note: 'Affects new signups only.',
        holds: 'card-42',
        live: true,
        card: { id: 'card-42', title: 'Onboarding flow', status: 'open', column: 'in_progress' },
      },
      {
        id: 'q2',
        ask: 'Old settled question kept for history',
        options: [{ label: 'Yes', pick: true }],
        note: null,
        holds: 'card-9',
        live: false,
        card: { id: 'card-9', title: 'Old card', status: 'closed', column: 'done' },
      },
    ],
  },
  status: {
    card: null,
    now: 'Building the shelf components',
    next_up: 'Wiring the screen around it',
    items: [
      { state: 'done', text: 'Types and tone mapping', tag: null, card: null },
      { state: 'draft', text: 'Block components', tag: 'in review', card: null },
      { state: 'todo', text: 'Screen chrome', tag: null, card: null },
    ],
  },
  content: [
    {
      id: 's1',
      label: 'All twelve block kinds',
      lead: 'One of every block kind the shelf can draw, for the test suite and the later screen card to share.',
      blocks: [
        { kind: 'text', text: 'A single sentence block.' },
        { kind: 'list', items: ['First item', 'Second item'], ordered: false },
        {
          kind: 'rows',
          rows: [
            { n: '01', title: 'Hot row', note: 'worth a second look', tone: 'hot' },
            { n: '02', title: 'Gone row', note: 'no longer applies', tone: 'gone' },
            { title: 'Plain row' },
          ],
        },
        { kind: 'note', tone: 'warn', label: 'Heads up', text: 'A note block with a label.' },
        {
          kind: 'table',
          columns: ['Name', { name: 'Count', align: 'num' }],
          rows: [
            [{ bold: 'Alpha' }, { num: 12 }],
            [{ pill: 'beta', tone: 'blue' }, 7],
          ],
        },
        {
          kind: 'tiles',
          tiles: [
            { key: 'Open', value: 12, tone: 'blue', delta: '+2' },
            { key: 'Closed', value: 40, tone: 'green', delta: null },
          ],
        },
        {
          kind: 'bars',
          series: [
            { label: 'Alpha', value: 12, tone: 'blue' },
            { label: 'Beta', value: 7, tone: 'amber' },
          ],
          unit: 'pt',
          alt: 'bars alt text',
        },
        {
          kind: 'breakdown',
          parts: [
            { label: 'Done', value: 6, tone: 'green' },
            { label: 'Left', value: 4, tone: 'grey' },
          ],
          unit: '',
          alt: 'breakdown alt text',
        },
        {
          kind: 'trend',
          x: ['Mon', 'Tue', 'Wed'],
          lines: [{ label: 'Errors', values: [3, 5, 2], tone: 'red' }],
          unit: '',
          alt: 'trend alt text',
        },
        {
          kind: 'images',
          shots: [
            { src: PNG, caption: 'Shot one' },
            { src: PNG, caption: 'Shot two' },
          ],
        },
        {
          kind: 'compare',
          before: { src: PNG, caption: 'Before' },
          after: { src: PNG, caption: 'After' },
        },
        {
          kind: 'wipe',
          before: { src: PNG, caption: 'Old' },
          after: { src: PNG, caption: 'New' },
        },
      ],
    },
  ],
  decisions: [
    { id: 'D1', title: 'Use SVG charts', why: 'No chart library dependency.', tag: 'architecture', needs_you: false },
    { id: 'D2', title: 'Ship without a dark-mode preview', why: 'Screen card not ready yet.', tag: null, needs_you: true },
  ],
  next: {
    if_nothing: 'The current plan keeps running as scheduled.',
    steps: [
      { step: 'Finish block components', cost: 'small', starting: true },
      { step: 'Wire the screen chrome', cost: 'medium', starting: false },
      { step: 'Ship to users', cost: 'large', starting: false },
    ],
  },
  glossary: [{ term: 'shelf', plain: 'the set of block components a report is built from' }],
  warnings: [],
  built_at: '2026-08-19T00:00:00Z',
  board: { reachable: true, why: null },
};
