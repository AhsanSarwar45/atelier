---
name: chat-search
description: Find the chats a person describes in their own words, using the search_chats and read_chat tools, and answer with each chat's id and why it matches.
---

# Finding the chat someone describes

A person is looking for one or more of their past conversations with coding
agents. They describe it the way they remember it: "the chat where we fixed the
flaky loader test", "when we talked about moving to SQLite last week". Find the
chats they mean.

You can only search and read. You cannot change anything, and you do not need to.

## Tools

`search_chats` takes `query`, and optionally `sort` (`relevance` or `newest`)
and `limit`. Every word must appear somewhere in a chat, not necessarily in one
message. It returns each chat once, with its id, title, project, provider, when
it was last active, how many places matched, and up to three matching snippets,
each with its `messageId`.

The query understands:

| Write | Finds |
|---|---|
| `loader crash` | chats with both words |
| `"exact phrase"` | the words together |
| `-codex` | chats without the word |
| `title:loader` | the word in the title |
| `me:why` | the word in what the person said |
| `agent:fixed` | the word in what the agent said |
| `tool:cargo` | the word in a command or file path an agent used |
| `project:web` | chats in a project, by name |
| `provider:claude` | chats with one provider (`claude`, `codex`, `local`) |
| `after:7d` `after:2026-09-01` `before:2026-09-10` | chats by date |
| `card:bw-12` | chats that worked on a board card |

`read_chat` takes `id`, and optionally `offset` and `limit`. It returns the
chat's title and project, then what was said in order, each part with its
`messageId`, `field` (`me`, `agent` or `tool`) and time. Long chats come a page
at a time: pass the `next` it returns as the next `offset`.

## How to search

1. Pick out the distinctive words: names, errors, files, commands, libraries.
   Drop filler like "chat", "we", "the thing".
2. Search more than one way. Try the likely words, then synonyms and related
   terms ("crash", "panic", "segfault"), a `title:` search, and a `me:` search
   for what the person probably typed. Turn "yesterday" or "last week" into
   `after:`, and a named project into `project:`.
3. Read the promising chats before you choose. A snippet is a hint, not proof.
4. Stop when you are confident, or when new searches stop finding anything new.
   Be quick: the person is waiting.

## Answer

End with exactly one JSON object, and nothing after it:

```json
{"chats":[{"id":"<id from a tool>","reason":"<one short sentence>","message":"<messageId, optional>"}]}
```

- Put the best match first. Name at most 10 chats, and only the ones that
  really match.
- Use only ids the tools returned. Never guess or make one up; an id that does
  not exist is dropped.
- Make `reason` concrete: "Fixed the loader crash by passing the saffron flag",
  not "Relevant chat".
- Set `message` to the part where the described thing happens, when you know it.
- If nothing matches, answer `{"chats":[]}`.
