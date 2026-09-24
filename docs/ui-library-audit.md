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

No file uses a raw `<button>`, `<input>`, `<textarea>` or `<select>`. That part
of the rule was already met. What remains falls into three kinds:

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

| Gap | Hand-built today in |
|---|---|
| Spinner, and a loading state on `Button` | about 40 `Loader2 animate-spin` in 25 files |
| Switch | shared-library |
| Collapsible (disclosure) | shared-library, active-guidance, bead-detail, transcript-rows, sent-away, git-diff-view, chat-tab todo panel, mcp-servers-panel |
| Toggle group (segmented single choice) | file-preview, commit-search, picture-viewer, visual-artifact-view, start-from-card, where-to-work, chat-tab, catalogue category bars, search scope |
| Button group (split button) | chat-sidebar, chat-tab |
| Tiny button size (20 px) | file-viewer, file-preview, commit-details, filter-tree, chat-tab, terminal-tabs |
| Input with icon slots and a size | commit-search, mcp-catalogue, plugin-catalogue (`QueryBox` in `src/search/parts.tsx` already does this) |
| Progress with a tone | usage-view, token-view, transcript-rows |
| Separator used everywhere a divider is drawn | about 20 `h-px` / `border-t` divs |
| Context menu at the pointer | menu-anchor (used by path-menu, agent-files-browser, file-tree) |
| Popover at a selection | file-viewer, diff-table "Copy text" boxes |
| A sheet held inside a box rather than the window | chat-tab, files-tab, chat-right-rail phone drawers |
| Closable editor tabs | open-files-strip, terminal-tabs |
| Table | chat-widget-view |
| Confirmation (`AlertDialog`) | project-settings `window.confirm`, shared-library and file-actions faking it with `Dialog role="alertdialog"` |
| Tag colour on `Badge` | page, project-card, tag-picker use inline hex styles |
| Success tone on `Button` | sign-off, update-banner |

## Left alone on purpose

These are specialised widgets with no library equivalent. They keep their own
drawing but use library parts for any ordinary control inside them.

- The code editor, terminal pane, diff cells, status donut, token bar and
  diagram nodes in chat widgets.
- The before/after wipe handle in image-comparison and picture-viewer.
- Draggable dividers (`split-column`, `resize-divider`) and the terminal's
  floating, draggable window with its resize handles.
- Screen-reader-only form mirrors (`chat-tab` file input, `composer-editor`
  textarea).
- Colour swatches whose colour is the data (color-picker, theme-switcher).

## Findings by file

`path:line | what is hand-built | library replacement`

### Popups and drawers

- `src/components/modal-layer.tsx:39` | modal with its own portal, `role="dialog"`, backdrop, focus and inert handling | `Dialog` / `Overlay`
- `src/workbench/visual-artifact-view.tsx:131-142` | full-screen modal with its own portal and Escape | `Overlay`
- `src/components/project-settings-screen.tsx:345` | `window.confirm` for deleting a project | `AlertDialog`
- `src/components/settings/shared-library.tsx:257` | `Dialog` given `role="alertdialog"` by hand | `AlertDialog`
- `src/workbench/file-actions.tsx:311` | `Dialog` given `role="alertdialog"` because `AlertDialog` was broken | `AlertDialog`
- `src/workbench/terminal-history.tsx:235` | in-pane popup (`role="dialog"`, `absolute inset-0`) | `Popover`
- `src/workbench/file-viewer.tsx:434` and `src/workbench/diff-table.tsx:441` | `position: fixed` "Copy text" box with its own open state | `Popover` at a virtual anchor
- `src/workbench/menu-anchor.tsx:66` | portalled zero-size trigger to open a menu at the pointer | context menu
- `src/workbench/chat-right-rail.tsx:303`, `src/workbench/chat-tab.tsx:2327-2460`, `src/workbench/files-tab.tsx:471-622` | slide-in drawers with a scrim made from a repainted `Button` | `Sheet`
- `src/components/update-banner.tsx:91` | fixed-position slide-in notice | `Panel` placed by a library notice, or toast

### Buttons reshaped into rows

`Button` with `h-auto w-full justify-start` (or similar) standing in for a list row → `Row`.

- `src/components/agent-files-browser.tsx:235` (file list)
- `src/components/bead-detail.tsx:445` (related tasks)
- `src/components/folder-browser.tsx:344` (folder options)
- `src/components/tag-picker.tsx:140, 212`
- `src/components/subtask-list.tsx:77`
- `src/workbench/chat-tab.tsx:682` (todo header)
- `src/workbench/commit-log.tsx:232`
- `src/workbench/git-diff-view.tsx:115`
- `src/workbench/terminal-history.tsx:267`
- `src/workbench/transcript-rows.tsx:354, 645, 771, 854`
- `src/workbench/sent-away.tsx:490`
- `src/workbench/filter-tree.tsx:136`
- `src/workbench/card-live.tsx:22` (`<a>` styled as a row)

### Links, clickable spans and images

- `src/components/settings/shared-library.tsx:298`, `src/components/settings/provider-settings-panel.tsx:387`, `src/workbench/transcript-rows.tsx:176` | raw `<a className="text-primary underline">` | `Button mode="link" asChild`
- `src/workbench/accounts-settings.tsx:479`, `src/components/update-banner.tsx:145`, `src/workbench/commit-details.tsx:181, 205` | `Button` turned into a link by class | `Button mode="link"`
- `src/components/copyable-text.tsx:46` | clickable `<span>` with no keyboard access | `Button`
- `src/workbench/attachment-grid.tsx:111` | clickable `<img>` | wrapped in `Button`
- `src/workbench/path-chip.tsx:97`, `src/workbench/git-view.tsx:305` | clickable spans through a delegated listener | `Button mode="link"`

### Dividers

`h-px` / `border-t` / `<hr>` divs drawn as dividers → `Separator`.

- `src/components/bead-detail.tsx:394, 416, 428, 440, 500`
- `src/components/comment-list.tsx:100`
- `src/components/tag-picker.tsx:164`
- `src/search/search.tsx:359` (vertical)
- `src/workbench/card-chats.tsx:53`
- `src/workbench/chat-tab.tsx:707`
- `src/workbench/chat-widget-view.tsx:217`
- `src/workbench/dependencies-settings.tsx:84`
- `src/workbench/memory-badge.tsx:120, 131`
- `src/workbench/start-from-card.tsx:65`
- `src/workbench/visual-artifact-view.tsx:100`

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
- `<details>` disclosures → Collapsible: `bead-detail.tsx:411, 423`, `shared-library.tsx:231-302`, `transcript-rows.tsx:1424`, `mcp-servers-panel.tsx:75`
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
