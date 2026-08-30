import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("workflow_gate", HERE / "hooks" / "workflow-gate.py")
gate = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(gate)


def bash(command):
    return {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "/repo"}


def edit(*paths):
    patch_text = "\n".join("*** Update File: %s" % path for path in paths)
    return {"tool_name": "apply_patch", "tool_input": {"patch": patch_text}, "cwd": "/repo"}


def named(tool, key, path):
    """A host that names the edited file beside the content, not in a patch."""
    return {"tool_name": tool, "tool_input": {key: path, "content": "x"}, "cwd": "/repo"}


class CopyLifecycle(unittest.TestCase):
    @patch.object(gate, "card_for", return_value={"id": "bw-123"})
    def test_a_copy_can_be_cut_before_the_card_is_claimed(self, _card):
        command = "git -C /repo worktree add worktrees/bw-123 -b bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    @patch.object(gate, "card_for", return_value=None)
    def test_a_copy_cannot_be_cut_for_a_card_the_board_cannot_read(self, _card):
        command = "git -C /repo worktree add worktrees/bw-missing -b bw-missing"
        self.assertIn("no readable Beads issue", gate.reason(bash(command)))

    @patch.object(gate, "card_for", return_value={"id": "bw-123"})
    def test_a_claude_managed_copy_can_be_cut_before_claim(self, _card):
        command = "git -C /repo worktree add .claude/worktrees/bw-123 -b bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[{"status": "closed"}, {"status": "closed"}])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress", "assignee": "owner"})
    def test_a_finished_jobs_copy_can_be_removed(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[
        {"status": "closed", "labels": ["step:work"]},
        {"status": "in_progress", "assignee": "worker",
         "labels": ["step:land", "no-code"]},
    ])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress"})
    def test_a_copy_is_removed_before_its_teardown_card_closes(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "card_for", return_value={"issue_type": "task", "status": "closed"})
    def test_a_finished_claude_managed_copy_can_be_removed(self, _card, _checked):
        command = "rm -rf /repo/.claude/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIsNone(gate.reason(bash(command)))

    def test_a_similar_unmanaged_path_is_not_a_teardown_escape(self):
        command = "rm -rf /repo/other/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIn("dedicated ticket worktree", gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[
        {"status": "open", "labels": ["step:land"]},
    ])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress"})
    def test_a_land_named_code_card_does_not_bypass_unfinished_work(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIn("unfinished children", gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[{"status": "in_progress", "assignee": "worker"}])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress"})
    def test_an_active_jobs_copy_stays(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIn("still has active work", gate.reason(bash(command)))

    @patch.object(gate, "checked_out_for", return_value=True)
    @patch.object(gate, "children_for", return_value=[{"status": "open"}])
    @patch.object(gate, "card_for", return_value={"issue_type": "epic", "status": "in_progress"})
    def test_an_unstarted_child_also_keeps_the_copy(self, _card, _children, _checked):
        command = "rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune && git -C /repo branch -d bw-123"
        self.assertIn("unfinished children", gate.reason(bash(command)))

    def test_a_broad_delete_is_still_refused(self):
        self.assertIn("dedicated ticket worktree", gate.reason(bash("rm -rf /repo/anything")))


class ShellClassification(unittest.TestCase):
    def test_git_merge_base_is_read_only(self):
        self.assertFalse(gate.shell_mutates("git merge-base --is-ancestor ours topic"))

    def test_bd_search_text_cannot_turn_into_a_close(self):
        self.assertFalse(gate.shell_mutates('bd search "cannot close"'))

    def test_read_only_commands_stay_read_only_in_a_chain(self):
        command = "git status --short; git rev-parse HEAD; bd show bw-123"
        self.assertFalse(gate.shell_mutates(command))

    def test_real_repository_mutations_are_detected(self):
        for command in ("git -C /repo commit -m done", "git branch -d topic",
                        "git worktree prune"):
            with self.subTest(command=command):
                self.assertTrue(gate.shell_mutates(command))

    def test_board_writes_are_left_to_the_independent_lifecycle_gate(self):
        for command in ("bd --actor worker close bw-123", "bd update bw-123 --claim",
                        "bd create temporary"):
            with self.subTest(command=command):
                self.assertFalse(gate.shell_mutates(command))

    def test_mutation_words_inside_arguments_are_only_text(self):
        for command in ('printf "git commit"', 'rg "bd close" file.py',
                        'bd search "git merge and bd update"'):
            with self.subTest(command=command):
                self.assertFalse(gate.shell_mutates(command))

    def test_file_writes_and_package_changes_are_detected(self):
        for command in ("touch result", "npm install", "sed -i.bak x file",
                        "printf value > result"):
            with self.subTest(command=command):
                self.assertTrue(gate.shell_mutates(command))

    def test_diagnostic_redirections_outside_the_project_are_read_only(self):
        for command in ("ls missing 2>/dev/null", "git status > /tmp/status.txt"):
            with self.subTest(command=command):
                self.assertFalse(gate.shell_mutates(command))

    def test_a_path_in_a_close_reason_is_not_a_working_directory(self):
        command = ('bd close bw-123 --reason="removed '
                   '/repo/worktrees/bw-123, then released the slot"')
        self.assertIsNone(gate.reason(bash(command)))


class EditScope(unittest.TestCase):
    @patch.object(gate.bc, "waived", return_value={"words": "do it directly"})
    def test_manager_waiver_allows_a_direct_repository_edit(self, _waived):
        data = edit("/repo/src/app.ts")
        data["session_id"] = "this-session"
        self.assertIsNone(gate.reason(data))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_personal_skill_is_not_a_repository_change(self, _run, _waived):
        self.assertIsNone(gate.reason(edit("/home/person/.codex/skills/beads/SKILL.md")))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_repository_edit_still_requires_its_copy(self, _run, _waived):
        self.assertIn("dedicated ticket worktree", gate.reason(edit("/repo/src/app.ts")))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_mixed_patch_cannot_hide_a_repository_edit(self, _run, _waived):
        result = gate.reason(edit("/home/person/.codex/skills/beads/SKILL.md", "/repo/src/app.ts"))
        self.assertIn("dedicated ticket worktree", result)


class NamedEditTarget(unittest.TestCase):
    """Hosts that pass the path beside the content instead of inside a patch."""

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_named_write_outside_the_project_is_not_a_repository_change(self, _run, _waived):
        data = named("Write", "file_path", "/home/person/.codex/skills/beads/SKILL.md")
        self.assertIsNone(gate.reason(data))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_named_edit_inside_the_project_still_requires_its_copy(self, _run, _waived):
        data = named("Edit", "file_path", "/repo/src/app.ts")
        self.assertIn("dedicated ticket worktree", gate.reason(data))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_the_gate_can_be_repaired_from_a_host_that_names_the_file(self, _run, _waived):
        data = named("Edit", "file_path", "/repo/machinery/hooks/workflow-gate.py")
        self.assertIsNone(gate.reason(data))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_named_notebook_outside_the_project_is_not_a_repository_change(self, _run, _waived):
        data = named("NotebookEdit", "notebook_path", "/home/person/notes/scratch.ipynb")
        self.assertIsNone(gate.reason(data))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_an_unnamed_edit_call_is_still_guarded(self, _run, _waived):
        data = {"tool_name": "MultiEdit", "tool_input": {"edits": []}, "cwd": "/repo"}
        self.assertIn("dedicated ticket worktree", gate.reason(data))


class PathsNotProse(unittest.TestCase):
    """What a command does, rather than which words it happens to contain.

    Every one of these was refused from the shared checkout because its verb
    was on a list, however far from the project the verb was aimed. A worker
    reported roughly half its calls turned down, read-only ones among them,
    each passing on a retry or a rewording — which is the mark of a gate
    reading prose (bw-p6pv).
    """

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_copy_of_the_project_into_a_scratch_folder_changes_nothing(self, _r, _w):
        self.assertIsNone(gate.reason(bash("cp -r machinery /tmp/land-sabotage")))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_deletion_wholly_outside_the_project_changes_nothing(self, _r, _w):
        self.assertIsNone(gate.reason(bash("rm -rf /tmp/land-sabotage")))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_status_read_piped_into_another_command_changes_nothing(self, _r, _w):
        command = "bd list --status in_progress | head -5 && bd --actor s-faf11db9 show bw-merge-slot"
        self.assertIsNone(gate.reason(bash(command)))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_making_and_touching_and_emptying_outside_change_nothing(self, _r, _w):
        for command in ("mkdir -p /tmp/scratch/x", "touch /tmp/a /tmp/b",
                        "truncate -s 0 /tmp/log", "mv /tmp/a /tmp/b",
                        "install -m 644 machinery/checks /tmp/checks"):
            self.assertIsNone(gate.reason(bash(command)), command)

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_the_same_verbs_aimed_at_the_project_still_want_a_copy(self, _r, _w):
        for command in ("rm -rf server/src", "rm -rf /repo/server",
                        "cp /tmp/evil.rs server/src/needs.rs",
                        "cp -r /tmp/x machinery", "mkdir -p server/src/new",
                        "touch README.md", "truncate -s 0 README.md",
                        "install -m 644 /tmp/x machinery/y"):
            self.assertIn("dedicated ticket worktree", gate.reason(bash(command)),
                          command)

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_move_out_of_the_project_empties_the_project_and_is_guarded(self, _r, _w):
        # Unlike a copy, this end of it is a deletion here.
        data = bash("mv server/src/needs.rs /tmp/gone.rs")
        self.assertIn("dedicated ticket worktree", gate.reason(data))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_one_target_inside_guards_the_whole_command(self, _r, _w):
        data = bash("rm -rf /tmp/a server/src")
        self.assertIn("dedicated ticket worktree", gate.reason(data))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_a_word_the_shell_has_not_finished_with_is_not_a_path_yet(self, _r, _w):
        # Neither is knowable without running it, and a guess either way is a
        # gate judging a command it has not seen.
        for command in ("rm -rf $HOME/somewhere", "rm -rf *.rs"):
            self.assertIn("dedicated ticket worktree", gate.reason(bash(command)),
                          command)

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_the_destination_is_read_from_minus_t_and_not_from_last_place(self, _r, _w):
        # Taking the last word would call /tmp the source and the project the
        # destination, which is the wrong answer twice over.
        self.assertIsNone(gate.reason(bash("cp -t /tmp machinery/checks")))
        self.assertIn("dedicated ticket worktree",
                      gate.reason(bash("cp -t machinery /tmp/x")))
        self.assertIn("dedicated ticket worktree",
                      gate.reason(bash("cp --target-directory=machinery /tmp/x")))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(True, "/repo/.git"))
    def test_output_redirected_into_the_project_is_still_a_change(self, _r, _w):
        self.assertIn("dedicated ticket worktree", gate.reason(bash("echo hi > README.md")))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "run", return_value=(False, ""))
    def test_a_project_that_cannot_be_located_guards_everything(self, _r, _w):
        # No answer about where the project ends is not the answer "nowhere".
        self.assertIn("dedicated ticket worktree", gate.reason(bash("rm -rf /tmp/x")))


