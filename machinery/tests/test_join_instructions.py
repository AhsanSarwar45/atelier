import importlib.machinery
import importlib.util
import tempfile
import unittest
import subprocess
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

    def test_a_linked_worktree_inherits_the_main_projects_registration(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            main = root / "project"
            tree = root / "worktree"
            main.mkdir()
            subprocess.run(["git", "init", "-q", "-b", "main", str(main)], check=True)
            subprocess.run(["git", "-C", str(main), "config", "user.email", "test@example.com"],
                           check=True)
            subprocess.run(["git", "-C", str(main), "config", "user.name", "Test"], check=True)
            subprocess.run(["git", "-C", str(main), "commit", "--allow-empty", "-qm", "base"],
                           check=True)
            subprocess.run(["git", "-C", str(main), "worktree", "add", "-q", "-b", "job",
                            str(tree)], check=True)
            registry = root / "projects.toml"
            registry.write_text('[projects]\nexample = "%s"\n' % main)
            join.project.REGISTRY = str(registry)
            join.opened = lambda: None
            before = {path.name: path.read_bytes() for path in tree.iterdir() if path.is_file()}

            self.assertEqual(join.registered_root(str(main)), str(main.resolve()))
            self.assertEqual(join.registered_root(str(tree)), str(main.resolve()))

            join.unregister(str(tree), lambda _: None)
            self.assertIsNone(join.registered_root(str(main)))
            after = {path.name: path.read_bytes() for path in tree.iterdir() if path.is_file()}
            self.assertEqual(after, before)

    def test_a_new_beads_declaration_needs_no_second_question(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            join.project.REGISTRY = str(root / "projects.toml")
            where = Path(join.declaring(str(root)))
            declaration = where.read_text()
            self.assertRegex(declaration, r'(?m)^prefix = "[a-z]{3}"$')
            self.assertIn("agent_merges = true", declaration)
            self.assertNotIn('prefix = ""', declaration)


if __name__ == "__main__":
    unittest.main()
