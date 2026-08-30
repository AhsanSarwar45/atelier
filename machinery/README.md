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

Project-specific commands, verification paths, completed-work branch, Beads
prefix, and provider policy live in the project manifest. They are editable in
the app's Project Settings screen. Machine-wide executable paths and the
single-prompt Beads installer live in Settings → Dependencies.
