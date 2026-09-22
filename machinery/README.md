# Atelier workflow materials

Atelier's installed workflow is native Rust inside the `atelier` binary. This
directory contains only the read-only skills and worker briefs embedded into a
release; it contains no runtime scripts and requires no interpreter.

Join or update a project with:

```sh
atelier init /path/to/project
```

The command writes `.atelier/project.toml` or the machine-local equivalent,
initializes Beads when enabled, configures Claude and Codex hooks as
`atelier hook <name>`, and installs the Git landing guard. Re-running it updates
only Atelier-managed entries and preserves neighboring provider settings.

Public workflow commands use the same binary:

```sh
atelier tool board/job new ...
atelier tool board/job under ...
atelier tool board/land CARD-ID
atelier tool checks CHECKS-ID
atelier tool review JOB-ID
```

The settings Atelier itself enforces — verification commands and their paths,
the completed-work branch, the Beads prefix, and the external review policy —
live in the project manifest. They are editable in the app's Project Settings
screen. Machine-wide executable paths and the single-prompt Beads installer
live in Settings → Dependencies.

Everything else a project wants its agents to know — how to bring up an
isolated stack, which ports are off limits, what counts as proof, how to
deploy — goes in `instructions.md` beside the manifest, edited in Project
Settings → Instructions. Its text is added to every session's prompt after the
settings above, so a project can say anything it likes without being able to
contradict the branch its work lands on or the policy its landings are checked
against. A manifest written before this file existed has its setup, start,
build, deploy, evidence and visual-proof settings moved into one the first time
it is read.
