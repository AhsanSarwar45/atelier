import json
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]


class HookProtocolTest(unittest.TestCase):
    def test_an_input_mutation_explicitly_allows_the_updated_input(self):
        event = {
            "tool_name": "Bash",
            "tool_input": {"command": "bd ready"},
            "session_id": "protocol-test",
            "cwd": str(ROOT),
        }
        run = subprocess.run(
            ["python3", str(ROOT / "machinery/hooks/board-actor.py")],
            input=json.dumps(event), text=True, capture_output=True, check=True,
        )

        response = json.loads(run.stdout)["hookSpecificOutput"]
        self.assertEqual(response["hookEventName"], "PreToolUse")
        self.assertEqual(response["permissionDecision"], "allow")
        self.assertIn("updatedInput", response)
        self.assertIn("--actor", response["updatedInput"]["command"])

    def test_repository_does_not_prime_again_on_every_prompt(self):
        hooks = json.loads((ROOT / ".codex/hooks.json").read_text())["hooks"]
        prompt_commands = [hook.get("command", "")
                           for block in hooks.get("UserPromptSubmit", [])
                           for hook in block.get("hooks", [])]
        start_commands = [hook.get("command", "")
                          for block in hooks.get("SessionStart", [])
                          for hook in block.get("hooks", [])]
        self.assertFalse(any("bd codex-hook UserPromptSubmit" in command
                             for command in prompt_commands))
        self.assertTrue(any("bd codex-hook SessionStart" in command
                            for command in start_commands))


if __name__ == "__main__":
    unittest.main()
