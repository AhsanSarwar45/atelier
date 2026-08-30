# Release runtime gate

An Atelier release is one platform executable. The React frontend is compiled
and embedded before packaging; Node is a contributor/CI build tool, not an
installed dependency. Release archives must not contain Node, npm,
`node_modules`, a Python interpreter, executable machinery sources, or a chat
sidecar.

Before publishing, build the frontend and release binary, run the Rust and UI
contract suites, run `scripts/release-runs-anywhere.sh`, and run
`scripts/fresh-machine.sh`. The fresh-machine check starts only isolated
containers and proves native Claude and Codex start, resume, stream, approval,
stop, environment reporting, board access, and absence of Node/npm/Python.
Archive jobs pass their produced files through `ATELIER_ARCHIVES` so contents
are inspected byte-for-byte on every supported platform.

Never perform this proof against the user-owned Atelier process or port 3008.
Use disposable data/provider homes and dynamically assigned ports, stop only
the exact child process or container recorded by the check, and verify cleanup.
