import importlib.machinery
import importlib.util
import tempfile
import unittest
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
