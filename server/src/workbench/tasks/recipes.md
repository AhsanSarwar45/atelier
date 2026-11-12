# Check recipes

What checks to write for each type. A check must fail at `start` with the
output its `red` names (a `characterisation` check must pass instead), and
pass once the item is met. Put the checks on each plan item; a type with no
item list puts them in the plan's own `checks`.

## bug

One repro test that fails with the reported symptom, plus the module's
existing suite as a characterisation check, so the fix breaks nothing near
it. Write the repro from the symptom, not from the code you plan to change.

```json
[
  {"name": "repro", "kind": "test",
   "command": "cargo test -p app --test export export_keeps_last_line -- --exact",
   "given": "a chat whose last message has no trailing newline", "when": "it is exported", "then": "the export ends with that message",
   "red": "export_keeps_last_line.*FAILED", "files": ["server/tests/export.rs"]},
  {"name": "export-suite", "kind": "characterisation",
   "command": "cargo test -p app --test export",
   "given": "the export tests as they are", "when": "they run", "then": "they all pass, before and after the fix",
   "files": ["server/tests/export.rs"]}
]
```

## feature

Acceptance tests from the outside, one behaviour each: an HTTP call, a CLI
run or an end-to-end test that asserts what the user gets. For code that
transforms data, add a property-based test (round trip, ordering, no input
lost).

```json
[
  {"name": "csv-download", "kind": "test",
   "command": "npx playwright test tests/e2e/csv-export.spec.ts -g 'downloads a CSV'",
   "given": "a project with 3 chats", "when": "the owner presses Export CSV", "then": "a file with a header row and 3 data rows downloads",
   "red": "downloads a CSV.*(failed|Timed out)|getByRole.*Export CSV", "files": ["tests/e2e/csv-export.spec.ts"]},
  {"name": "csv-round-trip", "kind": "test",
   "command": "npx vitest run src/export/__tests__/csv.property.test.ts",
   "given": "any list of rows with commas, quotes and newlines", "when": "it is written to CSV and parsed back", "then": "the same rows come back",
   "red": "csv.property.test.ts.*(FAIL|Cannot find module)", "files": ["src/export/__tests__/csv.property.test.ts"]}
]
```

## refactor

A characterisation check that pins today's behaviour and passes at start,
plus a structural check that fails while the old thing is still there.

```json
[
  {"name": "same-output", "kind": "characterisation",
   "command": "npx vitest run src/settings/__tests__/load.test.ts",
   "given": "the settings files in the fixtures", "when": "they are loaded", "then": "the result is the same as before the refactor",
   "files": ["src/settings/__tests__/load.test.ts"]},
  {"name": "old-loader-gone", "kind": "structure",
   "command": "! grep -rn 'loadLegacySettings' src/",
   "given": "the source tree", "when": "it is searched for the old loader", "then": "nothing calls or defines it",
   "red": "loadLegacySettings"}
]
```

## optimization

A benchmark with warmup and at least 10 runs, its budget absolute or
relative to the start-of-task baseline, plus the correctness tests as a
characterisation check. The command does one measured run and prints the
value its `bench.value` reads.

```json
[
  {"name": "list-p50", "kind": "benchmark",
   "command": "node scripts/bench/list-chats.mjs --chats 5000",
   "given": "a project with 5000 chats", "when": "the chat list is read", "then": "p50 is at least 20% under the baseline",
   "red": "p50_ms=", "files": ["scripts/bench/list-chats.mjs"],
   "bench": {"value": "p50_ms=([0-9.]+)", "runs": 10, "warmup": 2, "budget": {"improve_pct": 20, "unit": "ms"}}},
  {"name": "list-correct", "kind": "characterisation",
   "command": "cargo test -p app chat_list",
   "given": "the chat list tests", "when": "they run", "then": "they pass before and after",
   "files": ["server/src/chats/tests.rs"]}
]
```

## docs

The page exists with its required headings, its links resolve, and its
code samples run where the language has doctests. A check that only tests
the file exists is flagged as weak.

