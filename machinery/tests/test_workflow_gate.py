import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("workflow_gate", HERE / "hooks" / "workflow-gate.py")
gate = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(gate)


def bash(command):
    return {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "/repo"}


def edit(*paths):
    patch_text = "\n".join("*** Update File: %s" % path for path in paths)
    return {"tool_name": "apply_patch", "tool_input": {"patch": patch_text}, "cwd": "/repo"}


class CopyLifecycle(unittest.TestCase):
    @patch.object(gate, "card_for", return_value={"id": "bw-123"})
    def test_a_copy_can_be_cut_before_the_card_is_claimed(self, _card):
        command = "git -C /repo worktree add worktrees/bw-123 -b bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    @patch.object(gate, "card_for", return_value=None)
    def test_a_copy_cannot_be_cut_for_a_card_the_board_cannot_read(self, _card):
        command = "git -C /repo worktree add worktrees/bw-missing -b bw-missing"
        self.assertIn("no readable Beads issue", gate.reason(bash(command)))

    @patch.object(gate, "card_for", return_value={"id": "bw-123"})
    def test_a_claude_managed_copy_can_be_cut_before_claim(self, _card):
        command = "git -C /repo worktree add .claude/worktrees/bw-123 -b bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[{"status": "closed"}, {"status": "closed"}])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress", "assignee": "owner"})
    def test_a_finished_jobs_copy_can_be_removed(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[
        {"status": "closed", "labels": ["step:work"]},
        {"status": "in_progress", "assignee": "worker",
         "labels": ["step:land", "no-code"]},
    ])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress"})
    def test_a_copy_is_removed_before_its_teardown_card_closes(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "card_for", return_value={"issue_type": "task", "status": "closed"})
    def test_a_finished_claude_managed_copy_can_be_removed(self, _card, _checked):
        command = "rm -rf /repo/.claude/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    def test_a_similar_unmanaged_path_is_not_a_teardown_escape(self):
        command = "rm -rf /repo/other/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIn("dedicated ticket worktree", gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[
        {"status": "open", "labels": ["step:land"]},
    ])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress"})
    def test_a_land_named_code_card_does_not_bypass_unfinished_work(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIn("unfinished children", gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[{"status": "in_progress", "assignee": "worker"}])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress"})
    def test_an_active_jobs_copy_stays(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIn("still has active work", gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[{"status": "open"}])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress"})
    def test_an_unstarted_child_also_keeps_the_copy(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIn("unfinished children", gate.reason(bash(command)))

    def test_a_broad_delete_is_still_refused(self):
        self.assertIn("dedicated ticket worktree", gate.reason(bash("rm -rf /repo/anything")))


class ShellClassification(unittest.TestCase):
    def test_git_merge_base_is_read_only(self):
        self.assertFalse(gate.shell_mutates("git merge-base --is-ancestor ours topic"))

    def test_bd_search_text_cannot_turn_into_a_close(self):
        self.assertFalse(gate.shell_mutates('bd search "cannot close"'))

    def test_read_only_commands_stay_read_only_in_a_chain(self):
        command = "git status --short; git rev-parse HEAD; bd show bw-123"
        self.assertFalse(gate.shell_mutates(command))

    def test_real_repository_mutations_are_detected(self):
        for command in ("git -C /repo commit -m done", "git branch -d topic",
                        "git worktree prune"):
            with self.subTest(command=command):
                self.assertTrue(gate.shell_mutates(command))

    def test_board_writes_are_left_to_the_independent_lifecycle_gate(self):
        for command in ("bd --actor worker close bw-123", "bd update bw-123 --claim",
                        "bd create temporary"):
            with self.subTest(command=command):
                self.assertFalse(gate.shell_mutates(command))

    def test_mutation_words_inside_arguments_are_only_text(self):
        for command in ('printf "git commit"', 'rg "bd close" file.py',
                        'bd search "git merge and bd update"'):
            with self.subTest(command=command):
                self.assertFalse(gate.shell_mutates(command))

    def test_file_writes_and_package_changes_are_detected(self):
        for command in ("touch result", "npm install", "sed -i.bak x file",
                        "printf value > result"):
            with self.subTest(command=command):
                self.assertTrue(gate.shell_mutates(command))

    def test_diagnostic_redirections_outside_the_project_are_read_only(self):
        for command in ("ls missing 2>/dev/null", "git status > /tmp/status.txt"):
            with self.subTest(command=command):
                self.assertFalse(gate.shell_mutates(command))

    def test_a_path_in_a_close_reason_is_not_a_working_directory(self):
        command = ('bd close bw-123 --reason="removed '
                   '/repo/worktrees/bw-123, then released the slot"')
        self.assertIsNone(gate.reason(bash(command)))


class EditScope(unittest.TestCase):
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_personal_skill_is_not_a_repository_change(self, _run):
        self.assertIsNone(gate.reason(edit("/home/person/.codex/skills/beads/SKILL.md")))

    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_repository_edit_still_requires_its_copy(self, _run):
        self.assertIn("dedicated ticket worktree", gate.reason(edit("/repo/src/app.ts")))

    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_mixed_patch_cannot_hide_a_repository_edit(self, _run):
        result = gate.reason(edit("/home/person/.codex/skills/beads/SKILL.md", "/repo/src/app.ts"))
        self.assertIn("dedicated ticket worktree", result)


if __name__ == "__main__":
    unittest.main()
