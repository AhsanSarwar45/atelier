# The machinery, and how a project joins it

Every project on this machine runs the same board tooling and the same session
gates, in place, out of this one directory. Nothing is copied into a project:
what differs by project is declared once at the project's own root, in
`machinery.toml`, and everything here reads that.

Joining is one command.

```
machinery/join <path to the project>      # join it, or bring it up to date
machinery/join                            # the project you are standing in
machinery/join --check                    # say what is missing, change nothing
```

It is safe to run again. A project already joined is looked over and left
alone; only what is missing is put right.

## What it does

1. **Writes the project a declaration** it can fill in — `machinery.toml`, from
   the example beside this file, with the project's own name already in it,
   written so a name holding a quote survives being read back.
2. **Brings the board up on a database server.** A project with no board gets
   one made, already on a server. A board beads runs in its own process is
   moved onto one: its cards are counted and exported first, its data directory
   is moved to where the server looks, its record of how it runs is rewritten,
   the server is started, and the count is read again. If the number changed,
   the whole move is undone and the board is handed back exactly as it was.
3. **Wires the session gates** into the project's own `.claude/settings.json`,
   generated from the one table in `join` that says which gate answers which
   event. The file is merged into, never replaced: every setting and every gate
   the project owns survives, and a gate wired where it would never be heard is
   moved rather than doubled.
4. **Sets the session history ceiling** where it is missing or too high.
5. **Puts the project on the board screen's list**, matched by where the project
   lives, so it appears without anyone typing a path into the screen.
6. **Tells the board about the two review states** this machinery invented,
   which bd refuses until it has been told, and puts back any job the board
   turned away while it was still refusing.
7. **Leaves the landing guard** wherever this project's git looks for a
   hook — after the board is made, never before, because making the board
   is what moves that directory.
8. **Registers the project** in `projects.toml`, which is how every other
   project here can name it.

## The two answers only the owner can give

A project that has declared nothing is refused once, and the refusal names both
of them together:

- **`prefix`** — the two or three letters in front of every card id on this
  project's board. It cannot be changed later without rewriting every card.
- **`agent_merges`** — whether an agent may put work onto this project's
  shipping lines itself. False everywhere it is not said, because a checkout
  nobody has thought about is more likely to be somebody else's.

Fill both in, run the command again, and it does the rest. Nothing is created
on the first run, so a project stopped at the refusal is a project untouched.

## Why the board must be on a server

A board beads runs in its own process can only be opened by a command line. The
board screen reads a project's cards straight out of a database server when one
holds them, and otherwise falls back to spawning `bd` once per read; `bd doctor`
refuses its deep checks on one outright. So every project here runs its board on
a server, and `--check` says so about any that does not.

The copy taken before a move is kept at `.beads/before-the-server.jsonl`, so the
move can be undone by hand long afterwards.

## What it leaves that belongs to this machine

Three things sit inside the working tree and mean nothing to anybody else: the
copy of the board taken before it moved, the board server's settings (the port
is this morning's and the path is this disk's), and the landing guard, which
holds a path on this machine.

None of them belongs in `git status`, where the landing gate would sweep them
into a stash before the next merge. So joining tells git to leave them alone —
by a line in this clone's own exclude list for a file nobody tracks, and by the
index for a file the project already commits, which beads does with the server's
settings at `bd init`. Both are this clone's own business; the project's history
is not touched either way, and `git update-index --no-skip-worktree <file>`
undoes the second.

## What `--check` reports

Everything above, as a list of what is missing and nothing else: no board, a
board only a command line can open, unwired gates, a history ceiling that is too
high, a project not on the screen's list, a board never told about the review
states, a job waiting on the manager outside his column, an unguarded landing
line, a file of this machine's own that git is still watching, and the lines in
the declaration only the owner can answer. It changes nothing. A clean project
lists nothing at all.