class HalfFinishedTeardown(unittest.TestCase):
    """The three parts of a teardown, when only the first of them ran.

    `rm -rf <copy> && git worktree prune && git branch -d <card>` stops after
    the first part and the copy is gone while the branch stays. Every retry was
    then refused, because the gate asked the board from inside the folder the
    first part had deleted — so the branch could not be deleted at all, and the
    land step could never reach its own acceptance (bw-p6pv, bw-dwxw).
    """

    TEARDOWN = ("rm -rf /repo/worktrees/bw-123 && git -C /repo worktree prune"
                " && git -C /repo branch -d bw-123")

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "already_removed", return_value=True)
    @patch.object(gate, "checked_out_for", return_value=False)
    @patch.object(gate, "children_for", return_value=[{"status": "closed"}])
    @patch.object(gate, "card_for", return_value={"id": "bw-123", "status": "closed"})
    def test_a_teardown_can_be_finished_after_its_copy_has_gone(self, *_):
        self.assertIsNone(gate.reason(bash(self.TEARDOWN)))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "already_removed", return_value=False)
    @patch.object(gate, "checked_out_for", return_value=False)
    @patch.object(gate, "children_for", return_value=[{"status": "closed"}])
    @patch.object(gate, "card_for", return_value={"id": "bw-123", "status": "closed"})
    def test_a_branch_holding_unlanded_work_is_still_not_removable(self, *_):
        self.assertIn("not the registered copy", gate.reason(bash(self.TEARDOWN)))

    @patch.object(gate.bc, "waived", return_value=None)
    @patch.object(gate, "already_removed", return_value=True)
    @patch.object(gate, "checked_out_for", return_value=False)
    def test_the_board_is_asked_from_the_checkout_that_still_exists(self, *_):
        asked = []

        def remember(issue, cwd):
            asked.append(cwd)
            return {"id": issue, "status": "closed"}

        with patch.object(gate, "card_for", remember):
            gate.reason(bash(self.TEARDOWN))
        self.assertEqual(asked, ["/repo"])


