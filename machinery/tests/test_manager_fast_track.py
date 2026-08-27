import importlib.machinery
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parents[1]
LOADER = importlib.machinery.SourceFileLoader("waive", str(HERE / "board" / "waive"))
SPEC = importlib.util.spec_from_loader("waive", LOADER)
waive = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(waive)


class ManagerFastTrackSession(unittest.TestCase):
    def test_codex_session_can_hold_the_manager_waiver(self):
        with patch.dict(os.environ, {"CODEX_SESSION_ID": "codex-turn"}, clear=True):
            self.assertEqual(waive.session(), "codex-turn")

    def test_claude_session_keeps_precedence_when_both_exist(self):
        with patch.dict(os.environ, {
            "CLAUDE_CODE_SESSION_ID": "claude-turn",
            "CODEX_SESSION_ID": "codex-turn",
        }, clear=True):
            self.assertEqual(waive.session(), "claude-turn")

    def test_a_process_without_a_session_cannot_waive_the_board(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(SystemExit):
                waive.session()


if __name__ == "__main__":
    unittest.main()
