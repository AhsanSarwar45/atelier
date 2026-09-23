# Chat name template (bw-mv45)

A project decides what its chats are called. The manager arranges parts into a
template in the project's settings, and every chat name the server hands out
follows it: the rail, the tray, push notifications, search, card chats and the
memory report.

## Parts

| Part | Settings | Value |
|---|---|---|
| Chat title | none | The chat's title, from the agent. |
| Extracted text | source, regex | The first match of the regex in the source. With a capture group, the first group. |
| Text | text | The text itself, used as a separator. |

The sources are:

- **Worktree**: the name of the checkout folder the chat is working in.
- **Branch**: the branch checked out there.
- **Folder path**: the chat's full working directory.

Stored in the manifest (`.atelier/project.toml` or the personal copy):

```toml
[[chat_name.parts]]
kind = "extract"
source = "worktree"
pattern = "bw-[a-z0-9]+"

[[chat_name.parts]]
kind = "text"
text = ": "

[[chat_name.parts]]
kind = "title"
```

## Rules

1. A name the owner typed by hand is shown exactly as typed, and the template
   is skipped. A new `session.named_by_owner` column records this, and it is
   backfilled from the `session.pinned` events marked `titleSource: "user"`.
2. A part with no value (no title yet, no match) is empty.
3. A text part is kept only when the value parts on both sides of it have
   values. A separator never dangles.
4. A blank result falls back to the old rule: title, then folder, then
   "<Brand> chat". No template means the old rule.
5. Saving is refused when a regex does not compile, a text part is empty, or
   the template has no title part and no extracted-text part. A bad regex put in
   the file by hand is skipped when names are built. It is never fatal.

## Server

- `workbench::chat_name` holds the pure renderer, the facts read from a chat's
  directory (worktree and branch, read from `.git` with no subprocess), and a
  short-lived cache of each project's compiled template. Saving the project's
  settings clears the cache.
- Every place that called `notice::naming` for a chat calls
  `chat_name::name_of` instead.
- `POST /api/projects/:id/chat-name-preview` renders a draft template against
  the project's most recent chats. It returns each chat's current and new name,
  plus the error for each part. The editor's preview uses the same code as the
  real names.

## Editor

A "Chat names" section in project settings:

- The template is a row of chips. They are reordered by dragging with
  `@dnd-kit/sortable`, which also supports the keyboard.
- An add menu offers Chat title, Extracted text and Text.
- Clicking a chip opens its editor: a source picker and a regex field for
  extracted text, or a text field for text. Each chip has a remove button.
- A live preview lists recent chats with their current and new names.
- A preset button, "Ticket key from worktree", fills in the template
  `[key from worktree] [: ] [Chat title]`, using the board's issue prefix.
