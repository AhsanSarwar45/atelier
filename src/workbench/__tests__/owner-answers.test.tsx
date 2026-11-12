/**
 * The owner's answers to a task, a proposal or a grid reach the chat's agent
 * as a message in his place. They are drawn as a short muted line in his
 * words ("You approved #3"), not as a message he typed; what the agent was
 * told in full is a click away.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { ownerAnswer, ownerAnswers } from '@/workbench/owner-answer';
import type { LookableImage } from '@/workbench/protocol';
import { TranscriptRow } from '@/workbench/transcript-rows';
import type { TranscriptItem } from '@/workbench/use-session';

const MENTIONS: Mentions = { split: (text) => [{ kind: 'text', text }] };
const LOOK = (_image: LookableImage) => {};
const said = (role: 'user' | 'assistant', text: string): TranscriptItem =>
  ({ kind: 'message', id: `m-${role}`, role, text, images: [], done: true, parentId: null }) as TranscriptItem;
const line = (text: string) => ownerAnswer(text)?.line ?? null;

describe('the owner answer lines', () => {
  it('reads each answer the server writes as a line in his words', () => {
    // server/src/workbench/tasks/mod.rs, owner_prompt and answer_prompt.
    expect(line('Owner approved task #3 "Plan ghosts". It names no commits, so nothing is left to merge.')).toBe('You approved #3');
    expect(line('Owner approved task #1 "T". Its commits are on branch fix, not yet on main. Ask the owner whether to merge fix into main, and don\'t merge without their yes.')).toBe('You approved #1');
    expect(line('Owner reopened task #3 "Plan ghosts": Say what happens to the presets. Continue the work and run done again.')).toBe('You reopened #3: Say what happens to the presets.');
    expect(line('Owner reopened task #1 "T". Continue the work and run done again.')).toBe('You reopened #1');
    expect(line('Owner reopened task #1 "T": Fix it! Start it again with `atelier task start 1`, continue the work and run done again.')).toBe('You reopened #1: Fix it!');
    expect(line('Owner approved the plan change for task #1 "T": continue with the new plan.')).toBe('You approved the plan change for #1');
    expect(line('Owner rejected the plan change for task #1 "T": continue with the old plan.')).toBe('You rejected the plan change for #1');
    expect(line('Owner rejected the plan change for task #1 "T": keep the scope. Continue with the old plan.')).toBe('You rejected the plan change for #1: keep the scope.');
    expect(line('Owner chose Create task for proposal "Drop LUT": task #9 created. Start it with `atelier task start 9` and do the work.')).toBe('You created task #9 from the proposal');
    expect(line('Owner chose Just do it for proposal "Drop LUT": do the work without a task.')).toBe('You chose Just do it for “Drop LUT”');
    expect(line('Owner chose Cancel for proposal "Drop LUT": don\'t do this work.')).toBe('You cancelled the proposal “Drop LUT”');
    // server/src/workbench/grids/mod.rs.
    expect(line('Owner approved grid "camera" (2 rows × 2 columns). The cells start unchecked; work on them as tasks (`atelier grid show camera`).')).toBe('You approved grid camera');
    expect(line('Owner approved the edit to grid "camera" (2 rows × 3 columns). The cells start unchecked.')).toBe('You approved the edit to grid camera');
    expect(line('Owner discarded the draft of grid "camera". Don\'t draft it again unless the owner asks.')).toBe('You discarded the draft of grid camera');
    expect(line('Owner discarded the edit to grid "camera". Don\'t draft it again unless the owner asks.')).toBe('You discarded the edit to grid camera');
    expect(line('Owner approved N/A for camera.tonemap.presets; it no longer counts.')).toBe('You approved N/A for camera.tonemap.presets');
    expect(line('Owner rejected N/A for camera.tonemap.presets: it applies. The cell is gap again.')).toBe('You rejected N/A for camera.tonemap.presets');
    expect(line('Owner approved the change to template "renderer".')).toBe('You approved the change to template renderer');
  });

  it('leaves his own words alone', () => {
    expect(line('Owner approved this earlier, go on')).toBeNull();
    expect(line('please approve task #3')).toBeNull();
    expect(ownerAnswers('Owner approved task #3 "T". It names no commits, so nothing is left to merge.\n\nAnd also fix the header')).toBeNull();
  });

  it('reads answers held together, one to a paragraph', () => {
    const both = ownerAnswers('Owner approved task #3 "T". It names no commits, so nothing is left to merge.\n\nOwner reopened task #4 "U". Continue the work and run done again.');
    expect(both?.map((a) => a.line)).toEqual(['You approved #3', 'You reopened #4']);
  });

  it('draws an answer as a muted line, with the full text on unfolding', () => {
    const text = 'Owner approved task #3 "Plan ghosts". It names no commits, so nothing is left to merge.';
    render(<TranscriptRow item={said('user', text)} sessionId="s" mentions={MENTIONS} onLook={LOOK} />);
    expect(screen.queryByTestId('user-message')).toBeNull();
    expect(screen.getByTestId('owner-answer-line')).toHaveTextContent('You approved #3');
    expect(screen.queryByTestId('owner-answer-full')).toBeNull();
    fireEvent.click(screen.getByTestId('owner-answer-toggle'));
    expect(screen.getByTestId('owner-answer-full')).toHaveTextContent(text);
  });

  it('draws the agent saying the same words as the agent', () => {
    render(<TranscriptRow item={said('assistant', 'Owner approved task #3 "T". It names no commits.')} sessionId="s" mentions={MENTIONS} onLook={LOOK} />);
    expect(screen.getByTestId('assistant-message')).toBeVisible();
    expect(screen.queryByTestId('owner-answer')).toBeNull();
  });
});
