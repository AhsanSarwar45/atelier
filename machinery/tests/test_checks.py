import importlib.machinery
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
loader = importlib.machinery.SourceFileLoader("machinery_checks", str(ROOT / "machinery" / "checks"))
spec = importlib.util.spec_from_loader("machinery_checks", loader)
checks = importlib.util.module_from_spec(spec)
loader.exec_module(checks)


class RecordedChecks(unittest.TestCase):
    def setUp(self):
        self.declared = [
            checks.Suite("npm-test", "npm test"),
            checks.Suite("cargo-test", "(cd server && cargo test)"),
        ]

    def test_records_declared_counts_without_running_the_command(self):
        rows = checks.recorded(["npm-test=1799/0", "cargo-test=557/0"], self.declared)
        self.assertEqual([(r["name"], r["passed"], r["failed"], r["ok"]) for r in rows], [
            ("npm-test", 1799, 0, True),
            ("cargo-test", 557, 0, True),
        ])
        proof = checks.note("a" * 40, rows, "unused", manual=True)
        self.assertEqual(checks.green(proof), ("a" * 40, ["npm-test", "cargo-test"], []))
        self.assertIn("without rerunning", proof)

    def test_keeps_a_manually_recorded_failure_red(self):
        rows = checks.recorded(["npm-test=1798/1"], self.declared)
        proof = checks.note("b" * 40, rows, "unused", manual=True)
        self.assertEqual(checks.green(proof), ("b" * 40, ["npm-test"], ["npm-test"]))

    def test_refuses_a_suite_the_project_did_not_declare(self):
        with self.assertRaisesRegex(SystemExit, "declares only"):
            checks.recorded(["invented=1/0"], self.declared)

    def test_refuses_counts_that_are_not_two_integers(self):
        with self.assertRaisesRegex(SystemExit, "PASSED/FAILED"):
            checks.recorded(["npm-test=green"], self.declared)


if __name__ == "__main__":
    unittest.main()
