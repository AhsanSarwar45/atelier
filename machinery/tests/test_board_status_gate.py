import importlib.util
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "board_status_gate", HERE / "hooks" / "board-status-gate.py")
gate = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(gate)


class NoCodeRecovery(unittest.TestCase):
    def test_own_commit_is_still_work_left_by_the_step(self):
        named = [{"bw-job.2"}]
        self.assertTrue(gate.effective_carrier(named, "bw-job.2", "bw-job"))

    def test_a_later_sibling_commit_carries_the_file_away(self):
        named = [{"bw-job.3"}, {"bw-job.2"}]
        self.assertFalse(gate.effective_carrier(named, "bw-job.2", "bw-job"))

    def test_an_unrelated_commit_does_not_resurrect_a_restored_edit(self):
        named = [{"bw-other.1"}]
        self.assertFalse(gate.effective_carrier(named, "bw-job.2", "bw-job"))

    def test_unrelated_commits_do_not_hide_the_steps_own_commit(self):
        named = [{"bw-other.1"}, {"bw-job.2"}]
        self.assertTrue(gate.effective_carrier(named, "bw-job.2", "bw-job"))


if __name__ == "__main__":
    unittest.main()
