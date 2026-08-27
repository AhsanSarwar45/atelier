import importlib.machinery
import importlib.util
import tempfile
import unittest
import os
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
REVIEW = ROOT / "machinery/board/review"


def load_review():
    loader = importlib.machinery.SourceFileLoader("atelier_review_test", str(REVIEW))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class ReviewRunnerTests(unittest.TestCase):
    def test_review_checks_override_read_only_scratch_paths(self):
        review = load_review()
        with mock.patch.dict(os.environ, {"TMPDIR": "/home/readonly",
                                          "CCACHE_DIR": "/home/readonly"}):
            environment = review.review_check_environment()
        expected = "/tmp" if os.name != "nt" else tempfile.gettempdir()
        self.assertEqual(expected, environment["TMPDIR"])
        self.assertTrue(environment["CCACHE_DIR"].startswith(expected))

    def test_structured_external_verdict_becomes_board_finding(self):
        review = load_review()
        external = {"verdict": "NEEDS_WORK", "summary": "one issue",
                    "verified": ["registration"],
                    "findings": [{"severity": "high", "confidence": 95,
                                  "file": "machinery/project.py", "line": 42,
                                  "title": "Windows uses the wrong data folder",
                                  "evidence": "The application reads another path.",
                                  "recommendation": "python3 check.py prints PASS"}]}

        parsed = review.parse(__import__("json").dumps(external))

        self.assertEqual(["registration"], parsed["checked"])
        self.assertEqual("machinery/project.py:42", parsed["findings"][0]["where"])
        self.assertEqual("The application reads another path.",
                         parsed["findings"][0]["why"])
        self.assertEqual("python3 check.py prints PASS",
                         parsed["findings"][0]["fixed_when"])

    def test_attempt_uses_checkout_that_owns_commit(self):
        review = load_review()
        with tempfile.TemporaryDirectory() as held, \
             mock.patch.object(review, "whose", return_value="/foreign/repository"), \
             mock.patch.object(review, "git", return_value="base-sha"), \
             mock.patch.object(review, "run_reviewer", return_value=("{}", "ok")) as run:
            review.attempts("spec", "actor", "goal", held, ["head-sha"])

        run.assert_called_once_with("spec", "actor", "goal",
                                    "/foreign/repository", "base-sha",
                                    "head-sha", held)


if __name__ == "__main__":
    unittest.main()
