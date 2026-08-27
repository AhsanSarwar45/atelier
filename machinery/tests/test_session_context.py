import importlib.machinery
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / "machinery" / "hooks" / "session-context.py"


def load_hook():
    loader = importlib.machinery.SourceFileLoader("atelier_session_context_test", str(HOOK))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class SessionContextTest(unittest.TestCase):
    def invoke(self, hook, cwd, atelier=False):
        output = io.StringIO()
        env = {"ATELIER_WORKBENCH_TOKEN": "trusted"} if atelier else {}
        with patch.dict(os.environ, env, clear=True), \
                patch("sys.stdin", io.StringIO(json.dumps({"cwd": str(cwd)}))), \
                redirect_stdout(output):
            hook.main()
        return json.loads(output.getvalue())["hookSpecificOutput"]["additionalContext"]

    def test_atelier_skill_is_only_injected_for_an_atelier_owned_session(self):
        hook = load_hook()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            hook.project.REGISTRY = str(root / "projects.toml")
            self.assertIn("# Atelier", self.invoke(hook, root, atelier=True))
            self.assertNotIn("# Atelier", self.invoke(hook, root, atelier=False))

    def test_beads_skill_follows_external_registration_across_worktrees(self):
        hook = load_hook()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            main = root / "main"
            tree = root / "tree"
            main.mkdir()
            subprocess.run(["git", "init", "-q", "-b", "main", str(main)], check=True)
            subprocess.run(["git", "-C", str(main), "config", "user.email", "test@example.com"], check=True)
            subprocess.run(["git", "-C", str(main), "config", "user.name", "Test"], check=True)
            subprocess.run(["git", "-C", str(main), "commit", "--allow-empty", "-qm", "base"], check=True)
            subprocess.run(["git", "-C", str(main), "worktree", "add", "-q", "-b", "job", str(tree)], check=True)
            registry = root / "projects.toml"
            registry.write_text('[projects]\nexample = "%s"\n' % main)
            hook.project.REGISTRY = str(registry)

            context = self.invoke(hook, tree)

            self.assertIn("# Atelier workflow", context)
            self.assertIn("Beads-registered project", context)

    def test_unregistered_project_is_explicitly_chat_only(self):
        hook = load_hook()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            hook.project.REGISTRY = str(root / "projects.toml")
            context = self.invoke(hook, root, atelier=True)
            self.assertIn("# Atelier", context)
            self.assertIn("not in a Beads-registered project", context)
            self.assertNotIn("# Atelier workflow", context)


if __name__ == "__main__":
    unittest.main()
