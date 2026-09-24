# UI library audit (bw-weih)

The rule: every piece of UI in the app is drawn by a component from the shared
library in `src/components/ui/`. No screen builds its own popup, menu, button,
row, tab, divider or badge, and no screen reshapes a library part with
`className` into a different component.

This audit was done on 2026-09-24, over the 140 `.tsx` files outside
`src/components/ui/` and the tests. It was triggered by the delete-file
confirmation, which was drawn with no box and no dim. That was the library's
own `AlertDialog`: it had been copied from a Base UI project and painted
colours this app never defines. It was fixed in bw-weih.1.

## What was found

Raw HTML controls are nearly gone. Four remain: the screen-reader-only
`<button>` on each board card (`bead-card.tsx:131`, `epic-card.tsx:117`, moved
in batch 7), and two hidden form mirrors with no library equivalent
(`chat-tab.tsx:901` file input, `composer-editor.tsx:392` textarea). What
remains falls into three kinds:

1. **Library parts reshaped by `className`.** A `Button` forced into a list
   row, recoloured instead of given a variant, or sized with `h-5` instead of
   a size. A `Badge` padded by hand. A `Panel` repainted.
2. **Hand-built pieces.** Popups and drawers with their own portal, backdrop
   and Escape handling; tab strips made of `role="tab"` divs; dividers drawn
   as `h-px` divs; progress bars; status dots; chips; raw `<a>` links;
   clickable spans and images that are not buttons at all.
3. **Library gaps.** Things several screens need that the library does not
   offer, so each screen builds its own.

About 160 findings in 73 files. Most are small.

## Library gaps

Each of these is added to `src/components/ui/` before the screens that need
it are moved onto it.

