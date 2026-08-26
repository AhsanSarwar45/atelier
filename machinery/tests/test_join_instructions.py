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
    def test_installed_join_teaches_both_providers_portable_commands(self):
        join = load_join()
        join.WORD = "atelier"
        with tempfile.TemporaryDirectory() as held:
            project = Path(held)
            join.instruct(str(project), lambda _: None)

            claude = (project / "CLAUDE.md").read_text()
            agents = (project / "AGENTS.md").read_text()
            self.assertEqual(claude, agents)
            for command in (
                "atelier tool board/job new",
                "atelier tool board/land <card-id>",
                "atelier tool checks <checks-id>",
            ):
                self.assertIn(command, agents)
            self.assertNotIn("machinery/board/job", agents)
            self.assertNotIn(str(JOIN.parent), agents)


if __name__ == "__main__":
    unittest.main()