```json
[
  {"name": "headings", "kind": "test",
   "command": "for h in '## Install' '## Configure' '## Troubleshooting'; do grep -qxF \"$h\" docs/setup.md || { echo \"missing: $h\"; exit 1; }; done",
   "given": "docs/setup.md", "when": "its headings are read", "then": "Install, Configure and Troubleshooting are there",
   "red": "missing: |No such file"},
  {"name": "links", "kind": "test",
   "command": "test -f docs/setup.md || { echo 'no docs/setup.md'; exit 1; }; npx --yes markdown-link-check -q docs/setup.md",
   "given": "docs/setup.md", "when": "every link is followed", "then": "none is dead",
   "red": "no docs/setup.md"}
]
```

## ui_change

Playwright locator assertions for the behaviour (roles, text, state), not
pixel positions. Compare a screenshot only against an approved baseline the
plan names (a mock or a capture the owner accepted); otherwise the look is
the owner's call on the before and after images at review.

```json
[
  {"name": "badge-shows", "kind": "test",
   "command": "npx playwright test tests/e2e/chat-row.spec.ts -g 'review badge'",
   "given": "a chat whose task waits for review", "when": "the chat list is shown", "then": "its row has a 'Review' badge",
   "red": "review badge.*(failed|Timed out)|toBeVisible", "files": ["tests/e2e/chat-row.spec.ts"]}
]
```

## ui_feature

As ui_change: one Playwright test per thing the screen must show or do,
asserting through roles and text. Pin the look with `toHaveScreenshot`
only against an approved baseline listed in `files`.

```json
[
  {"name": "panel-opens", "kind": "test",
   "command": "npx playwright test tests/e2e/waiting-bar.spec.ts -g 'opens the card'",
   "given": "one proposal waiting", "when": "the owner clicks the waiting bar", "then": "the proposal card opens with Create task enabled",
   "red": "opens the card.*(failed|Timed out)", "files": ["tests/e2e/waiting-bar.spec.ts"]},
  {"name": "panel-look", "kind": "test",
   "command": "npx playwright test tests/e2e/waiting-bar.spec.ts -g 'matches the mock'",
   "given": "the approved mock in tests/e2e/baselines/waiting-bar.png", "when": "the bar is captured", "then": "it differs by under 1% of pixels",
   "red": "matches the mock.*(failed|differ)", "files": ["tests/e2e/waiting-bar.spec.ts", "tests/e2e/baselines/waiting-bar.png"]}
]
```

## visual_bug

A Playwright test that reproduces what is wrong on screen, asserting a
measurable fact (an element visible, a box inside its parent, a computed
style), plus a screenshot compare when an approved good capture exists.

```json
[
  {"name": "no-overflow", "kind": "test",
   "command": "npx playwright test tests/e2e/sidebar.spec.ts -g 'long titles stay inside'",
   "given": "a chat titled with 200 characters", "when": "the sidebar is 240px wide", "then": "the title's box ends inside the sidebar",
   "red": "long titles stay inside.*failed|toBeLessThanOrEqual", "files": ["tests/e2e/sidebar.spec.ts"]}
]
```

## render_change

An image diff of the scene against an approved reference with a stated
tolerance, plus determinism: the same scene rendered twice is the same.

```json
[
  {"name": "matches-reference", "kind": "test",
   "command": "cargo run -q -p render-check -- --scene scenes/sunset.ron --camera wide --reference refs/sunset-wide.png --max-rmse 0.005",
   "given": "the approved reference refs/sunset-wide.png", "when": "the sunset scene renders from the wide camera", "then": "RMSE is at most 0.005",
   "red": "rmse=[0-9.]+ > 0.005", "files": ["refs/sunset-wide.png", "tools/render-check/src/main.rs"]},
  {"name": "deterministic", "kind": "characterisation",
   "command": "cargo run -q -p render-check -- --scene scenes/sunset.ron --camera wide --twice --max-rmse 0",
   "given": "the sunset scene", "when": "it renders twice", "then": "both images are identical"}
]
```

## render_feature

As render_change, for a new scene or effect: a diff against the approved
reference (which also fails at start because the effect is missing), and
determinism folded into the same run when the scene is new.

```json
[
  {"name": "ghosts-match", "kind": "test",
   "command": "cargo run -q -p render-check -- --scene scenes/lens-ghosts.ron --reference refs/lens-ghosts.png --max-rmse 0.01 --twice",
   "given": "the approved reference refs/lens-ghosts.png", "when": "the ghosts scene renders twice", "then": "both match the reference within 0.01 RMSE and each other exactly",
   "red": "rmse=|scene not found|unknown effect", "files": ["refs/lens-ghosts.png", "scenes/lens-ghosts.ron"]}
]
```

