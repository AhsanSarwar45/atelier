import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
CRITICAL_GATES = {
    "workflow-gate.py",
    "board-actor.py",
    "board-merge-gate.py",
    "board-status-gate.py",
    "wait-gate.py",
}


def commands(settings):
    return {
        Path(hook["command"].replace('"', '').split()[-1]).name
        for entry in settings["hooks"]["PreToolUse"]
        for hook in entry.get("hooks", [])
        if "command" in hook
    }


class ProviderLifecycle(unittest.TestCase):
    def test_claude_and_codex_share_every_critical_preflight_gate(self):
        claude = json.loads((ROOT / ".claude/settings.json").read_text())
        codex = json.loads((ROOT / ".codex/hooks.json").read_text())
        for provider, settings in (("Claude", claude), ("Codex", codex)):
            with self.subTest(provider=provider):
                self.assertTrue(CRITICAL_GATES.issubset(commands(settings)))

    def test_canonical_workflow_names_every_lifecycle_transition(self):
        text = (ROOT / "ATELIER_WORKFLOW.md").read_text()
        for transition in ("job new", "worktree add", "--claim", "git commit",
                           "board/land", "machinery/checks", "Review starts",
                           "Stop only when"):
            with self.subTest(transition=transition):
                self.assertIn(transition, text)


if __name__ == "__main__":
    unittest.main()
