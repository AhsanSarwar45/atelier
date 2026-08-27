import importlib.machinery
import importlib.util
import tempfile
import unittest
import subprocess
import sqlite3
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
    def test_personal_install_adds_skills_and_hooks_without_instruction_files(self):
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
            join.install_skills(lambda _: None)
            join.install_session_hooks(lambda _: None)

            self.assertEqual((claude_home / "CLAUDE.md").read_text(),
                             "Claude-only personal rule.\n")
            self.assertEqual((codex_home / "AGENTS.md").read_text(),
                             "Codex-only personal rule.\n")
            for provider in (claude_home, codex_home):
                for skill in ("atelier", "beads"):
                    self.assertTrue((provider / "skills" / skill).is_symlink())
            claude = (claude_home / "settings.json").read_text()
            codex = (codex_home / "hooks.json").read_text()
            self.assertIn("session-context.py", claude)
            self.assertIn("session-context.py", codex)
            self.assertEqual(list(project.iterdir()), [])

    def test_reinstalling_keeps_one_session_hook(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            join.MACHINE = str(root / ".claude")
            join.CODEX_MACHINE = str(root / ".codex")
            join.install_session_hooks(lambda _: None)
            join.install_session_hooks(lambda _: None)
            hooks = (root / ".codex" / "hooks.json").read_text()
            self.assertEqual(hooks.count("session-context.py"), 1)

    def test_personal_hook_preserves_existing_provider_hooks(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            join.MACHINE = str(root / ".claude")
            join.CODEX_MACHINE = str(root / ".codex")
            Path(join.MACHINE).mkdir()
            (Path(join.MACHINE) / "settings.json").write_text(
                '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"mine"}]}]}}')

            join.install_session_hooks(lambda _: None)

            settings = (Path(join.MACHINE) / "settings.json").read_text()
            self.assertIn('"command": "mine"', settings)
            self.assertIn("session-context.py", settings)

    def test_setup_does_not_rewrite_legacy_or_user_project_instructions(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            legacy = ("<!-- BEGIN ATELIER WORKFLOW -->\nold Atelier text\n"
                      "<!-- END ATELIER WORKFLOW -->\n")
            (root / "CLAUDE.md").write_text("Keep Claude rule.\n\n" + legacy)
            (root / "AGENTS.md").write_text(legacy + "Keep Codex rule.\n")
            (root / "ATELIER_WORKFLOW.md").write_text(
                "<!-- This file is managed by `atelier init`; re-running it refreshes this file. -->\nold\n")

            before = {path.name: path.read_bytes() for path in root.iterdir()}
            join.project.REGISTRY = str(root / "external" / "projects.toml")
            join.unregister(str(root), lambda _: None)
            after = {path.name: path.read_bytes() for path in root.iterdir()}
            self.assertEqual(after, before)

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
            join.project.REGISTRY = str(registry)
            self.assertEqual(join.project_root(str(tree)), str(main.resolve()))
            registry.write_text('[projects]\nexample = "%s"\n' % main)
            screen = root / "screen.sqlite"
            db = sqlite3.connect(screen)
            db.execute("CREATE TABLE projects (path TEXT)")
            db.execute("INSERT INTO projects (path) VALUES (?)", (str(main),))
            db.commit()
            db.close()
            join.opened = lambda: sqlite3.connect(screen)
            before = {path.name: path.read_bytes() for path in tree.iterdir() if path.is_file()}

            self.assertEqual(join.registered_root(str(main)), str(main.resolve()))
            self.assertEqual(join.registered_root(str(tree)), str(main.resolve()))

            join.unregister(str(tree), lambda _: None)
            self.assertIsNone(join.registered_root(str(main)))
            after = {path.name: path.read_bytes() for path in tree.iterdir() if path.is_file()}
            self.assertEqual(after, before)
            db = sqlite3.connect(screen)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 0)
            db.close()

    def test_chat_only_removes_a_board_row_stored_through_a_symlink(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            project = root / "real-project"
            project.mkdir()
            alias = root / "project-link"
            alias.symlink_to(project, target_is_directory=True)
            registry = root / "projects.toml"
            registry.write_text('[projects]\nexample = "%s"\n' % alias)
            join.project.REGISTRY = str(registry)
            screen = root / "screen.sqlite"
            db = sqlite3.connect(screen)
            db.execute("CREATE TABLE projects (path TEXT)")
            db.execute("INSERT INTO projects (path) VALUES (?)", (str(alias),))
            db.commit()
            db.close()
            join.opened = lambda: sqlite3.connect(screen)

            join.unregister(str(alias), lambda _: None)

            db = sqlite3.connect(screen)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 0)
            db.close()

    def test_a_new_beads_declaration_needs_no_second_question(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            join.project.REGISTRY = str(root / "projects.toml")
            project = root / "company-project"
            project.mkdir()
            where = Path(join.declaring(str(project)))
            declaration = where.read_text()
            self.assertRegex(declaration, r'(?m)^prefix = "[a-z]{3}"$')
            self.assertIn("agent_merges = false", declaration)
            self.assertNotIn('prefix = ""', declaration)
            self.assertFalse((project / "machinery.toml").exists())
            self.assertTrue(str(where).startswith(str(root / "projects")))


if __name__ == "__main__":
    unittest.main()