## investigation

A report file with the sections the questions need, checked by a script;
the owner accepts the answers. Each question gets its own section.

```json
[
  {"name": "report", "kind": "test",
   "command": "f=docs/research/slow-start.md; for h in '## Answer' '## Evidence' '## Confidence'; do grep -qxF \"$h\" \"$f\" || { echo \"missing: $h\"; exit 1; }; done",
   "given": "the report docs/research/slow-start.md", "when": "its sections are read", "then": "it has Answer, Evidence and Confidence",
   "red": "missing: |No such file"}
]
```

## plan

As investigation: the plan document with its required sections, checked
by script. The owner judges it at review.

```json
[
  {"name": "plan-doc", "kind": "test",
   "command": "f=docs/plans/sync.md; for h in '## Decisions' '## Open questions' '## Proposed tasks'; do grep -qxF \"$h\" \"$f\" || { echo \"missing: $h\"; exit 1; }; done",
   "given": "docs/plans/sync.md", "when": "its sections are read", "then": "Decisions, Open questions and Proposed tasks are there",
   "red": "missing: |No such file"}
]
```

## tests

New tests must catch a real fault: each must fail on a known-buggy commit
or a seeded mutant, and pass on the current code. A test filter that
matches nothing passes, so make the command fail when no test ran.

```json
[
  {"name": "passes-now", "kind": "test",
   "command": "out=$(cargo test -p app parse_date 2>&1); echo \"$out\"; echo \"$out\" | grep -q 'test result: ok. [1-9]'",
   "given": "the date parser as it is", "when": "its new tests run", "then": "at least one runs and all pass",
   "red": "running 0 tests|ok\\. 0 passed", "files": ["server/src/dates/tests.rs"]},
  {"name": "catches-mutant", "kind": "test",
   "command": "scripts/mutant.sh mutants/date-off-by-one.patch 'cargo test -p app parse_date'",
   "given": "the parser with an off-by-one month seeded in a scratch worktree", "when": "the new tests run there", "then": "they fail",
   "red": "mutant survived", "files": ["scripts/mutant.sh", "mutants/date-off-by-one.patch", "server/src/dates/tests.rs"]}
]
```

## chore

Command checks for the end state: a file gone, a version pinned, a lint
rule on. What must keep working (the build, the suite) is a
characterisation check.

```json
[
  {"name": "pinned", "kind": "structure",
   "command": "node -p \"require('./package.json').devDependencies.vite\" | grep -qx 5.4.2 || { echo 'vite is not pinned to 5.4.2'; exit 1; }",
   "given": "package.json", "when": "its vite version is read", "then": "it is exactly 5.4.2",
   "red": "vite is not pinned"},
  {"name": "builds", "kind": "characterisation",
   "command": "npm run build",
   "given": "the repository", "when": "it is built", "then": "the build exits 0"}
]
```

## review

Pick the closest recipe. Usually: a findings file with a section per focus
area, checked by script as for investigation, and a failing test for each
high-severity finding you can reproduce.

```json
[
  {"name": "findings", "kind": "test",
   "command": "f=docs/reviews/auth.md; for h in '## Verdict' '## Findings'; do grep -qxF \"$h\" \"$f\" || { echo \"missing: $h\"; exit 1; }; done",
   "given": "docs/reviews/auth.md", "when": "its sections are read", "then": "it has a Verdict and Findings",
   "red": "missing: |No such file"}
]
```

## qa

Each scenario is an end-to-end test that runs its steps and asserts the
expected outcome, as for feature.

```json
[
  {"name": "resume-chat", "kind": "test",
   "command": "npx playwright test tests/e2e/qa/resume.spec.ts",
   "given": "a chat stopped mid-turn", "when": "the app restarts and the chat is opened", "then": "its last message and composer draft are back",
   "red": "resume.spec.ts.*(failed|No tests found)", "files": ["tests/e2e/qa/resume.spec.ts"]}
]
```

## general

Pick the closest recipe above for each item and write its checks that way.