class WhatACommandWrites(unittest.TestCase):
    """Read directly, because the refusal above hides which half was wrong."""

    def test_a_copy_writes_only_where_it_lands(self):
        argv = ["cp", "-r", "machinery", "/tmp/x"]
        self.assertEqual(gate.written_by("cp", argv), ["/tmp/x"])

    def test_a_move_writes_at_both_ends(self):
        argv = ["mv", "a", "b"]
        self.assertEqual(gate.written_by("mv", argv), ["a", "b"])

    def test_a_switch_that_swallows_a_word_does_not_leave_a_path_behind(self):
        argv = ["install", "-m", "644", "src", "dst"]
        self.assertEqual(gate.written_by("install", argv), ["dst"])

    def test_a_bundled_switch_that_might_swallow_a_word_is_not_guessed_at(self):
        self.assertIsNone(gate.written_by("touch", ["touch", "-rd", "x"]))

    def test_a_lone_operand_copy_names_no_destination_to_judge(self):
        self.assertIsNone(gate.written_by("cp", ["cp", "one"]))

    def test_everything_after_a_double_dash_is_a_path(self):
        self.assertEqual(gate.written_by("rm", ["rm", "-rf", "--", "-weird"]),
                         ["-weird"])


class ACopyAlreadyGone(unittest.TestCase):
    """Driven against real Git, because what this permits is a branch deletion.

    Mocking the answer here would test the wording of a question nobody asked
    Git. The protection being relied on is Git's own: `branch -d` keeps a
    branch that holds anything the main line has not taken.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, "root")
        os.makedirs(os.path.join(self.root, "worktrees"))
        self.git("init", "-b", "main")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")
        Path(self.root, "a").write_text("1")
        self.git("add", "a")
        self.git("commit", "-m", "first")

    def git(self, *args):
        subprocess.run(("git",) + args, cwd=self.root, check=True,
                       capture_output=True)

    def copy(self, issue, landed):
        """A copy of the work, its branch either taken into main or not."""
        path = os.path.join(self.root, "worktrees", issue)
        self.git("worktree", "add", path, "-b", issue)
        Path(path, "b").write_text("2")
        subprocess.run(["git", "add", "b"], cwd=path, check=True,
                       capture_output=True)
        subprocess.run(["git", "commit", "-m", issue], cwd=path, check=True,
                       capture_output=True)
        if landed:
            self.git("merge", "--ff-only", issue)
        return path

    def test_a_copy_that_is_still_there_is_not_already_gone(self):
        path = self.copy("bw-1", landed=True)
        self.assertFalse(gate.already_removed(self.root, path, "bw-1"))

    def test_a_folder_gone_but_still_registered_is_not_gone(self):
        path = self.copy("bw-1", landed=True)
        shutil.rmtree(path)
        self.assertFalse(gate.already_removed(self.root, path, "bw-1"))

    def test_a_pruned_copy_of_landed_work_may_have_its_branch_removed(self):
        path = self.copy("bw-1", landed=True)
        shutil.rmtree(path)
        self.git("worktree", "prune")
        self.assertTrue(gate.already_removed(self.root, path, "bw-1"))

    def test_a_pruned_copy_still_holding_work_may_not(self):
        path = self.copy("bw-1", landed=False)
        shutil.rmtree(path)
        self.git("worktree", "prune")
        self.assertFalse(gate.already_removed(self.root, path, "bw-1"))


class AskingAboutLinesOfWork(unittest.TestCase):
    """`git branch` reads take words too, and a word is not a name being made.

    Every question below was refused as a repository change because it carried
    something that was not a switch — including the one asked to confirm a
    finished line had been removed, in the middle of removing it (bw-p6pv).
    """

    def test_asking_which_lines_exist_by_name_is_reading(self):
        for command in ("git branch --list bw-1", "git branch -r --list origin/*"):
            self.assertIsNone(gate.reason(bash(command)), command)

    def test_asking_which_lines_are_taken_in_or_hold_a_change_is_reading(self):
        for command in ("git branch --merged main", "git branch --no-merged main",
                        "git branch --contains HEAD", "git branch --points-at HEAD",
                        "git branch --format %(refname)"):
            self.assertIsNone(gate.reason(bash(command)), command)

    def test_a_question_with_no_subject_is_still_a_question(self):
        self.assertIsNone(gate.reason(bash("git branch --merged")))

    def test_making_renaming_or_removing_a_line_is_still_a_change(self):
        for command in ("git branch newthing", "git branch -d bw-1",
                        "git branch --delete bw-1", "git branch -m a b",
                        "git branch -f main HEAD~1", "git branch -D bw-1",
                        "git branch -c a b"):
            self.assertIn("dedicated ticket worktree", gate.reason(bash(command)),
                          command)

    def test_moving_where_a_line_follows_from_is_a_change(self):
        for command in ("git branch -u origin/main",
                        "git branch --set-upstream-to=origin/main",
                        "git branch --unset-upstream"):
            self.assertIn("dedicated ticket worktree", gate.reason(bash(command)),
                          command)

    def test_a_switch_that_two_versions_of_git_disagree_about_is_not_read(self):
        # `-l` is `--list` now and was `--create-reflog` before, and under the
        # older spelling this makes a line rather than listing one.
        self.assertIn("dedicated ticket worktree", gate.reason(bash("git branch -l bw-1")))


if __name__ == "__main__":
    unittest.main()
