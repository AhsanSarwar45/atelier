import importlib.machinery
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
PROJECT_FILE = ROOT / "machinery/project.py"


def load_project():
    loader = importlib.machinery.SourceFileLoader("external_project_test", str(PROJECT_FILE))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class ExternalProjectMetadataTests(unittest.TestCase):
    def test_external_declaration_is_shared_without_repository_file(self):
        project = load_project()
        with tempfile.TemporaryDirectory() as held:
            root = Path(held) / "project"
            root.mkdir()
            project.REGISTRY = str(Path(held) / "personal/projects.toml")
            declaration = Path(project.declaration_path(str(root)))
            declaration.parent.mkdir(parents=True)
            declaration.write_text('name="project"\nprefix="prj"\nareas=["api"]\n')

            read = project.of(str(root))

            self.assertEqual("prj", read.prefix)
            self.assertEqual(["api"], read.areas)
            self.assertFalse((root / "machinery.toml").exists())

    def test_no_board_tool_references_retired_declaration_constant(self):
        paths = [ROOT / "machinery/checks",
                 ROOT / "machinery/hooks/board-merge-gate.py"]
        self.assertFalse(any("project.DECLARATION" in path.read_text()
                             for path in paths))

    def test_legacy_checks_are_read_from_the_linked_worktree(self):
        with tempfile.TemporaryDirectory() as held:
            root = Path(held)
            main = root / "project"
            tree = root / "worktree"
            main.mkdir()
            subprocess.run(["git", "init", "-q", "-b", "main", str(main)], check=True)
            subprocess.run(["git", "-C", str(main), "config", "user.email",
                            "test@example.com"], check=True)
            subprocess.run(["git", "-C", str(main), "config", "user.name", "Test"],
                           check=True)
            (main / "machinery.toml").write_text('checks = "echo main-checks"\n')
            subprocess.run(["git", "-C", str(main), "add", "machinery.toml"], check=True)
            subprocess.run(["git", "-C", str(main), "commit", "-qm", "base"], check=True)
            subprocess.run(["git", "-C", str(main), "worktree", "add", "-q", "-b", "job",
                            str(tree)], check=True)
            (tree / "machinery.toml").write_text('checks = "echo worktree-checks"\n')
            environment = dict(os.environ, ATELIER_DATA_DIR=str(root / "personal"))

            run = subprocess.run([str(ROOT / "machinery/checks"), "--dry", "--all"],
                                 cwd=tree, env=environment, capture_output=True,
                                 text=True, check=True)

            self.assertIn("echo worktree-checks", run.stdout)
            self.assertNotIn("echo main-checks", run.stdout)

    def test_windows_data_home_matches_the_application(self):
        project = load_project()
        with mock.patch.object(project.os, "name", "nt"), \
             mock.patch.dict(project.os.environ,
                             {"APPDATA": r"C:\Users\x\AppData\Roaming",
                              "ATELIER_DATA_DIR": ""}):
            path = project.atelier_data_dir()
        self.assertTrue(path.replace("\\", "/").endswith(
            "AppData/Roaming/weselow/atelier/data"), path)


if __name__ == "__main__":
    unittest.main()
