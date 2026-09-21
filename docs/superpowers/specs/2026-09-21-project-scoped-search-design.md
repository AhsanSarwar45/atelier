# Search starts in the project you are looking at

bw-c1ti · 2026-09-21

## The complaint

Search is one panel with three sources, chosen by the tab you are on
(`src/app/project/page.tsx`). Board and Files are already tied to the project:
they are handed `project.path` and the checkout root. Chats is not. Its own
header says "One search across every conversation, in every project", and the
`project:` menu starts empty, so opening search from the chat tab searches
every project you have ever opened. Almost every search made from inside a
project is a search of that project, so the common case is the one that takes
the most typing.

## What changes

The chats search opens with the current project already applied, in both of the
panel's modes.

### The box is seeded, not locked

`WordsSearch` gains an optional `seed`: what the box already says when the
search opens. The chats source sets it to `project:<name>`; Board and Files
leave it undefined. `Search` uses it as the initial value of `q` and never
touches it again, so the token is ordinary text.

That keeps this codebase's rule that the box is the query and every control
only writes into it. The Project menu reads the token back through
`controlsOf` and shows the project selected, with no special case. Deleting the
token, or choosing another project from the menu, searches wide again.

`withFilter` already quotes a value containing spaces, so a project whose name
has a space needs nothing extra.

### The panel learns which project it is in

`useChatSearch(projectId, projectPath)` resolves the project's name from the
projects list it already fetches for the Project menu, falling back to the
folder name its result rows already show. `SearchPanel` renders nothing until
that lookup settles, then mounts `Search` — the guard `FileSearchPanel` already
uses for its checkout root, and the reason is the same: searching the wrong
scope first would flash the wrong results.

Both call sites — `src/app/project/page.tsx` and `src/workbench/chat-tab.tsx` —
already hold the project id and path.

### Ask is pinned, not seeded

An agent handed a suggestion will drop it, so the AI ask is constrained on the
server instead. The panel sends `body: { project: name }`, the way Board sends
`{ path }` and Files sends `{ root }`. `Asking` gains `project: Option<String>`,
resolved once through `projects_named` into ids held on `Chats`. While those ids
are present, `search_chats` uses them in place of whatever the agent's own query
named. The tool description is built at runtime, so it names the project and the
agent does not spend calls discovering the boundary.

### Opening the panel now lists the project's recent chats

A query with filters and no words is not empty to the server: `search_chats`
returns the matching chats newest first. So the panel opens on this project's
recent chats rather than the tips screen, and typing narrows them. This needs no
code and makes the panel useful the moment it opens.

## What this does not cover

- Board and Files, which are already scoped.
- Remembering a scope between openings. The default is the current project every
  time; whatever you changed it to last time is not carried over.
- Any change to the search grammar. `project:` already exists on both the client
  and the server.

## How it is shown to work

- The chats source seeds `project:<name>`; Board and Files seed nothing.
- Deleting the token clears the Project menu, and choosing another project
  replaces the token rather than adding a second one.
- On the server, an ask pinned to one project stays there even when the agent's
  query names a different one.
- In the running app: search opened from the chat tab shows the token in the box
  and only this project's chats, captured in a screenshot.