| Gap | Hand-built today in | Library part |
|---|---|---|
| Spinner, and a loading state on `Button` | about 40 `Loader2 animate-spin` in 25 files | `Spinner` (`spinner.tsx`), `Button loading` |
| Switch | shared-library | `Switch` (`switch.tsx`) |
| Collapsible (disclosure) | shared-library, active-guidance, bead-detail, transcript-rows, sent-away, git-diff-view, chat-tab todo panel, mcp-servers-panel | `Collapsible`, `CollapsibleTriggerRow`, `CollapsibleContent` (`collapsible.tsx`) |
| Toggle group (segmented single choice) | file-preview, commit-search, picture-viewer, visual-artifact-view, start-from-card, where-to-work, chat-tab, catalogue category bars, search scope | `ToggleGroup`, `ToggleGroupItem` (`toggle-group.tsx`) |
| Button group (split button) | chat-sidebar, chat-tab | `ButtonGroup` (`button-group.tsx`) |
| Tiny button size (20 px) | file-viewer, file-preview, commit-details, filter-tree, chat-tab, terminal-tabs | `Button size="2xs"` (with `mode="icon"` for icon-only) |
| Input with icon slots and a size | commit-search, mcp-catalogue, plugin-catalogue (`QueryBox` in `src/search/parts.tsx` already does this) | `Input size="sm"` with `start` / `end`; `QueryBox` now wraps it |
| Progress with a tone | usage-view, token-view, transcript-rows | `Progress tone` |
| Separator used everywhere a divider is drawn | about 20 `h-px` / `border-t` divs | `Separator` (already in the library) |
| Context menu at the pointer | menu-anchor (used by path-menu, agent-files-browser, file-tree) | `ContextMenu` (`context-menu.tsx`); `PointerAnchor` (`point-anchor.tsx`) for a `DropdownMenu` at a point |
| Popover at a selection | file-viewer, diff-table "Copy text" boxes | `PopoverAtPoint` (`point-anchor.tsx`) inside a `Popover` |
| A sheet held inside a box rather than the window | chat-tab, files-tab, chat-right-rail phone drawers, terminal-history | `Sheet contained`, with `docked` (a plain column on wide screens) and `forceMount` (kept drawn, inert, while shut) |
| Closable editor tabs | open-files-strip, terminal-tabs | `TabsList variant="strip"` with `TabsTrigger onClose` |
| Table | chat-widget-view | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` (`table.tsx`) |
| Confirmation (`AlertDialog`) | project-settings and dependencies-settings `window.confirm`; shared-library, file-actions, git-view and usage-view faking it with `Dialog role="alertdialog"` | `AlertDialog` (already in the library); `AlertDialogContent shape="sheet"` for the usage reset |
| Tag colour on `Badge` | page, project-card, tag-picker use inline hex styles | `Badge color` (with `colorFill`) |
| Success tone on `Button` | sign-off, update-banner | `Button variant="success"` |
| A lasting notice in the window's corner | update-banner | `Notice` (`notice.tsx`) |
| A portal into a slot or onto the body | shell toolbar slots, terminal-window | `Portal` (`portal.tsx`) |
| A non-modal floating window | terminal-window | `FloatingWindow` (`floating-window.tsx`) |
| A row laid out as a line of pieces, and a row heading its own box | the rows below | `Row gap`, `Row inset="xs"`, `Row look="quiet"` |
| A quiet link, a success link, a link inside a sentence | accounts-settings, update-banner, the raw `<a>` links, copyable-text, path-chip | `Button mode="link"` with `variant="dim"` / `variant="success"` / `size="inherit"` |

## Left alone on purpose

These are specialised widgets with no library equivalent. They keep their own
drawing but use library parts for any ordinary control inside them.

- The code editor, terminal pane, diff cells, status donut, token bar and
  diagram nodes in chat widgets.
- The before/after wipe handle in image-comparison and picture-viewer.
- Draggable dividers (`split-column`, `resize-divider`), and the drag and
  resize handles of the terminal's floating window. The window's frame is the
  library's `FloatingWindow`.
- Hidden form mirrors (`chat-tab.tsx:901` file input, `composer-editor.tsx:392`
  textarea).
- Colour swatches whose colour is the data (color-picker, theme-switcher).
- A file chip in the line that opens a tool row (`transcript-rows.tsx`, set
  through `ChipsInAControl` in `path-chip.tsx`). That line is itself a button,
  and a button cannot hold another one: the browser closes the outer one at the
  inner one's tag. The chip there stays a marked `span` that the conversation's
  listener answers; the same file is a button in the row's body and header.

## Findings by file

`path:line | what is hand-built | library replacement`

### Popups and drawers (done in bw-weih.4)

- `modal-layer.tsx` → deleted; project settings use `Overlay`
- `visual-artifact-view.tsx` full-screen view → `Overlay`, closing on Escape
- `project-settings-screen.tsx` delete-project `window.confirm` → `AlertDialog`
- `shared-library.tsx` hand-set `role="alertdialog"` → `AlertDialog`; the discard-draft `window.confirm` → `AlertDialog` too
- `dependencies-settings.tsx` install-tracker `window.confirm` → `AlertDialog`
- `file-actions.tsx` delete question → its own `AlertDialog`; the name box stays a `Dialog`
- `git-view.tsx` confirmation → `AlertDialog`
- `usage-view.tsx` reset confirmation → `AlertDialog` with `AlertDialogContent shape="sheet"`
- `terminal-history.tsx` in-pane popup → `Sheet contained`
- `file-viewer.tsx`, `diff-table.tsx` "Copy text" box → `Popover` with `PopoverAtPoint`
- `menu-anchor.tsx` → already a re-export of the library's `PointerAnchor`; unchanged
- `chat-right-rail.tsx`, `chat-tab.tsx`, `files-tab.tsx` drawers and scrims → `Sheet contained` with `docked` and `forceMount`
- `update-banner.tsx` slide-in notice → `Panel` placed by `Notice`
- `terminal-window.tsx` portal and hand-set `role="dialog"` → `FloatingWindow`; the drag and resize handles stay the terminal's
- `shell.tsx` toolbar-slot portals → `Portal`

### Buttons reshaped into rows (done in bw-weih.5)

`Row` gained `gap` (a row laid out as a line of pieces), `inset="xs"` and `look="quiet"` (a row heading a box of its own, which lifts its words instead of filling).

- `agent-files-browser.tsx` file list and "Available to create" → `Row gap="lg"`, the open file `selected`
- `bead-detail.tsx` related tasks → `Row gap="md"`
- `folder-browser.tsx` folder options → `Row role="option"`, the chosen folder `selected`; the beads bar on its edge stays
- `tag-picker.tsx` tag list and "Create new tag" → `Row gap="md"`
- `subtask-list.tsx` sub-tasks → `Row gap="md"`, top-aligned
- `chat-tab.tsx` checklist header → `Row gap="md"`
- `commit-log.tsx` commits → `Row inset="xs"`, the open commit `selected`; the bar down its edge stays
- `git-diff-view.tsx` file line → `Row look="quiet"`
- `terminal-history.tsx` commands → `Row inset="xs"`, the one the arrows are on `selected`
- `transcript-rows.tsx` "Show all lines" → `Row inset="xs"`; tool, note and thinking lines → `Row look="quiet"` (the note line keeps its family colour and brightens instead)
- `sent-away.tsx` "show the finished" toggle → `Row gap="sm" inset="xs"`
- `filter-tree.tsx` kind name → `Row look="quiet"`
- `card-live.tsx` `<a>` → `Row asChild` around the link

### Links, clickable spans and images (done in bw-weih.5)

`Button mode="link"` gained a quiet muted link (`variant="dim"`), a success-coloured one (`variant="success"`), an inline form for a link inside a sentence (`size="inherit"`), and a focus ring.

- `shared-library.tsx`, `provider-settings-panel.tsx`, `transcript-rows.tsx` raw `<a>` → `Button mode="link" underlined="solid" size="inherit" asChild`
- `accounts-settings.tsx` "Enter a sign-in code" → `Button mode="link" variant="dim" underlined="solid"`
- `update-banner.tsx` "Update & Restart" → `Button mode="link" variant="success"`; "Skip this version" and "Details" beside it → `Button mode="link" variant="dim"`
- `commit-details.tsx` "More" / "Less" and the parent commits → `Button mode="link" variant="foreground" size="2xs"`
- `copyable-text.tsx` clickable `<span>` → `Button mode="link" size="inherit"`, with the band reach on a phone
- `attachment-grid.tsx` clickable `<img>` → the picture inside a `Button`
- `path-chip.tsx` link chip → `Button mode="link" size="inherit"`; the chips built into painted HTML are the same button spelled out from `buttonVariants`; the listener is unchanged
- `git-view.tsx` file name → `Button mode="link" size="inherit"` with the row reach; the listener is unchanged

### Dividers (done in bw-weih.6)

`h-px` / `border-t` / `<hr>` divs drawn as dividers → `Separator`, which draws every divider in the one border colour; a divider's spacing stays a margin on it.

- `bead-detail.tsx` lines under Description, Design, Notes, Related Tasks and Subtasks → `Separator`
- `comment-list.tsx` line under the heading → `Separator`
- `tag-picker.tsx` line above "Create new tag" → `Separator`
- `search.tsx` line between the scopes and the filters → `Separator orientation="vertical"`
- `card-chats.tsx`, `start-from-card.tsx` line under the heading → `Separator`
- `chat-tab.tsx` checklist's top edge → `Separator`, drawn while the list is open
- `chat-widget-view.tsx` line above the evidence → `Separator`
- `dependencies-settings.tsx` edge under each tool → `Separator` between tools
- `memory-badge.tsx` lines before Processes and Docker containers → `Separator`
- `visual-artifact-view.tsx` mock-up divider `<hr>` → `Separator decorative={false}`, still read out as a separator

### Badges, chips, dots and bars

- Status dots drawn by hand → `BadgeDot`: `epic-card.tsx:164-179`, `app/page.tsx:185`, `tag-picker.tsx:150`, `file-viewer.tsx:105`, `open-files-strip.tsx:135`, `transcript-rows.tsx:575, 655`, `token-view.tsx:275`
- Chips drawn by hand → `Badge`: `agent-files-browser.tsx:235`, `board-search.tsx:153`, `search-panel.tsx:107`, `settings/chat-name-editor.tsx:280`, `visual-artifact-view.tsx:99`, `chat-widget-view.tsx:119`
- `Badge` sized or padded by hand instead of `size` → `dependency-badge.tsx:70, 101`, `kanban-column.tsx:156`, `path-chip.tsx:84`, `globals.tsx:104`
- `Badge` coloured by inline style or fixed classes → `app/page.tsx:125`, `project-card.tsx:140`, `tag-picker.tsx:240`, `brand-icon.tsx:43`
- Progress bars drawn by hand → `Progress`: `transcript-rows.tsx:1001`, `usage-view.tsx:78`, `token-view.tsx:327`
- Status checkbox drawn by hand → `Checkbox`: `chat-tab.tsx:710`

### Panels and banners repainted

- Error, warning and info strips painted by hand → `Panel tone`: `agent-files-browser.tsx:243`, `chat-sidebar.tsx:761, 775`, `file-viewer.tsx:367, 377, 384`, `chat-tab.tsx:885, 890, 2517, 2742`
- Bordered list boxes copying Panel → `Panel tone="frame"`: `mcp-catalogue.tsx:241`, `plugin-catalogue.tsx:202`, `accounts-settings.tsx:329`
- `Panel` recoloured instead of `tone`: `visual-artifact-view.tsx:103, 144`, `transcript-rows.tsx:1274, 1438`, `picture-viewer.tsx:92, 219`
- Option cards copying Panel: `transcript-rows.tsx:1410`
- Local `Card` shadowing the library name: `token-view.tsx:176`
- `add-project-dialog.tsx:225` | ghost `Button` wearing Panel classes

### Tabs, toggles, switches and disclosures

- Tab strips built from `role="tab"` → `Tabs`: `open-files-strip.tsx:83`, `terminal-tabs.tsx:73`
- Single choice from primary/outline `Button`s → toggle group or `RadioGroup`: `file-preview.tsx:172`, `commit-search.tsx:115`, `picture-viewer.tsx:220`, `visual-artifact-view.tsx:87`, `start-from-card.tsx:66`, `where-to-work.tsx:196, 263`, `chat-tab.tsx:2228`, `transcript-rows.tsx:1279`, `shared-library.tsx:214`
- `Checkbox` used for a single-choice question → `RadioGroup`: `transcript-rows.tsx:1414`
- Hand-drawn switch → `Switch`: `shared-library.tsx:246`
- `<details>` disclosures → Collapsible: `bead-detail.tsx:411, 423`, `active-guidance.tsx:26`, `shared-library.tsx:231, 232, 249, 255, 295, 300, 301, 302`, `transcript-rows.tsx:1424`, `mcp-servers-panel.tsx:75`
- Split buttons → button group: `chat-sidebar.tsx:709`, `chat-tab.tsx:371`
- Native `<datalist>` → `Picker`: `add-project-dialog.tsx:370`
- Native `title=` hover text → `Tooltip`: `where-to-work.tsx:204`

### Buttons restyled by class

Buttons resized, recoloured or rounded by `className` where the library has,
or will have, a size, variant or radius for it.

- `chat-tab.tsx:300, 450, 995, 1009, 1024, 2843, 2982, 3019, 3050`
- `file-viewer.tsx:290-354, 388`
- `file-preview.tsx:275`
- `commit-details.tsx:143`
- `filter-tree.tsx:117`
- `open-files-strip.tsx:141`
- `terminal-tabs.tsx:121, 132, 169`
- `terminal-history.tsx:111, 255`
- `usage-view.tsx:472`, `token-view.tsx:393`
- `transcript-rows.tsx:1463`
- `held-messages.tsx:94, 108, 122`
- `accounts-settings.tsx:366`
- `settings-screen.tsx:80`, `shell.tsx:314` (ToolButton)
- `tag-picker.tsx:111`
- `branch-picker.tsx:90`
- `markdown-body.tsx:178`
- `create-bead-dialog.tsx:125` (Input)
- `sign-off.tsx:62`
- `picture-viewer.tsx:93, 226`
- `git-view.tsx:894` (Picker)
- `commit-search.tsx:60-85, 70, 125, 219` (Input)
- `mcp-catalogue.tsx:200`, `plugin-catalogue.tsx:161` (search icon over Input)
- `chat-widget-view.tsx:213, 218`
- `dependencies-settings.tsx:87`
- `project-switcher.tsx:107` (inline rotate)

### Board cards

- `bead-card.tsx:131-318`, `epic-card.tsx:117-311` | clickable card surfaces in three layouts, each a `div` copying Card styling with a screen-reader-only raw `<button>` | `Card` with an interactive variant
- `file-tree.tsx:454`, `filter-tree.tsx:105` | tree rows as clickable `div role="treeitem"` | `Row`

## How the work is split

Each batch lands on its own, so `main` never holds a half-moved screen.

1. Library additions: the gaps above.
2. Popups and drawers.
3. Rows, links, clickable spans and images.
4. Dividers, badges, dots and progress bars.
5. Tabs, toggles, switches, disclosures and button groups.
6. Buttons, inputs and pickers restyled by class, and spinners.
7. Board cards and tree rows.
