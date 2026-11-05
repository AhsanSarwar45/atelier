# Screen-check

Screen-check (`--help` for syntax) navigates only the URL you give. It never
starts, stops, installs or reconfigures the app; the app must already be
running at that URL. If you are unsure which screen-check route fits, run
`atelier tool screen-check plan [--target URL|FILE] [--window-id ID] [--recipe FILE]`
and follow the command it returns; do not widen the capture.

| Need | Use |
|---|---|
| Page already in the right state | `--type web --target URL` |
| Login, cookies, headers, clicks, typing, navigation, uploads or waits | `--recipe FILE` |
| Native app, simulator or remote desktop | one window: `--type window --window-id ID` |
| A screenshot from the `chrome` server or another authorized tool | `--type image --target FILE` |
| Before and after already captured | `compare --before FILE --after FILE` |

Commands:

- Capture only: `atelier tool screen-check capture --type web --target URL [--viewport 1280x800] [--theme light|dark|system]`,
  or `capture --type image --target FILE`.
- Capture and judge one frame: `atelier tool screen-check check --type web|image --target URL|FILE --expect TEXT [--provider claude|codex]`.
- Judge a change: `atelier tool screen-check compare --before FILE --after FILE --expect TEXT [--provider claude|codex]`.
  For live pages, prefer `--before-recipe BEFORE.json --after-recipe AFTER.json`
  with the same URL, device or viewport, locale, timezone, theme and capture
  settings. Different settings, final URLs or image sizes are refused.
- Windows: list them with `atelier tool screen-check windows`. Bring the one
  window fully to the front, uncovered, then run
  `capture|check --type window --window-id ID`. Hidden, minimized, background or
  unstable windows are refused. Never guess a window, capture a whole display,
  dismiss privacy prompts or change capture permissions.
- `--type auto` only for an unambiguous HTTP(S) URL or an uploaded image.

Pass each result's `captures[].asset` to `present image --asset` or
`present compare --before-asset ... --after-asset ...`.

Give `--expect` one observable expectation. `PASS` means it is visibly met,
`FAIL` means it is visibly contradicted, and `INDETERMINATE` means the pixels
cannot settle it. A capture or permission error is a tool failure, not a failed
check. Accept the verdict; do not reopen the images to judge them again.

## Browser recipes

Top-level fields: `url`, `timeout_ms`, `device` or `viewport`
(`{width, height}`), `locale`, `timezone`, `theme`, `auth`, `actions`,
`settle`, `capture`. Anything else is rejected. Example:

```json
{
  "url": "http://127.0.0.1:4173/login",
  "device": "mobile",
  "auth": { "storage_state": "state.json" },
  "actions": [
    { "action": "fill", "selector": "#email", "value": "person@example.test" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "wait_for_text", "text": "Dashboard" }
  ],
  "settle": { "selector": "[data-testid=ready]", "text": "Complete" },
  "capture": { "mode": "element", "selector": "main" }
}
```

- Put the recipe, storage state and upload files in one private temporary
  directory; paths outside it are refused. For compare, keep each recipe's files
  beside that recipe.
- `auth` takes `storage_state`, `headers` or `http_credentials`. Keep secrets in
  these files, never in a shell argument or your reply. Results never repeat
  typed values, credentials, headers, cookies or storage.
- Actions: `goto`, `click`, `fill`, `type`, `press`, `select`, `check`,
  `uncheck`, `hover`, `upload`, `wait`, `wait_for`, `wait_for_text`. Only these
  declarative actions run, never scripts. Use selectors from accessible names or
  stable test IDs, not generated classes or coordinates.
- Every web capture waits for load, network quiet, decoded fonts and images,
  stopped motion and caret, and stable layout, then needs two identical frames.
  If any phase fails, the tool fails; it never returns an unstable frame.
  `timeout_ms` (default 30000) bounds the whole run. `settle.selector` and
  `settle.text` wait for app readiness. Change `settle.network_idle_ms`,
  `settle.layout_stable_ms` or `settle.matching_frames` only when the defaults
  cannot work. Set `settle.disable_animations` to `false` only when the
  animation is the evidence.
- `capture.mode`: `viewport` (default), `full_page`, `element` with one stable
  `selector`, or `clip` with `capture.clip` set to `{x, y, width, height}`:
  `x` and `y` at least 0, `width` and `height` at least 1.
- `device` is `desktop`, `tablet` or `mobile` and fixes viewport, scale and
  touch. Do not combine it with `viewport`. `locale` and `timezone` default to
  `en-US` and `UTC`; set them when the state depends on them.

## Reading results

- Browser captures report the final URL, redirects, status, console and
  network failure counts, visible DOM text and an accessibility outline. `check` and `compare` report
  `visible_text.source=vision`; never present vision text as DOM text or merge
  the two.
- Image and window captures have no text until a check runs
  (`vision-required`).
- A PNG compare reports changed pixels, a difference ratio and a diff asset. A
  non-PNG upload or a size mismatch is still judged but is marked objectively
  unaligned.
