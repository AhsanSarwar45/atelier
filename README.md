<div align="center">

# ATELIER

**Visual command center for beads task tracking.**

[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

<br>

![Atelier — Kanban Board](screenshots/kanban-main.png)

<br>

[Why](#why) · [Origin](#origin) · [Features](#features) · [Themes](#themes) · [Installation](#installation) · [Development](#development) · [FAQ](#faq) · [Troubleshooting](docs/troubleshooting/README.md)

**[Русская версия](README-ru.md)**

</div>

---

## Why

Beads CLI is powerful for task tracking, but:
- No visual overview of task status across columns
- No drag-and-drop to move tasks between states
- No way to see epic progress at a glance
- No visual diff between blocked, ready, and in-progress

Atelier gives you a real-time Kanban board, multi-project dashboard, and git operations — without leaving the browser.

## Origin

Inspired by [Beads-Kanban-UI](https://github.com/AvivK5498/Beads-Kanban-UI) by Aviv Kaplan. The original author appears to have stopped development — PRs go unreviewed for months.

This fork has diverged significantly: 84 files changed, ~9500 lines added.

<details>
<summary>What changed (summary)</summary>

- 11 visual themes with persistence and flash prevention
- Inline editing for bead fields (click to edit title, description, notes)
- Click-to-copy bead IDs
- Dolt direct SQL integration (no filesystem needed)
- One-click project discovery from Dolt databases
- Windows multi-drive path support
- File browser for adding projects
- Decomposed components (bead-detail, epic-card, etc.)
- Vitest test setup
- Full component decomposition and refactoring
- Drag-and-drop status updates

</details>

Full changelog with rationale: [docs/changelog.md](docs/changelog.md)

## Features

- **Multi-project dashboard** — all projects in one place with status donut charts
- **Kanban board** — Open → In Progress → In Review → Closed with drag-to-update
- **Epic support** — group tasks with visual progress bars, view subtasks
- **GitOps** — create, view, and merge PRs from the board. CI status, merge conflicts, auto-close
- **11 themes** — Default Dark, Glassmorphism, Neo-Brutalist, Linear Minimal, Soft Light, Notion Warm, GitHub Clean, plus Catppuccin Latte, Frappe, Macchiato, and Mocha
- **Dolt integration** — connect to Dolt databases directly, no filesystem path needed
- **Real-time sync** — SSE file watcher for local projects, polling for Dolt

## Themes

Soft Light theme is shown in the main screenshot above.

<details>
<summary>See all included themes</summary>

**Default Dark**
![Default Dark](screenshots/kanban-default.png)

**Glassmorphism**
![Glassmorphism](screenshots/kanban-glassmorphism.png)

**Neo-Brutalist**
![Neo-Brutalist](screenshots/kanban-neo-brutalist.png)

**Linear Minimal**
![Linear Minimal](screenshots/kanban-linear-minimal.png)

**Notion Warm**
![Notion Warm](screenshots/kanban-notion-warm.png)

**GitHub Clean**
![GitHub Clean](screenshots/kanban-github-clean.png)

**Catppuccin**
Latte, Frappe, Macchiato, and Mocha are available from the theme switcher.

</details>

## Tech Stack

- **Frontend**: Next.js 14, React 18, TypeScript, Tailwind CSS, Radix UI, dnd-kit
- **Backend**: Rust (Axum), SQLite, Dolt SQL
- **Build**: Static export embedded into Rust binary via rust-embed

## Installation

Three commands, and there is nothing else:

```bash
brew install AhsanSarwar45/atelier/atelier   # put it on this computer
atelier service install                      # have the computer keep it running
cd my-project && atelier init                # turn a project into one it runs
```

The first two are once per computer. The third is once per project.

### Prerequisites

- [Beads CLI](https://github.com/gastownhall/beads) (`bd`) in PATH only for projects that opt into a board
- [Node.js](https://nodejs.org/) 20+ in PATH — the board and every other screen
  run without it, but the chat helper is started with `node`, and `npm` fetches
  its kit once on first run

### Homebrew (macOS / Linux)

One command:

```bash
brew install AhsanSarwar45/atelier/atelier
```

Update later with `brew upgrade atelier`.

On Windows, take the file from the table below and put it somewhere on your PATH.

### Download

Download the binary for your platform from [GitHub Releases](https://github.com/AhsanSarwar45/atelier/releases/latest):

| Platform | File |
|----------|------|
| Windows x64 | `atelier-win-x64.exe` |
| macOS Apple Silicon | `atelier-darwin-arm64` |
| macOS Intel | `atelier-darwin-x64` |
| Linux x64 | `atelier-linux-x64` |

Each release also ships a `SHA256SUMS.txt` to verify your download.

### Run

One command brings the whole thing up — the board, the screens and the chat —
and opens it in your browser:

```bash
# macOS/Linux — make executable, then run
chmod +x atelier-*
./atelier-darwin-arm64 run

# Windows
atelier-win-x64.exe run
```

There is nothing else to start: the screens are embedded in the binary and the
chat helper is started beside it. Nothing needs Rust, and the board needs no
Node.js — the chat is the one part that does, because the helper is started
with `node` and its kit fetched once with `npm`.

| Command | What it does |
|---------|--------------|
| `atelier run` | Start everything and open the board in your browser |
| `atelier run --no-browser` | The same, without opening a browser |
| `atelier` | The same as `run --no-browser` |
| `atelier init` | Set the folder you are in up as a project it runs |
| `atelier service install` | Have this computer start it at login, and keep it up |
| `atelier service uninstall` | Stop having it started, and leave nothing behind |
| `atelier service status` | Say whether this computer starts it |
| `atelier --data-dir` | Print where this computer keeps Atelier's data |
| `atelier --version` | Print which build this is |
| `atelier --help` | List the above |

It serves on http://localhost:3008 unless `ATELIER_PORT` says otherwise;
`ATELIER_HOST` sets who may reach it, and `ATELIER_DATA_DIR` moves where it
keeps its data.

### Open it on your phone

It answers everyone on your network by default, so the board opens on a phone,
a tablet or another computer. Starting it prints where to open it:

```
Atelier is running.
  On this computer   http://localhost:3008
  On your network    http://nobara.local:3008   — phone, tablet, another computer
  If that name is not found   http://192.168.1.11:3008   — this number changes when the router hands out a new one
```

Type the name on the phone. It is your computer's own name, and it keeps
working after the router hands out a different number — which is why the number
sits underneath it rather than on top. macOS, Windows and Linux running avahi
answer to that name already; nothing extra is installed and nothing is
published. A phone whose browser cannot find the name — some Android ones
cannot — types the number instead.

If nothing answers at all, your computer's firewall is holding the port shut —
open 3008, or whichever port you set.

To keep it to this computer alone, set `ATELIER_HOST=127.0.0.1`; it then says
so instead of offering an address that will not answer.

### Ask a running copy where it is

```bash
atelier where
```

Prints the same addresses and says whether anything is answering on that port.
Useful once the computer starts it for you, because then nobody sees the lines
it printed. It starts nothing.

### Start it with the computer

```bash
atelier service install
```

Registers a systemd user service on Linux, a launch agent on macOS, and a
logon task on Windows — each of them starting `atelier run --no-browser`, so
nothing opens a window over your login. Whatever `ATELIER_PORT`,
`ATELIER_HOST` and `ATELIER_DATA_DIR` are set to when you install is written
into the registration, because a service inherits no shell.

`atelier service uninstall` stops it and removes the registration.

### Set a project up

```bash
cd my-project
atelier init
```

The command asks one question, with a safe default for a new folder:

```text
Use Beads for this project? [y/N]:
```

Answering no keeps the folder chat-only: Atelier writes nothing into it and it
gets no board tab, while chat, widgets, visual proof, and the rest of Atelier's
general capabilities remain available. Answering yes registers the main Git
project once and completes its Beads setup; linked worktrees inherit the same
board instead of becoming separate projects. An existing registration defaults
to yes. Scripts can answer explicitly with `atelier init --beads` or
`atelier init --chat`.

Atelier installs its managed guidance into personal `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md`, preserving everything outside its marked block. General
chat guidance lives directly in that block. The external Beads workflow is read
only when `atelier project mode` reports `beads`, so Atelier never edits a
project's own `CLAUDE.md` or `AGENTS.md`.

It needs `bd` and `python3` on your PATH.

## Development

Prerequisites: Node.js 20+, [Rust toolchain](https://rustup.rs/), and the [Beads CLI](https://github.com/gastownhall/beads) (`bd`) in PATH.

```bash
git clone https://github.com/AhsanSarwar45/atelier.git
cd beads-web
npm install
```

There are two workflows: **Dev Mode** (frontend hot-reload) and **Build from Source** (release binary).

### Live preview (against the instance you already run)

If an Atelier is already serving your real board — the installed service on
:3008 — one command puts this checkout's screen on top of that data:

```bash
npm run dev:live       # http://127.0.0.1:3007, reading the board on :3008
```

Nothing is built, installed or restarted: a merge into this checkout shows on
the next refresh. `BEADS_BOARD_URL` points it at a board elsewhere, `PORT` at a
second preview (a worktree's own, say). It refuses to start if no board answers,
because a preview with no data behind it looks like a broken app.

### Dev Mode (frontend hot-reload)

The Next.js dev server (port 3007) serves the frontend with hot-reload; the Rust backend (port 3008) serves the API. They talk cross-origin — CORS is open on the backend.

1. **Point the frontend at the backend:**

   ```bash
   cp .env.local.example .env.local   # sets NEXT_PUBLIC_BACKEND_URL=http://localhost:3008
   ```

2. **Generate the `out/` folder once** (with `output: 'export'` still enabled). The Rust server embeds `out/` via rust-embed, so it must exist before you build the backend:

   ```bash
   npm run build
   ```

3. **Then** comment out `output: 'export'` in `next.config.js` — `next dev` is incompatible with static export.

4. **Run both servers** in separate terminals:

   ```bash
   npm run dev              # Terminal 1 — frontend on http://localhost:3007
   npm run server:dev       # Terminal 2 — backend/API + this checkout's helper
   ```

5. Open **http://localhost:3007**. Frontend edits hot-reload; API requests go to the backend on :3008.

`server:dev` sets `BEADS_WORKBENCH_ENTRY` to this checkout's
`workbench/src/server.ts`. That gives the development backend its own helper
process and makes helper edits visible after restarting the development
backend. Packaged builds continue to run the helper embedded in their binary.

> The `.env.local` / `NEXT_PUBLIC_BACKEND_URL` step is **dev-only**. Remove it (or leave it unset) for a release build, where frontend and backend share one origin.

### Build from Source (release binary)

Produces the same self-contained binary that CI publishes to [Releases](https://github.com/AhsanSarwar45/atelier/releases/latest) — the frontend is embedded, so nothing needs Rust at runtime and the board needs no Node.js. The chat helper still does.

```bash
npm install
# keep `output: 'export'` enabled in next.config.js (the default)
npm run build                 # static export → out/
cd server
cargo build --release         # binary → server/target/release/atelier (.exe on Windows)
```

With Nix, the flake builds and runs the same binary without a checkout:

```bash
nix run github:AhsanSarwar45/atelier
```

Run the binary and open **http://localhost:3008**:

```bash
./server/target/release/atelier
```

## FAQ

**Q: Do I need Dolt?**
A: No. Atelier works with local filesystem projects using `bd` CLI. Dolt adds direct SQL access and remote database support.

**Q: How do I add a project?**
A: Click "Add Project" on the dashboard. Browse to your project folder or enter a `dolt://` URL.

## Credits

- [Beads-Kanban-UI](https://github.com/AvivK5498/Beads-Kanban-UI) by Aviv Kaplan — original project
- [beads](https://github.com/gastownhall/beads) by Steve Yegge — git-native task tracking
- [Claude Protocol](https://github.com/weselow/claude-protocol) — orchestration framework (works great together)

## License

MIT
