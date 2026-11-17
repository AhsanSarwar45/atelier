---
name: atelier
description: Atelier's guidance, memory, presenter, browser and visual proof rules.
---

# Atelier

This session runs inside Atelier. Before any work below, read its detail in
`atelier-reference` or the named resource.

## Agent guidance and memory

- Change instructions, skills, commands or output styles in Atelier's
  library, not provider files, unless the user names one. Find the files
  with `atelier tool skills locations [--project PATH]`; never guess paths.
  Never edit `library-snapshots/` or `skill-bundles/`.
- Atelier memory replaces the provider's: never write native memory
  (`MEMORY.md`, provider `memory/` folders or memory tools), even if the
  provider says to. Read a memory with `atelier tool memory show
  ID` before relying on it.
- Save a memory only for a user decision or preference, a trap on this
  machine that can destroy work, or where something outside the repository
  is. Read the reference's memory rules first.

## Presenter

Use a widget, image, diagram or video when it makes a relationship, change
or comparison faster to grasp; do not use one for one fact or
a short list. First state the reader's question and the
takeaway, then pick by that comparison, not by what animates (see
`references/choosing-visuals.md`). It must make sense paused.

Never hand-author an `atelier-widget` or `atelier-image-compare` fence. Run
the Atelier presenter; the chat shows the result where the command ran.
Do not copy its stdout.

| Output | Command |
|---|---|
| Widget: `metrics`, `chart` (`bar`, `line`), `progress`, `timeline`, `table`, `explainer`, `video` | `atelier tool present widget`, JSON on stdin or `--input FILE` |
| Image | `atelier tool present image --file PATH --alt TEXT` |
| Before and after | `atelier tool present compare --before PATH --after PATH --before-alt TEXT --after-alt TEXT` |
| Diagram, scene or mockup | `atelier tool present artifact --file FILE` |

Video proof uses the `video` widget, not a file link. The presenter
uploads files to the running Atelier app, so reading is enough. Never
create or write `ATELIER_DATA_DIR` or `presentation-media`, or request
provider-specific filesystem permission.

## Browser

All Chrome work goes through Atelier's `chrome` MCP server, connected only
to this worktree's private Chrome. Chrome starts headless on the first
browser tool call. When the person asks to watch, run `atelier tool chrome up` first.

- Give each simulated user one `isolatedContext` name in `new_page` and
  reuse it for every page that user opens.
- Open pages with `background: true`. Close each page with `close_page`
  when done, and run `atelier tool chrome down` when the browser work is
  finished.
- Scripts: `eval "$(atelier tool chrome env)"`, Playwright
  `chromium.connectOverCDP(process.env.CDP_URL)`, one context per user.
- Never stop a browser by name (`pkill`, `killall`), pick a fixed port, or
  attach to a DevTools port or profile not given by `atelier tool chrome`.

## Visual proof

For every visual change, capture the screen before editing and again
afterward, and show both with `atelier tool present compare`. Show a newly
added visual with `atelier tool present image`. Do it before handing the
work back; do not wait for the manager to ask.

- A screen reached by clicking, typing or signing in: drive it with the
  `chrome` server and save it with `take_screenshot` and a `filePath`.
- A URL or recipe that needs a settled, judged frame: `atelier tool
  screen-check`, which uses its own throwaway Chrome. Do not point it at
  `atelier tool chrome`. Read `references/screen-check.md` first.
