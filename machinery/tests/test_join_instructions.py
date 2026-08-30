import importlib.machinery
import importlib.util
import json
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

    def test_codex_wiring_removes_only_the_redundant_prompt_prime(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            settings = root / ".codex" / "hooks.json"
            settings.parent.mkdir()
            settings.write_text(json.dumps({"hooks": {
                "SessionStart": [{"hooks": [{
                    "type": "command", "command": "bd codex-hook SessionStart",
                }]}],
                "UserPromptSubmit": [{"hooks": [
                    {"type": "command", "command": "bd codex-hook UserPromptSubmit"},
                    {"type": "command", "command": "my-prompt-hook"},
                ]}],
            }}))

            join.wire_codex(str(root), lambda _: None)

            wired = json.loads(settings.read_text())["hooks"]
            prompt_commands = [hook["command"]
                               for block in wired["UserPromptSubmit"]
                               for hook in block["hooks"]]
            start_commands = [hook["command"]
                              for block in wired["SessionStart"]
                              for hook in block["hooks"]]
            self.assertEqual(prompt_commands, ["my-prompt-hook"])
            self.assertEqual(start_commands, ["bd codex-hook SessionStart"])

    def test_beads_review_handoff_names_the_bundled_reviewer_contract(self):
        skill = (ROOT / "machinery/skills/beads/SKILL.md").read_text()
        reviewer = (ROOT / "machinery/workers/external-review.md").read_text()

        self.assertIn("run only `machinery/board/review <job-id>`", skill)
        self.assertIn("provider-neutral", skill)
        self.assertIn("installs no", skill)
        self.assertIn("Work read-only", reviewer)
        self.assertFalse((ROOT / ".claude/agents/reviewer.md").exists())
        self.assertFalse((ROOT / "machinery/skills/external-review/SKILL.md").exists())

    def test_repository_carries_no_provider_agent_skill_command_or_output_style(self):
        for kind in ("agents", "skills", "commands", "output-styles"):
            directory = ROOT / ".claude" / kind
            held = [] if not directory.exists() else [path for path in directory.rglob("*")
                                                       if path.is_file() or path.is_symlink()]
            self.assertFalse(held, kind)
        self.assertEqual(
            ["atelier", "beads"],
            sorted(path.name for path in (ROOT / "machinery/skills").iterdir()
                   if (path / "SKILL.md").is_file()),
        )

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

    def test_personal_cleanup_removes_byte_identical_legacy_copy_but_keeps_modified_copy(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            agents = root / ".claude/agents"
            agents.mkdir(parents=True)
            owned = agents / "reviewer.md"
            modified = agents / "scout.md"
            owned.write_bytes(b"old Atelier definition")
            modified.write_bytes(b"user changed this definition")
            join.MACHINE = str(root / ".claude")
            join.CODEX_MACHINE = str(root / ".codex")
            join.PERSONAL_BIN = str(root / "bin")
            join.LEGACY_FILE_HASHES = {
                ("agents", "reviewer.md"): __import__("hashlib").sha256(owned.read_bytes()).hexdigest(),
                ("agents", "scout.md"): __import__("hashlib").sha256(b"original scout").hexdigest(),
            }

            join.install(lambda _: None)

            self.assertFalse(owned.exists())
            self.assertEqual(b"user changed this definition", modified.read_bytes())

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
            before = {path.name: path.read_bytes() for path in tree.iterdir() if path.is_file()}

            self.assertEqual(join.registered_root(str(main)), str(main.resolve()))
            self.assertEqual(join.registered_root(str(tree)), str(main.resolve()))

            join.unregister(str(tree), lambda _: None)
            self.assertIsNone(join.registered_root(str(main)))
            after = {path.name: path.read_bytes() for path in tree.iterdir() if path.is_file()}
            self.assertEqual(after, before)

    def test_join_refuses_to_invent_project_settings(self):
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
            messages = []
            join.migrate_registry(messages.append)
            with self.assertRaisesRegex(SystemExit, "atelier init"):
                join.ensure_declaration(str(project), messages.append)

            self.assertEqual(personal_registry.read_text(), legacy_registry.read_text())
            self.assertFalse(Path(join.project.declaration_path(str(project))).exists())

    def test_provider_home_failure_does_not_fail_project_registration(self):
        join = load_join()
        messages = []
        with mock.patch.object(join, "install", side_effect=OSError("read-only")):
            self.assertFalse(join.install_tolerantly(messages.append))
        self.assertIn("project registration is still complete", messages[0])

    def test_join_accepts_initializer_manifest_without_a_second_question(self):
        join = load_join()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            join.project.REGISTRY = str(root / "projects.toml")
            project = root / "company-project"
            project.mkdir()
            where = Path(join.project.declaration_path(str(project)))
            where.parent.mkdir(parents=True)
            where.write_text('''schema_version = 1
[project]
display_name = "company-project"
use_beads = true
[beads]
issue_id_prefix = "com"
[git]
completed_work_branch = "main"
agents_may_merge_completed_work = false
''')
            self.assertEqual(str(where), join.ensure_declaration(str(project), lambda _: None))
            self.assertFalse((project / "machinery.toml").exists())
            self.assertTrue(str(where).startswith(str(root / "projects")))


if __name__ == "__main__":
    unittest.main()
