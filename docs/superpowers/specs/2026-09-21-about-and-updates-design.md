# About section and a watchable update — design (bw-p4le)

## The problem

Atelier can already update itself, but nothing about that is visible or
controllable.

`POST /api/update` downloads a release archive, proves it against the release's
own `SHA256SUMS.txt`, unpacks it, writes a restart script and exits — all in one
request that says nothing until it is over. The screen shows a spinner labelled
"Downloading…", then "Restarting server…". On a slow line that first label sits
there for minutes with no sign of life.

The only place an update appears is a notice pinned to the bottom right of the
screen. Its dismiss button is component state, so the notice returns on the next
reload, forever, until the update is taken. There is nowhere in Settings to see
what version is running, what the new one changes, or to start an update on
purpose.

## What this builds

1. An **About** section in Settings: the running version, whether an update is
   waiting, what that update changes, how the app was installed, and a link to
   the release page. It runs the update and draws a progress bar fed by real
   downloaded bytes.
2. A server that **reports what the update is doing** — phase, bytes received,
   bytes expected — over a stream a screen can watch.
3. A **Homebrew install that upgrades through Homebrew**, so brew's record of
   the installed version stays true.
4. A **skip** action on the update notice that is remembered on the server, so
   skipping on a desktop also silences a phone.
5. All of it **whole at 390, 360 and 768**, proved on a running screen.

## Where the pieces live

### Origin of a release

There is one origin. `server/src/routes/version.rs` asks
`api.github.com/repos/AhsanSarwar45/atelier/releases/latest`, takes the
`browser_download_url` of `atelier-linux-x64.tar.gz`, and takes
`SHA256SUMS.txt` off the *same* answer so the checksums always describe the
bytes being downloaded. The Homebrew formula
(`packaging/homebrew/atelier.rb.tmpl`) hardcodes a URL to that identical
tarball. Homebrew is an installer, not a second server.

### Server

**Progress state.** A new `server/src/routes/update_run.rs` holds the state of
at most one update at a time:

```rust
pub enum Phase { Idle, Downloading, Verifying, Unpacking, Restarting, Done, Failed }

pub struct UpdateRun {
    pub phase: Phase,
    pub received: u64,
    pub total: Option<u64>,
    pub note: Option<String>,   // the newest line of detail, e.g. a brew line
    pub failed: Option<String>, // the server's own refusal wording
    pub version: Option<String>,
}

pub type UpdateWatch = Arc<UpdateWatcher>;  // RwLock<UpdateRun> + broadcast::Sender<UpdateRun>
```

Created beside `VersionCache` in `server/src/main.rs` and injected the same way,
as an axum `Extension`.

**`POST /api/update` stops blocking.** It validates as it does today (up to
date, no asset for this platform), refuses with `409` if a run is already in
flight, then spawns the run and answers `202 {"status":"started"}`. It no longer
holds the request open for the length of a download.

**Progress rides the one wire.** It is not a stream of its own. A browser
allows six connections to one address, a stream never gives its slot back, and
this app already spent that budget once (bw-zkh4) — so `src/workbench/live-wire.ts`
is the only place allowed to open one, and `src/workbench/__tests__/one-wire.test.ts`
fails the build if a second appears. Progress is therefore a new feed on the
existing connection, tagged `update`, built exactly like the `bootstrap` feed in
`server/src/routes/live.rs`: asked for with `?update=1`, it sends the current
`UpdateRun` first — so a screen opened mid-update draws the right thing — and
then every change after. `onUpdate()` in `live-wire.ts` is how a component
subscribes.

(The first cut of this work did build a standalone `GET /api/update/progress`
route before the rule was found. It was removed. The rule is recorded here
because the route is the obvious thing to reach for and is wrong.)

**Real bytes, without rewriting the download.**
`server/src/published.rs` already streams the body chunk by chunk through
`hash_into`, hashing as it goes so nothing larger than one chunk is held in
memory. Progress is therefore a callback, not a rewrite: `download` gains a
sibling that takes `on_progress: impl Fn(u64, Option<u64>)`, passes it through
`write_if_it_matches` into `hash_into`, and calls it per chunk with the running
total. The expected total is the response's `content_length()`. The existing
`download` becomes a thin wrapper passing a no-op, so every other caller and
every existing refusal message is untouched.

**How the app was installed.** A new `install_method()` resolves
`std::env::current_exe()` and looks at its real path:

```rust
pub enum InstallMethod { Homebrew, Standalone }
```

A path with a `Cellar` ancestor holding `atelier`, with a usable `brew` on the
system, is a Homebrew install; anything else is standalone. The check is split
from the filesystem so a table of paths can be tested directly.

**Two ways to run an update, one set of phases.**

- *Standalone* — today's path, now instrumented: download (real bytes) → verify
  → unpack → restart script → exit.
- *Homebrew* — `brew update`, then
  `brew upgrade AhsanSarwar45/atelier/atelier`, with each output line published
  as `note`. Brew reports no byte total, so this path drives the phase and the
  note but leaves `total` as `None`, and the bar reads as indeterminate. The
  app then restarts through a restart-only script: it waits for the old process
  to exit and re-runs the same path, with none of the move-and-keep-a-`.old`
  steps, because brew has already put the new files in place.

