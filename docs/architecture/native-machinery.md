# Native board machinery

Installed Atelier projects run their board workflow through the `atelier`
binary. The release embeds provider-readable Markdown skills and worker
instructions, but no executable Python files. `atelier init` creates the
project manifest, initializes Beads when needed, wires Claude and Codex hooks
to `atelier hook NAME`, and installs the Git landing guard. Public workflow
commands are dispatched by `atelier tool NAME`.

Hard gates protect only facts a program can settle and whose violation can
lose work or make completion untruthful: an active work item owns mutations,
landing-line merges are serialized and fast-forward-only, manager review is
manager-owned, commits must have reached the landing line, and children and
review gates must be resolved before closure. Ticket wording, prose length,
step-note shape, optional ceremony, and foreground-wait style are guidance or
warnings rather than refusals.

The native commands use the configured project manifest and the resolved `git`
and `bd` executables. Checks record the Git tree and declared suite results.
Landing closes only open work items whose exact IDs occur in commit subjects
that were landed. Cancellation marks and closes descendants before their
container. External review invokes an installed Claude or Codex CLI read-only
and records its result on the job.

The test filter `cargo test --manifest-path server/Cargo.toml native_machinery`
covers hook output shape, non-destructive hook wiring, narrowed prose policy,
exact commit/card matching, and workflow spine rules. Runtime/source archive
audits independently reject interpreter dispatch and embedded `.py` files.
