<div align="center">

# ATELIER

**A workbench for coding agents.**

[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

<br>

[Why](#why) · [Features](#features) · [Themes](#themes) · [Installation](#installation) · [Development](#development) · [FAQ](#faq)

**[Русская версия](README-ru.md)**

</div>

---

## Why

Claude Code and Codex are good at the work and poor at everything around it.
Run three of them in three terminals and you cannot see which one is waiting on
you, what any of them changed, or whether the one that says it is done was ever
checked.

Atelier runs them for you. Each chat is a tab you can close and come back to.
Work in it is tracked as a task: the agent says up front what it will do, and
says at the end what it did and how it knows. Nothing reaches your shipping
branch until you merge it.

It drives the agent you already installed and signed in. There is no API key to
add, and no model charge from us.

## Features

- **Chat with agents** — Claude Code, Codex CLI, and local models through Goose.
  Chats survive a closed browser, and ones you began in a terminal are picked up
  too
- **Tasks** — each project has a Tasks tab, and each chat holds its own
  tasks. A task has a type (bug, feature, UI change, optimization, and more), a
  plan given when it is created, and a result given when it is done. The result
  must cover the plan, and code tasks must name commits that exist. Type `@task`
  in the composer to ask for one, or `@task:N` to point at one. Agents use
  `atelier task` to create, start, block and finish them. See
  [docs/tasks.md](docs/tasks.md)
- **Visual proof** — screenshots of a real browser or a real window, before and
  after, taken by the agent and shown in the transcript
- **Files and terminal** — an editor and a real shell that outlive the page
- **Accounts** — more than one provider login signed in at once, each with its
  own plan usage and spend
- **MCP and plugins** — browse a catalogue, add servers, manage Claude
  extensions, and edit skills, hooks and agent files from Settings
- **11 themes**, and an app that opens on your phone

## Themes

Default Dark, Glassmorphism, Neo-Brutalist, Linear Minimal, Notion Warm,
GitHub Clean, Soft Light, and the four Catppuccin flavours (Latte, Frappe,
Macchiato, Mocha) are available from the theme switcher.

## Tech Stack

- **Frontend**: Next.js 14, React 18, TypeScript, Tailwind CSS, Radix UI, dnd-kit
- **Backend**: Rust (Axum), SQLite
- **Agents**: Claude Code, Codex CLI and Goose, driven over the Agent Client Protocol
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

- [Git](https://git-scm.com/) — Atelier reads and writes your project
  through it
- Claude Code or Codex CLI, installed and signed in, for chat

Chat, provider protocols, tasks, hooks and project setup all run in
the Atelier binary. Python, Node.js and npm are not runtime dependencies and
are not carried in release archives.

None of them has to be on your PATH. Atelier looks there first, then in the
ordinary places an installer writes to: `~/.cargo/bin`, `~/.local/bin`,
Homebrew's folder, `/usr/local/bin`, `/usr/bin` and `/bin`,
and on Windows the usual per-user program folders, plus `System32`.
That is what lets the copy your computer starts at login find them, since a
service inherits no shell and so no PATH at all. What it cannot find is a
provider installed through a version manager is picked up when your own PATH
names it; its exact path can also be saved in Settings → Dependencies.

`atelier tools` prints each of them, whether it is here, and where — so a
missing one is something you can see rather than something you infer from a
screen that does not work.

### Homebrew (macOS / Linux)

One command:

```bash
brew install AhsanSarwar45/atelier/atelier
```

Update later with `brew upgrade atelier`.

On Windows, take the archive from the table below, unpack it, and put the program somewhere on your PATH.

### Download

Download the archive for your platform from [GitHub Releases](https://github.com/AhsanSarwar45/atelier/releases/latest):

| Platform | File |
|----------|------|
| Windows x64 | `atelier-win-x64.tar.gz` |
| macOS Apple Silicon | `atelier-darwin-arm64.tar.gz` |
| macOS Intel | `atelier-darwin-x64.tar.gz` |
| Linux x64 | `atelier-linux-x64.tar.gz` |

Each archive carries one Atelier program. Each release also ships a
`SHA256SUMS.txt` to verify the download.

### Run

One command brings the whole thing up — the screens, the tasks and the chat —
and opens it in your browser:

```bash
# macOS/Linux — unpack, then run
tar -xzf atelier-darwin-arm64.tar.gz
./atelier run

# Windows
tar -xzf atelier-win-x64.tar.gz
atelier.exe run
```

There is nothing else to start: the screens, chat drivers, hooks and tasks
are embedded in the program. The installed app needs no Rust, Python,
Node.js or npm.

| Command | What it does |
|---------|--------------|
| `atelier run` | Start the chat service and open Atelier in your browser |
| `atelier run --no-browser` | The same, without opening a browser |
| `atelier` | The same as `run --no-browser` |
| `atelier init [folder]` | Set a folder (the one you are in by default) up as a project |
| `atelier task <command>` | Create, start and finish tasks from a chat |
| `atelier service install` | Have this computer start it at login, and keep it up |
| `atelier service uninstall` | Stop having it started, and leave nothing behind |
| `atelier service status` | Say whether this computer starts it |
| `atelier remote install` | Set this computer up to be reached from away |
| `atelier remote` | Say how far along that setup is |
| `atelier --data-dir` | Print where this computer keeps Atelier's data |
| `atelier --version` | Print which build this is |
| `atelier --help` | List the above |

It serves on http://localhost:3008 unless `ATELIER_PORT` says otherwise, and
`ATELIER_DATA_DIR` moves where it keeps its data. Who may reach it is a
setting, under Settings › Remote access.

### Open it on your phone

It answers everyone on your network by default, so Atelier opens on a phone,
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

To keep it to this computer alone, set **Answer on** to `127.0.0.1` under
Settings › Remote access; it then says so instead of offering an address that
will not answer.

### Open it from anywhere else

Not from your own network — from a café, from a train. That is a different
question, because Atelier has no password and a port answering the internet is
a machine given away. [Reaching Atelier from outside your
network](docs/remote-access.md) says what to do instead, and what never to do.
The short of it: run `atelier remote install` once, then turn **Reach it from
anywhere** on under Settings › Remote access. That puts a private network in
front of Atelier, and the same section closes the port behind it and names
the address to open.

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
nothing opens a window over your login. Whatever `ATELIER_PORT` and
`ATELIER_DATA_DIR` are set to when you install is written into the
registration, because a service inherits no shell. The settings are read from
where they are stored, so a service picks up a change made on the screen the
next time it starts.

`atelier service uninstall` stops it and removes the registration.

### Set a project up

```bash
cd my-project
atelier init
```

It asks two things: the project's name, and whether to keep its shared
settings in `.atelier/project.toml` inside the repository. Answer no and they
stay in Atelier's own data folder, so nothing is written into the project.
`atelier init --name=NAME` skips the first question; `--repository-config` or
`--personal-config` skips the second. Run it on a project set up by an older
version and it also takes out the hooks that version wired in.

Every project gets chat and a Tasks tab. A chat started by Atelier receives the
`atelier` skill, for widgets and visual proof, and the `tasks` skill. Agents
work in the folder or worktree you opened the chat in. They do not make
worktrees or branches of their own, and they do not merge. Merging is yours.

## Development

Development prerequisites: Node.js 22.6+ for building the web assets, Git,
and the [Rust toolchain](https://rustup.rs/).

```bash
git clone https://github.com/AhsanSarwar45/atelier.git
cd beads-web
npm install
```

There are two workflows: **Dev Mode** (frontend hot-reload) and **Build from Source** (release binary).

### Live preview (against the instance you already run)

If an Atelier is already running with your real projects — the installed
service on :3008 — one command puts this checkout's screens on top of its data:

```bash
npm run dev:live       # http://127.0.0.1:3007, reading the Atelier on :3008
```

Nothing is built, installed or restarted: a change in this checkout shows on
the next refresh. `ATELIER_URL` points it at an Atelier elsewhere, `PORT`
at a second preview (a worktree's own, say). It refuses to start if no Atelier
answers there, because a preview with no data behind it looks like a broken app.

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
   npm run server:dev       # Terminal 2 — native backend/API
   ```

5. Open **http://localhost:3007**. Frontend edits hot-reload; API requests go to the backend on :3008.

> The `.env.local` / `NEXT_PUBLIC_BACKEND_URL` step is **dev-only**. Remove it (or leave it unset) for a release build, where frontend and backend share one origin.

### Build from Source (release binary)

Produces the same self-contained binary that CI publishes to [Releases](https://github.com/AhsanSarwar45/atelier/releases/latest). The frontend and all runtime services are embedded.

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

**Q: Do I need an API key?**
A: No. Atelier starts the `claude` or `codex` you already installed and signed
in, so the work goes through your own plan. Atelier adds no charge of its own.

**Q: How do I add a project?**
A: Run `atelier init` in the folder, or click "Add Project" on the dashboard and
browse to it.

## Origin

Atelier began as a fork of
[Beads-Kanban-UI](https://github.com/AvivK5498/Beads-Kanban-UI) by Aviv Kaplan.
Full history, with rationale: [docs/changelog.md](docs/changelog.md).

## Credits

- [Beads-Kanban-UI](https://github.com/AvivK5498/Beads-Kanban-UI) by Aviv Kaplan — original project
- [Claude Protocol](https://github.com/weselow/claude-protocol) — orchestration framework (works great together)

## License

MIT
