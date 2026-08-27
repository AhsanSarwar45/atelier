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
    def test_installed_join_writes_portable_workflow_and_provider_references(self):
        join = load_join()
        join.WORD = "atelier"
        with tempfile.TemporaryDirectory() as held:
            project = Path(held)
            (project / "CLAUDE.md").write_text("Claude-only project rule.\n")
            (project / "AGENTS.md").write_text("Codex-only project rule.\n")
            join.instruct(str(project), lambda _: None)

            claude = (project / "CLAUDE.md").read_text()
            agents = (project / "AGENTS.md").read_text()
            workflow = (project / "ATELIER_WORKFLOW.md").read_text()
            self.assertIn("Claude-only project rule.", claude)
            self.assertNotIn("Claude-only project rule.", agents)
            self.assertIn("Codex-only project rule.", agents)
            self.assertNotIn("Codex-only project rule.", claude)
            for provider in (claude, agents):
                self.assertIn("Before doing any work, read and follow", provider)
                self.assertIn("[ATELIER_WORKFLOW.md](ATELIER_WORKFLOW.md)", provider)
            for command in (
                "atelier tool board/job new",
                "atelier tool board/land <card-id>",
                "atelier tool checks <checks-id>",
            ):
                self.assertIn(command, workflow)
            self.assertNotIn("machinery/board/job", workflow)
            self.assertNotIn(str(JOIN.parent), workflow)

    def test_reinitializing_refreshes_the_managed_workflow(self):
        join = load_join()
        join.WORD = "atelier"
        with tempfile.TemporaryDirectory() as held:
            project = Path(held)
            join.instruct(str(project), lambda _: None)
            (project / "ATELIER_WORKFLOW.md").write_text("stale\n")

            join.instruct(str(project), lambda _: None)

            self.assertNotEqual((project / "ATELIER_WORKFLOW.md").read_text(), "stale\n")
            self.assertEqual((project / "AGENTS.md").read_text().count(join.POLICY_BEGIN), 1)


if __name__ == "__main__":
    unittest.main()
