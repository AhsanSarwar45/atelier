import importlib.machinery
import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
JOIN = ROOT / "machinery" / "join"


def load_join():
    loader = importlib.machinery.SourceFileLoader("atelier_join_test", str(JOIN))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class JoinInstructionsTest(unittest.TestCase):
    def test_personal_instructions_preserve_provider_rules_and_leave_project_alone(self):
        join = load_join()
        join.WORD = "atelier"
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            project = root / "company-project"
            project.mkdir()
            claude_home = root / ".claude"
            codex_home = root / ".codex"
            claude_home.mkdir()
            codex_home.mkdir()
            (claude_home / "CLAUDE.md").write_text("Claude-only personal rule.\n")
            (codex_home / "AGENTS.md").write_text("Codex-only personal rule.\n")
            join.MACHINE = str(claude_home)
            join.CODEX_MACHINE = str(codex_home)
            join.instruct_personal(lambda _: None)

            claude = (claude_home / "CLAUDE.md").read_text()
            agents = (codex_home / "AGENTS.md").read_text()
            self.assertIn("Claude-only personal rule.", claude)
            self.assertNotIn("Claude-only personal rule.", agents)
            self.assertIn("Codex-only personal rule.", agents)
            self.assertNotIn("Codex-only personal rule.", claude)
            for provider in (claude, agents):
                self.assertIn("atelier project mode", provider)
                self.assertIn("## Useful widgets in chat", provider)
                self.assertIn("ATELIER_WORKFLOW.md", provider)
            self.assertEqual(list(project.iterdir()), [])

    def test_reinstalling_refreshes_one_personal_managed_block(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            join.MACHINE = str(root / ".claude")
            join.CODEX_MACHINE = str(root / ".codex")
            join.instruct_personal(lambda _: None)
            join.instruct_personal(lambda _: None)
            agents = (root / ".codex" / "AGENTS.md").read_text()
            self.assertEqual(agents.count(join.PERSONAL_BEGIN), 1)


if __name__ == "__main__":
    unittest.main()
