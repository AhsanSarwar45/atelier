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
SCRIPT = ROOT / "machinery/workers/review.py"


class ExternalReviewTests(unittest.TestCase):
    def fake(self, directory, body):
        path = Path(directory) / "fake-provider"
        path.write_text("#!/usr/bin/env python3\n" + body)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def run_review(self, fake, output, timeout="5", provider="claude"):
        base = subprocess.check_output(["git", "rev-parse", "HEAD^"], cwd=ROOT, text=True).strip()
        executable = "--claude" if provider == "claude" else "--codex"
        return subprocess.run([sys.executable, str(SCRIPT), "--repo", str(ROOT),
                               "--base", base, "--head", "HEAD", "--provider", provider,
                               executable, str(fake),
                               "--timeout", timeout, "--heartbeat", "0.05",
                               "--output-dir", str(output)], text=True, capture_output=True)

    def test_claude_pass_uses_internal_policy_without_personal_customizations(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = {"structured_output": {"verdict": "PASS", "summary": "clean",
                       "findings": [], "verified": ["diff"]}}
            fake = self.fake(tmp, "import json,sys\nassert '--agent' not in sys.argv\nassert '--safe-mode' in sys.argv and '--restricted' in sys.argv\nassert '--system-prompt' in sys.argv\nassert 'Work read-only' in sys.argv[sys.argv.index('--system-prompt')+1]\nprint(json.dumps(%r))\n" % payload)
            result = self.run_review(fake, Path(tmp) / "out")
            self.assertEqual(0, result.returncode, result.stderr)
            packet = (Path(tmp) / "out/packet.md").read_text()
            self.assertIn("Base commit:", packet)
            self.assertIn("Head commit:", packet)
            self.assertIn("## Diff", packet)

    def test_codex_pass_is_ephemeral_read_only_and_ignores_personal_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            verdict = {"verdict":"PASS","summary":"clean","findings":[],"verified":["diff"]}
            body = ("import json,sys\n"
                    "assert sys.argv[1]=='exec' and '--ephemeral' in sys.argv\n"
                    "assert '--ignore-user-config' in sys.argv and '--ignore-rules' in sys.argv\n"
                    "assert sys.argv[sys.argv.index('--sandbox')+1]=='read-only'\n"
                    "out=sys.argv[sys.argv.index('--output-last-message')+1]\n"
                    "open(out,'w').write(json.dumps(%r))\n" % verdict)
            fake = self.fake(tmp, body)
            result = self.run_review(fake, Path(tmp) / "out", provider="codex")
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual(verdict, json.loads((Path(tmp) / "out/verdict.json").read_text()))

    def test_needs_work_is_exit_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            finding = {"severity":"high","confidence":90,"file":"x","line":1,
                       "title":"wrong","evidence":"proof","recommendation":"fix"}
            payload = {"verdict":"NEEDS_WORK","summary":"issue","findings":[finding],"verified":[]}
            fake = self.fake(tmp, "import json\nprint(json.dumps(%r))\n" % payload)
            self.assertEqual(1, self.run_review(fake, Path(tmp) / "out").returncode)

    def test_json_in_provider_result_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            verdict = {"verdict":"PASS","summary":"clean","findings":[],"verified":[]}
            payload = {"result": json.dumps(verdict)}
            fake = self.fake(tmp, "import json\nprint(json.dumps(%r))\n" % payload)
            self.assertEqual(0, self.run_review(fake, Path(tmp) / "out").returncode)

    def test_fenced_json_in_provider_result_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            verdict = {"verdict":"PASS","summary":"clean","findings":[],"verified":[]}
            payload = {"result": "```json\n" + json.dumps(verdict) + "\n```"}
            fake = self.fake(tmp, "import json\nprint(json.dumps(%r))\n" % payload)
            self.assertEqual(0, self.run_review(fake, Path(tmp) / "out").returncode)

    def test_prose_around_json_is_reviewer_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            verdict = {"verdict":"PASS","summary":"clean","findings":[],"verified":[]}
            payload = {"result": "Here it is: " + json.dumps(verdict)}
            fake = self.fake(tmp, "import json\nprint(json.dumps(%r))\n" % payload)
            self.assertEqual(2, self.run_review(fake, Path(tmp) / "out").returncode)

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

    def test_schema_shaped_envelope_with_incomplete_finding_is_reviewer_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = {"verdict":"NEEDS_WORK","summary":"issue",
                       "findings":[{"confidence":90}],"verified":[]}
            fake = self.fake(tmp, "import json\nprint(json.dumps(%r))\n" % payload)
            self.assertEqual(2, self.run_review(fake, Path(tmp) / "out").returncode)


if __name__ == "__main__":
    unittest.main()
