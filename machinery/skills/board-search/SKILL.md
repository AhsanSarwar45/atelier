---
name: board-search
description: Find the board cards a person describes in their own words, using the search_cards and read_card tools, and answer with each card's id and why it matches.
---

# Finding the card someone describes

A person is looking for one or more cards on their project's board. They
describe it the way they remember it: "the bug where the loader stalled",
"the card where we decided to keep SQLite", "whatever Sam commented on about
the cache". Find the cards they mean.

You can only search and read. You cannot change anything, and you do not need to.

## Tools

`search_cards` takes `query`, and optionally `sort` (`relevance`, `newest` or
`priority`) and `limit`. Every word must appear somewhere in a card, not
necessarily in one part. It returns each card once, with its id, title, status,
type, priority, parent, when it last changed, how many places matched, and up to
three matching snippets.

The query understands:

| Write | Finds |
|---|---|
| `loader stall` | cards with both words |
| `"exact phrase"` | the words together |
| `-sqlite` | cards without the word |
| `cache OR counts` | either word |
| `title:loader` | the word in the title or id |
| `desc:stall` | the word in the description |
| `comment:sam` | the word in a comment |
| `notes:` `design:` | the word in the notes or the design |
| `label:area:board` | a label |
| `status:open` | by status (`open`, `in_progress`, `inreview`, `manager_review`, `closed`); `-status:closed` leaves them out |
| `type:bug` | by type (`task`, `bug`, `feature`, `epic`, `chore`, …) |
| `priority:1` | by priority, 0 the most urgent |
| `under:bw-12` | cards anywhere under a card |
| `owner:sam` | by owner |
| `after:7d` `after:2026-09-01` `before:2026-09-10` | by when the card last changed |

`read_card` takes `id`. It returns the whole card: its description, design,
notes, every comment with its author, its parent, and the cards under it.

## How to search

1. Pick out the distinctive words: names, errors, files, commands, features.
   Drop filler like "card", "ticket", "the thing".
2. Search more than one way. Try the likely words, then synonyms and related
   terms ("crash", "panic", "hang"), a `title:` search, and a `comment:` search
   for what someone probably wrote. Turn "last week" into `after:`, "the bug"
   into `type:bug`, "still open" into `-status:closed`.
3. Read the promising cards before you choose. A snippet is a hint, not proof.
4. Stop when you are confident, or when new searches stop finding anything new.
   Be quick: the person is waiting.

## Answer

End with exactly one JSON object, and nothing after it:

```json
{"cards":[{"id":"<id from a tool>","reason":"<one short sentence>"}]}
```

- Put the best match first. Name at most 10 cards, and only the ones that
  really match.
- Use only ids the tools returned. Never guess or make one up; an id that does
  not exist is dropped.
- Make `reason` concrete: "Sam's comment traces the stall to the cobalt cache",
  not "Relevant card".
- If nothing matches, answer `{"cards":[]}`.
