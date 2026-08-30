import importlib.machinery
import importlib.util
import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
JOIN = ROOT / "machinery" / "join"


def load_join():
    loader = importlib.machinery.SourceFileLoader("atelier_join_test", str(JOIN))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class JoinInstructionsTest(unittest.TestCase):
    def test_project_wiring_removes_the_retired_publish_gate(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            settings = root / ".claude" / "settings.json"
            settings.parent.mkdir()
            settings.write_text(json.dumps({
                "hooks": {
                    "PreToolUse": [{
                        "hooks": [{
                            "type": "command",
                            "command": "python3 /old/reporting/tools/publish-gate.py",
                        }],
                    }],
                },
            }))

            join.wire(str(root), lambda _: None)

            self.assertNotIn("publish-gate.py", settings.read_text())

    def test_beads_review_handoff_names_the_personal_reviewer_contract(self):
        skill = (ROOT / "machinery/skills/beads/SKILL.md").read_text()
        reviewer = (ROOT / ".claude/agents/reviewer.md").read_text()

        self.assertIn("run only `machinery/board/review <job-id>`", skill)
        self.assertIn("personal `external-review` runner", skill)
        self.assertIn("personal Claude agent named `reviewer`", skill)
        self.assertIn("model: sonnet", reviewer)
        self.assertRegex(reviewer, r"(?m)^skills:\n  - external-review$")

    def test_migration_never_replaces_a_registry_published_concurrently(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            legacy = root / "legacy.toml"
            personal = root / "personal" / "projects.toml"
            legacy.write_text('[projects]\nold = "/old"\n')
            personal.parent.mkdir()
            personal.write_text('[projects]\nnew = "/new"\n')

            self.assertFalse(join.copy_if_absent(str(legacy), str(personal)))
            self.assertEqual('[projects]\nnew = "/new"\n', personal.read_text())

    def test_personal_install_removes_only_atelier_owned_provider_artifacts(self):
        join = load_join()
        join.WORD = "atelier"
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            claude_home = root / ".claude"
            codex_home = root / ".codex"
            personal_bin = root / "bin"
            (claude_home / "agents").mkdir(parents=True)
            (claude_home / "skills").mkdir()
            (codex_home / "skills").mkdir(parents=True)
            personal_bin.mkdir()
            (claude_home / "CLAUDE.md").write_text("Claude-only personal rule.\n")
            (codex_home / "AGENTS.md").write_text("Codex-only personal rule.\n")
            join.MACHINE = str(claude_home)
            join.CODEX_MACHINE = str(codex_home)
            join.PERSONAL_BIN = str(personal_bin)
            (claude_home / "agents" / "reviewer.md").symlink_to(
                ROOT / ".claude/agents/reviewer.md")
            (claude_home / "agents" / "mine.md").symlink_to(root / "mine.md")
            for provider in (claude_home, codex_home):
                (provider / "skills" / "atelier").symlink_to(
                    ROOT / "machinery/skills/atelier", target_is_directory=True)
                (provider / "skills" / "external-review").mkdir()
            (personal_bin / "external-review").symlink_to(
                ROOT / "machinery/external-review/scripts/external_review.py")

            join.install(lambda _: None)

            self.assertEqual((claude_home / "CLAUDE.md").read_text(),
                             "Claude-only personal rule.\n")
            self.assertEqual((codex_home / "AGENTS.md").read_text(),
                             "Codex-only personal rule.\n")
            for provider in (claude_home, codex_home):
                self.assertFalse((provider / "skills" / "atelier").exists())
                self.assertTrue((provider / "skills" / "external-review").is_dir())
            self.assertFalse((claude_home / "agents" / "reviewer.md").exists())
            self.assertTrue((claude_home / "agents" / "mine.md").is_symlink())
            self.assertFalse((personal_bin / "external-review").exists())

    def test_personal_cleanup_removes_only_its_session_hook(self):
        join = load_join()
        join.WORD = "atelier"
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            join.MACHINE = str(root / ".claude")
            join.CODEX_MACHINE = str(root / ".codex")
            Path(join.MACHINE).mkdir()
            (Path(join.MACHINE) / "settings.json").write_text(json.dumps({"hooks": {
                "PreToolUse": [{"hooks": [{"type": "command", "command": "mine"}]}],
                "SessionStart": [{"hooks": [
                    {"type": "command", "command": "atelier hook session-context.py"},
                    {"type": "command", "command": "my-session-context.py"},
                ]}],
            }}))

            join.remove_session_hooks(lambda _: None)

            settings = (Path(join.MACHINE) / "settings.json").read_text()
            self.assertIn('"command": "mine"', settings)
            self.assertIn("my-session-context.py", settings)
            self.assertNotIn('atelier hook session-context.py', settings)

    def test_malformed_personal_settings_are_left_byte_for_byte(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            where = Path(held) / ".claude/settings.json"
            where.parent.mkdir()
            where.write_text("not json\n")
            join.MACHINE = str(where.parent)
            join.CODEX_MACHINE = str(Path(held) / ".codex")
            messages = []
            join.remove_session_hooks(messages.append)
            self.assertEqual(where.read_text(), "not json\n")
            self.assertIn("cannot be removed safely", messages[0])

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
            screen = root / "settings.db"
            db = sqlite3.connect(screen)
            db.execute("CREATE TABLE projects (id TEXT, name TEXT, path TEXT, "
                       "local_path TEXT, last_opened TEXT, created_at TEXT, "
                       "is_test INTEGER DEFAULT 0, archived_at TEXT, "
                       "uses_beads INTEGER NOT NULL DEFAULT 1)")
            db.commit()
            db.close()
            join.opened = lambda: sqlite3.connect(screen)
            join.unregister(str(root), lambda _: None)
            after = {path.name: path.read_bytes() for path in root.iterdir()
                     if path != screen}
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
            db.execute("CREATE TABLE projects (id TEXT, name TEXT, path TEXT, "
                       "local_path TEXT, last_opened TEXT, created_at TEXT, "
                       "is_test INTEGER DEFAULT 0, archived_at TEXT)")
            db.execute("INSERT INTO projects (name, path, is_test) VALUES (?,?,0)",
                       ("Company Project", str(main)))
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
            self.assertEqual(db.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 1)
            self.assertEqual(("Company Project", str(main)),
                             db.execute("SELECT name, path FROM projects").fetchone())
            db.close()

    def test_chat_only_keeps_a_project_row_stored_through_a_symlink(self):
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
            db.execute("CREATE TABLE projects (id TEXT, name TEXT, path TEXT, "
                       "local_path TEXT, last_opened TEXT, created_at TEXT, "
                       "is_test INTEGER DEFAULT 0, archived_at TEXT)")
            db.execute("INSERT INTO projects (name, path, is_test) VALUES (?,?,0)",
                       ("Linked Project", str(alias)))
            db.commit()
            db.close()
            join.opened = lambda: sqlite3.connect(screen)

            join.unregister(str(alias), lambda _: None)

            db = sqlite3.connect(screen)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 1)
            self.assertEqual(("Linked Project", str(alias)),
                             db.execute("SELECT name, path FROM projects").fetchone())
            db.close()

    def test_new_chat_only_project_is_added_to_atelier_without_beads_registration(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            project = root / "keystone"
            project.mkdir()
            join.project.REGISTRY = str(root / "personal/projects.toml")
            join.project.LEGACY_REGISTRY = str(root / "rules/projects.toml")
            screen = root / "settings.db"
            db = sqlite3.connect(screen)
            db.execute("CREATE TABLE projects (id TEXT, name TEXT, path TEXT, "
                       "local_path TEXT, last_opened TEXT, created_at TEXT, "
                       "is_test INTEGER DEFAULT 0, archived_at TEXT, "
                       "uses_beads INTEGER NOT NULL DEFAULT 1)")
            db.commit()
            db.close()
            join.opened = lambda: sqlite3.connect(screen)

            join.unregister(str(project), lambda _: None)

            db = sqlite3.connect(screen)
            row = db.execute("SELECT name, path, uses_beads FROM projects").fetchone()
            db.close()
            self.assertEqual(("Keystone", str(project), 0), row)
            self.assertFalse(Path(join.project.REGISTRY).exists())
            self.assertFalse(Path(join.project.declaration_path(str(project))).exists())

    def test_legacy_registry_and_declaration_move_to_personal_data_verbatim(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            project = root / "company-project"
            project.mkdir()
            legacy_registry = root / "rules/projects.toml"
            legacy_registry.parent.mkdir()
            legacy_registry.write_text('[projects]\ncompany = "%s"\n' % project)
            personal_registry = root / "personal/projects.toml"
            join.project.LEGACY_REGISTRY = str(legacy_registry)
            join.project.REGISTRY = str(personal_registry)
            legacy = project / "machinery.toml"
            declaration = ('name = "company"\nprefix = "cmp"\nlands_on = "ship"\n'
                           'agent_merges = true\nareas = ["billing", "api"]\n'
                           'checks = "make test"\n[review]\npersona = "Company"\n'
                           'proves = "run it"\n')
            legacy.write_text(declaration)

            messages = []
            join.migrate_registry(messages.append)
            join.ensure_declaration(str(project), messages.append)

            self.assertEqual(personal_registry.read_text(), legacy_registry.read_text())
            self.assertEqual(Path(join.project.declaration_path(str(project))).read_text(),
                             declaration)
            self.assertEqual(legacy.read_text(), declaration)

    def test_provider_home_failure_does_not_fail_project_registration(self):
        join = load_join()
        messages = []
        with mock.patch.object(join, "install", side_effect=OSError("read-only")):
            self.assertFalse(join.install_tolerantly(messages.append))
        self.assertIn("project registration is still complete", messages[0])

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