Both paths end in the same restart and the same health poll that
`update-banner.tsx` does today.

**The skipped version.** Stored in the existing `settings` key/value table
(`server/src/db.rs`, `Database::setting` / `set_setting`) under
`workbench.update.skipped-version`, matching the dotted `workbench.*`
convention already used by search, terminal and new-chat. `None` deletes the
row, so "nothing skipped" has one spelling.

`VersionCheckResponse` gains `skipped_version: Option<String>` so a screen
learns the running version, the latest version and the skipped one from the
single request it already makes. `GET`/`PUT /api/settings/update` reads and
writes it, following `server/src/routes/search_settings.rs` exactly: a serde
body struct, refusals as plain English, write then re-read and return the
stored state so the screen redraws from the server.

**Checking on purpose.** `GET /api/version/check?refresh=1` skips the one-hour
cache. Without it there is no way to see a release the cache has not noticed.

**Release notes read whole.** The notes are truncated to 500 characters at
`version.rs`. About renders them, so the limit rises to 4000 — enough for a real
release body, still bounded.

### Screen

- `src/components/settings/about-settings.tsx` — the section, built from the
  existing `SettingsGroup` / `SettingRow` primitives in
  `src/components/settings/section.tsx`.
- `src/lib/update-run.ts` — a `useUpdateRun()` hook that subscribes to the
  `update` feed on the one wire and exposes `{ run, start, busy }`, beside the
  small readings the two screens share: `howFar()` for the bar, `inWords()` for
  the line under it, `whatTheServerSaid()` for a refusal. Both About and the
  notice read this one hook, so they can never disagree about what the update
  is doing. `start` is also the retry: a failure leaves the app on the version
  it was already running.
- `src/app/settings/page.tsx` — one entry in `SECTIONS` (`about`, label
  "About", hint "Version, updates") and one render branch. There is no registry
  to touch.
- `src/components/update-banner.tsx` — gains "Skip this version", shows a
  compact bar driven by the same hook, and links into About for the detail.
- `src/components/ui/progress.tsx` — the shared bar pulled `value` out of its
  props and used it only for the inline transform, so every bar in the app told
  assistive technology it was indeterminate however full it was drawn. The
  value is handed to the primitive as well, and `undefined` becomes the `null`
  that honestly means "no idea yet".

The restart-and-reload wait moves out of `update-banner.tsx` into
`waitForTheNewOne()` in `update-run.ts`, where About and the notice share it.
Remote access has a wait that looks like it but is not: a restart asked for
because the port changed brings the app back somewhere else, so it goes to the
new port rather than polling this one for health. It is left where it is —
merging them would mean polling an address nothing is listening on.

### Responsiveness

`tests/responsive.spec.ts` already walks the app at 390, 360 and 768 and fails
on four things: sideways scroll, anything drawn past the edge, clipped words, and
a control under 44 across. About is added to that walk, and to the tap-target
list. The version number is rendered so it cannot wrap mid-number — the exact
fault fixed for the notice in bw-81wt.33.

## Failure

Any failure leaves the running app on the old version, untouched. That is
already true of the download — a checksum mismatch deletes the partial file and
refuses — and the spec keeps it true for every new path.

The phase that failed is named, the server's own wording is shown, and a retry
sits beside it. The existing rule proved by `update-banner.test.tsx` — that the
server's refusal survives to the screen without an `API error:` prefix — still
holds, and now applies to About too.

If GitHub cannot be reached the check falls back to "all unknown, no update", as
it does today. About says it could not check, rather than implying the app is up
to date.

## Testing

- **Rust** — install detection over a table of paths; the byte callback fires
  with a rising total and the right expected size; a second start while one runs
  is refused; each failure path sets `Phase::Failed` with the refusal wording.
- **Vitest** — `about-settings.test.tsx` for the idle, update-waiting,
  in-progress and failed states; `update-banner.test.tsx` extended for skip and
  for the shared progress.
- **Playwright** — About appears in `tests/e2e/settings-sections.spec.ts`; a
  skipped version survives a reload, in the shape of
  `search-settings-survive-a-reload.spec.ts`; the responsive walk covers About
  idle, mid-update and failed.
- **Visual proof** — the run is driven in a browser and read off screenshots.
  A passing unit test is not a verified change in this project.

## Deliberately not in this work

- **The update routes are not behind `require_local_host`.** Every sibling
  `/api/settings/*` route is; `/api/update` is not, so any device on the network
  can start a binary replacement. Tightening it would stop updates from a phone,
  which is a product decision rather than part of this section. Raised as its
  own card.
- **macOS and Windows.** The release workflow publishes Linux x64 only, so
  `asset_for` returns `None` elsewhere and no update can be offered. About says
  so plainly and links to the release page instead of hiding the control with no
  explanation. Making those platforms updatable is already open on the board
  (bw-h1u6, bw-z3sv, bw-o76v, bw-t259).
- **Automatic installing.** The app checks and offers. It does not install on
  its own.
