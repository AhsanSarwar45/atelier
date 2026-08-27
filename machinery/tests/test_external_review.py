import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "machinery/external-review/scripts/external_review.py"


class ExternalReviewTests(unittest.TestCase):
    def fake(self, directory, body):
        path = Path(directory) / "fake-claude"
        path.write_text("#!/usr/bin/env python3\n" + body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def run_review(self, fake, output, timeout="5"):
        base = subprocess.check_output(["git", "rev-parse", "HEAD^"], cwd=ROOT, text=True).strip()
        return subprocess.run([sys.executable, str(SCRIPT), "--repo", str(ROOT),
                               "--base", base, "--head", "HEAD", "--claude", str(fake),
                               "--timeout", timeout, "--heartbeat", "0.05",
                               "--output-dir", str(output)], text=True, capture_output=True)

    def test_pass_uses_named_agent_without_model_and_writes_packet(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = {"structured_output": {"verdict": "PASS", "summary": "clean",
                       "findings": [], "verified": ["diff"]}}
            fake = self.fake(tmp, "import json,sys\nassert '--agent' in sys.argv and sys.argv[sys.argv.index('--agent')+1]=='reviewer'\nassert '--model' not in sys.argv\nprint(json.dumps(%r))\n" % payload)
            result = self.run_review(fake, Path(tmp) / "out")
            self.assertEqual(0, result.returncode, result.stderr)
            packet = (Path(tmp) / "out/packet.md").read_text()
            self.assertIn("Base commit:", packet)
            self.assertIn("Head commit:", packet)
            self.assertIn("## Diff", packet)

    def test_needs_work_is_exit_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            finding = {"severity":"high","confidence":90,"file":"x","line":1,
                       "title":"wrong","evidence":"proof","recommendation":"fix"}
            payload = {"verdict":"NEEDS_WORK","summary":"issue","findings":[finding],"verified":[]}
            fake = self.fake(tmp, "import json\nprint(json.dumps(%r))\n" % payload)
            self.assertEqual(1, self.run_review(fake, Path(tmp) / "out").returncode)

    def test_timeout_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = self.fake(tmp, "import time\ntime.sleep(10)\n")
            result = self.run_review(fake, Path(tmp) / "out", "1")
            self.assertEqual(124, result.returncode)
            self.assertIn("TIMEOUT", result.stderr)

    def test_malformed_result_is_reviewer_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = self.fake(tmp, "print('not json')\n")
            self.assertEqual(2, self.run_review(fake, Path(tmp) / "out").returncode)


if __name__ == "__main__":
    unittest.main()
