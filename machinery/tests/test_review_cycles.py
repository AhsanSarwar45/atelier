import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE / "board"))
SPEC = importlib.util.spec_from_file_location("board_run", HERE / "board" / "run.py")
run = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(run)


class DecisionFindings(unittest.TestCase):
    def test_external_review_is_at_most_one_attempt_per_job(self):
        self.assertEqual(1, run.reading.ROUNDS)
        self.assertFalse(run.reading.attempted({"labels": []}))
        self.assertTrue(run.reading.attempted(
            {"labels": [run.reading.ATTEMPT_LABEL]}))
        self.assertTrue(run.reading.attempted(
            {"notes": "reviewed-by: review-bw-job\nread-commits: abc123"}))

    def test_review_is_not_a_mandatory_step_for_new_jobs(self):
        self.assertNotIn("review", run.spine.mandatory())
        self.assertNotIn("review", run.spine.order([]))

    def test_answered_findings_do_not_request_a_second_review(self):
        goal = {"labels": [run.reading.ATTEMPT_LABEL]}
        rows = [{"status": "closed", "labels": ["step:work"]},
                {"status": "closed", "labels": ["step:checks"]}]
        self.assertFalse(run.reading_due(
            "bw-job", goal, ["work", "checks", "review", "land"], rows, "/repo"))

    @patch.object(run, "gated", return_value=False)
    @patch.object(run, "column")
    @patch.object(run.bc, "bd", return_value=(True, ""))
    def test_opening_a_legacy_review_step_never_launches_a_reader(
            self, bd, _column, _gated):
        run.open_reading("bw-job", {}, "/repo")
        self.assertEqual(1, bd.call_count)
        self.assertFalse(hasattr(run, "fire"))

    @patch.object(run, "reading_gates", return_value=["bw-gate"])
    @patch.object(run.reading, "readers", return_value=["outside-reader"])
    def test_a_decision_answered_finding_requests_its_gated_reread(self, _readers, _gates):
        rows = [
            {"status": "closed", "labels": ["step:work"]},
            {"status": "closed", "labels": ["step:work", "no-code"]},
        ]
        self.assertTrue(run.answered_findings("bw-job", {}, rows, "/repo"))

    @patch.object(run, "reading_gates", return_value=["bw-gate"])
    @patch.object(run.reading, "readers", return_value=["outside-reader"])
    def test_an_open_finding_still_waits_for_its_answer(self, _readers, _gates):
        rows = [{"status": "open", "labels": ["step:work", "no-code"]}]
        self.assertFalse(run.answered_findings("bw-job", {}, rows, "/repo"))

    @patch.object(run, "reading_gates", return_value=["bw-gate"])
    @patch.object(run.reading, "readers", return_value=[])
    def test_the_first_reader_is_not_mistaken_for_answered_findings(self, _readers, _gates):
        rows = [{"status": "closed", "labels": ["step:work"]}]
        self.assertFalse(run.answered_findings("bw-job", {}, rows, "/repo"))


if __name__ == "__main__":
    unittest.main()
