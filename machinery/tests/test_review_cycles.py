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
