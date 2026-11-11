# Atelier workflow materials

Atelier's installed workflow is native Rust inside the `atelier` binary. This
directory contains only the read-only skills and worker briefs embedded into a
release; it contains no runtime scripts and requires no interpreter.

Join or update a project with:

```sh
atelier init /path/to/project
```

The command writes `.atelier/project.toml` or the machine-local equivalent and
takes out any provider hook entries an older Atelier wrote there for workflow
steps that no longer exist. It touches only Atelier-managed entries and
preserves neighboring provider settings.

Work is tracked as tasks (docs/tasks.md), driven from a chat with
`atelier task <command>`.

Everything a project wants its agents to know — how to bring up an isolated
stack, which ports are off limits, what counts as proof, how to deploy — goes in
`instructions.md` beside the manifest, edited in Project Settings →
Instructions. Its text is added to every session's prompt. A manifest written
before this file existed has its setup, start, build, deploy, evidence and
visual-proof settings moved into one the first time it is read.
