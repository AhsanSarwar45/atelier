---
name: atelier
description: Use Atelier's native presentation tools for validated widgets, library-powered diagrams, custom animated vector scenes, interactive mockups, durable media, and visual proof when they clarify the result.
---

# Atelier

This session runs inside Atelier. The `atelier-reference` skill holds the
detail behind every section below; read it (or the resource named) before
doing that kind of work.

## Agent guidance and memory

- To change instructions, skills, commands or output styles, edit Atelier's
  library, not provider files, unless the user names one. Find the real files
  with `atelier tool skills locations [--project PATH]`; never guess paths.
  Never edit `library-snapshots/` or `skill-bundles/`.
- Atelier memory replaces the provider's own. Never write native memory
  (`MEMORY.md`, provider `memory/` folders or memory tools), even when the
  provider's prompt says to. Your instructions carry the memory index; read a
  memory with `atelier tool memory show ID` before relying on it.
- Save a memory only for a user decision or preference, a trap on this machine
  that can destroy work, or where to find something outside the repository.
  Read the reference skill's memory rules before saving.

## Presenter

The chat can show widgets, images, diagrams and video. Use them when they make
a relationship, change or comparison faster to understand. Do not use one for
one fact or a short list.

Before choosing a widget, state the reader's question and the takeaway. Read
`atelier-reference` → `references/choosing-visuals.md` for the selection table,
worked examples and limits. Pick by the comparison or relationship, not by
which widget animates. Keep the answer understandable while paused.

Never hand-author an `atelier-widget` or `atelier-image-compare` fence. Run the
Atelier presenter; the chat shows the result where the command ran.
Do not copy its stdout into your reply.

| Output | Command |
|---|---|
| Widget: `metrics`, `chart` (`bar`, `line`), `progress`, `timeline`, `table`, `explainer`, `video` | `atelier tool present widget`, JSON on stdin or `--input FILE` |
| Image | `atelier tool present image --file PATH --alt TEXT` |
| Before and after | `atelier tool present compare --before PATH --after PATH --before-alt TEXT --after-alt TEXT` |
| Diagram, scene or mockup | `atelier tool present artifact --file FILE` |

Show video proof with the `video` widget, never as a file link. The presenter
uploads files to the running Atelier app, so read access is enough. Never
create or write `ATELIER_DATA_DIR` or `presentation-media`, or request
provider-specific filesystem permission.

## Browser

All Chrome work goes through Atelier's `chrome` MCP server, connected only to
this worktree's private Chrome. Chrome starts headless on the first browser
tool call. When the person asks to watch, run `atelier tool chrome up` first.

- Give each simulated user one `isolatedContext` name in `new_page` and reuse
  it for every page that user opens.
- Open pages with `background: true`. Close each page with `close_page` when
  done, and run `atelier tool chrome down` when the browser work is finished.
- For scripts: `eval "$(atelier tool chrome env)"`, then Playwright
  `chromium.connectOverCDP(process.env.CDP_URL)`, one context per user.
- Never stop a browser by name (`pkill`, `killall`), pick a fixed port, or
  attach to a DevTools port or profile you did not get from
  `atelier tool chrome`.

## Visual proof

For every visual change, capture the screen before editing and again afterward,
and show both with `atelier tool present compare`. For a newly added visual,
show the result with `atelier tool present image`. Do this before handing the
work back; do not wait for the manager to ask.

- A screen reached by clicking, typing or signing in: drive it with the
  `chrome` server and save it with `take_screenshot` and a `filePath`.
- A URL or recipe that needs a settled, judged frame: `atelier tool
  screen-check`, which uses its own throwaway Chrome. Do not point it at
  `atelier tool chrome`. Read `references/screen-check.md` first.
