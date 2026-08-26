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


class CopyLifecycle(unittest.TestCase):
    @patch.object(gate, "card_for", return_value={"id": "bw-123"})
    def test_a_copy_can_be_cut_before_the_card_is_claimed(self, _card):
        command = "git -C /repo worktree add worktrees/bw-123 -b bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    @patch.object(gate, "card_for", return_value=None)
    def test_a_copy_cannot_be_cut_for_a_card_the_board_cannot_read(self, _card):
        command = "git -C /repo worktree add worktrees/bw-missing -b bw-missing"
        self.assertIn("no readable Beads issue", gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[{"status": "closed"}, {"status": "closed"}])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress", "assignee": "owner"})
    def test_a_finished_jobs_copy_can_be_removed(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIsNone(gate.reason(bash(command)))

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


if __name__ == "__main__":
    unittest.main()
