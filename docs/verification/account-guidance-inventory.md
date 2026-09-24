# Account guidance inventory

Read-only audit, 2026-09-24, for bw-yi74.13. This records source inventory,
not completion of migration or retirement. No credentials were inspected.

## Accounts and omissions

The profile registry contains Claude System, Azeem and Tapforce, and Codex
System. System directories are `/home/ahsan/.claude` and `/home/ahsan/.codex`;
registered Claude accounts are under
`/home/ahsan/.local/share/atelier/profiles/claude/`. Both account `CLAUDE.md`
files are empty. Neither registered account has commands, agents or output-style
files. Codex System has no commands, prompts, agents or output-style files.

Nine skill folders were missing from Atelier at audit time. Exact source folders:

```text
/home/ahsan/.local/share/atelier/profiles/claude/azeem/skills/synced/6f71ab79-6244-4da0-8b3a-99c74c17fcbb_98849dc6-1df0-449f-8024-68421e4b1c17/data-export-pdf
/home/ahsan/.local/share/atelier/profiles/claude/azeem/skills/synced/6f71ab79-6244-4da0-8b3a-99c74c17fcbb_98849dc6-1df0-449f-8024-68421e4b1c17/design-taste-frontend
/home/ahsan/.local/share/atelier/profiles/claude/azeem/skills/synced/6f71ab79-6244-4da0-8b3a-99c74c17fcbb_98849dc6-1df0-449f-8024-68421e4b1c17/find-animation-opportunities
/home/ahsan/.local/share/atelier/profiles/claude/azeem/skills/synced/6f71ab79-6244-4da0-8b3a-99c74c17fcbb_98849dc6-1df0-449f-8024-68421e4b1c17/gpt-taste
/home/ahsan/.local/share/atelier/profiles/claude/azeem/skills/synced/6f71ab79-6244-4da0-8b3a-99c74c17fcbb_98849dc6-1df0-449f-8024-68421e4b1c17/humanizer
/home/ahsan/.local/share/atelier/profiles/claude/azeem/skills/synced/6f71ab79-6244-4da0-8b3a-99c74c17fcbb_98849dc6-1df0-449f-8024-68421e4b1c17/improve-animations
/home/ahsan/.local/share/atelier/profiles/claude/azeem/skills/synced/6f71ab79-6244-4da0-8b3a-99c74c17fcbb_98849dc6-1df0-449f-8024-68421e4b1c17/review-animations
/home/ahsan/.local/share/atelier/profiles/claude/tapforce/skills/create-pr
/home/ahsan/.local/share/atelier/profiles/claude/tapforce/skills/web-qa
```

SHA-256 of each source `SKILL.md`:

```text
data-export-pdf 632b564597d0db4c77d58cdfe2c258cbf14ec5b8c496de49e648403887f5f3ce
design-taste-frontend aa194351b246b8b4799099d4ed7b033d29eab6e6e3d58d8d2172978be7b3ec89
find-animation-opportunities 91c1243164057fbf824088d12faea937878a757a7ac653e8288b775e8b27b882
gpt-taste 2e64c269953f2656c21bf5a0fa6b4568e82fe0c72b36e8f84758e090349966a5
humanizer 85618b50f189c0ff49858e5e2ed6aea04fef992a88b072d0980f78a7da3b18e8
improve-animations 68f17bbc4671593d2f43dba26a679243e2153ba5f26965fb7d59df52842534ff
review-animations 61cf8ac0c4c8e1f63385298c546b16c65ca9aec34abddcd04e821c16712d671d
create-pr b032f0874818b3ae119976b12eb7b54221ed1dcc2a117bec52e9d193e222152a
web-qa 271ed1a3366f0f7a02d566c101fe03e951c96e4c5c9d9a56393abffdfcdc677e
```

Both registered Claude accounts also contain synced copies of docs (1 file),
docx (61), import-memory (1), morning (3), pdf (12), pptx (56), skill-creator
(18), and xlsx (53). Compared every relative filename, SHA-256 and executable
permission bit against `/home/ahsan/.local/share/atelier/skills/<id>`: all
16 folder copies match. `.git` and `__pycache__` were excluded. These copies
can be deduplicated without losing distinct guidance or supporting assets.

## Style conflict and runtime boundary

All three Claude accounts select `outputStyle: "manager"`. No corresponding
definition exists in their output-styles folders, the main/worktree project
folders, or the scoped plugin filename search. Atelier's global library has
no output-style items and a null selection. Do not invent a manager definition.

Previously, native Claude loaded account/project/local settings while Atelier
appended shared guidance; there was no explicit precedence between competing
style texts. Atelier's resolver does explicitly prefer a project style selection
over the global selection (`server/src/workbench/library.rs`).

The fix uses per-process flag settings only: native `--settings
'{"outputStyle":"default"}'`; ACP `_meta.claudeCode.options.settings` with the
same object. Native configuration files and all other settings sources remain
untouched. The installed Claude 2.1.280 executable uses the canonical lower-case
`default` (`outputStyle||"default"`), and the installed Agent SDK's `settings`
documentation identifies this as the highest user-controlled flag-settings layer.
Administrative managed settings are not bypassed.

The pinned [Claude ACP source](https://github.com/agentclientprotocol/claude-agent-acp/blob/ea7076c0bc324603e65d8c124b7573f158749969/src/acp-agent.ts)
reads `_meta.claudeCode.options` at line 7003 and forwards its `settings` to the
SDK at lines 7079–7128. Existing `systemPrompt` and native setting sources remain.

## Retirement caveat

Claude synced skills and Codex `.system` skills are provider-managed and may
regenerate after startup, sync or upgrade. Archiving a copy is not a durable
disable mechanism. Retire only verified copies recoverably; preserve provider
credentials, permissions, hooks, plugin registrations and account metadata.
The broken System Claude `skills/report` symlink has no source content to copy.
