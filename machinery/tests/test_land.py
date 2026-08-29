import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parents[1]
LOADER = importlib.machinery.SourceFileLoader("land", str(HERE / "board" / "land"))
SPEC = importlib.util.spec_from_loader("land", LOADER)
land = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(land)


def commit(sha, subject, body=""):
    """One row of `merged`: the sha, the subject line, and the whole message."""
    return (sha, subject, "%s\n%s" % (subject, body))


# The shape of the incident that cost bw-8jzg.6 (bw-sykg.1): the subject says
# what landed, and the body names a sibling only to say which LATER card takes a
# temporary allowance back off again.
MENTIONS_A_SIBLING = commit(
    "abc1234", "tst-j.1: let the reader take the wide path",
    "The allowance is temporary: it comes off with tst-j.2, which is where the\n"
    "narrow reader arrives. Until then a wide path costs nothing, and tst-j.2\n"
    "is the card that pays for it.\n")


class CarriedBySubject(unittest.TestCase):
    def test_a_sibling_the_body_only_mentions_is_not_carried(self):
        made = [MENTIONS_A_SIBLING]
        self.assertEqual(land.carried_by("tst-j.1", made), MENTIONS_A_SIBLING)
        self.assertIsNone(land.carried_by("tst-j.2", made))

    def test_a_subject_naming_two_cards_carries_both_of_them(self):
        both = commit("bcd2345", "tst-j.1 tst-j.2: one change landing two items",
                      "Neither half stands up without the other.\n")
        self.assertEqual(land.carried_by("tst-j.1", [both]), both)
        self.assertEqual(land.carried_by("tst-j.2", [both]), both)

    def test_a_subject_naming_a_child_does_not_carry_its_parent(self):
        child = commit("cde3456", "tst-j.1.2: the reading, not the whole step",
                       "The step above it stays open.\n")
        self.assertEqual(land.carried_by("tst-j.1.2", [child]), child)
        self.assertIsNone(land.carried_by("tst-j.1", [child]))

    def test_an_id_that_appears_in_the_body_alone_is_not_carried(self):
        aside = commit("def4567", "tst-j.3: the narrow reader",
                       "This is the card tst-j.2 was waiting on, and it takes the\n"
                       "allowance tst-j.2 left behind back off again.\n")
        self.assertEqual(land.carried_by("tst-j.3", [aside]), aside)
        self.assertIsNone(land.carried_by("tst-j.2", [aside]))

    def test_the_first_commit_whose_subject_names_it_is_the_one_reported(self):
        made = [commit("111aaaa", "tst-j.9: something else", "tst-j.1 is mentioned.\n"),
                MENTIONS_A_SIBLING]
        self.assertEqual(land.carried_by("tst-j.1", made), MENTIONS_A_SIBLING)


class WhatALandingCloses(unittest.TestCase):
    def landing(self, ids, made):
        rows = [{"id": cid} for cid in ids]
        with patch.object(land, "items_of", return_value=rows), \
                patch.object(land, "merged", return_value=made):
            return land.what_landed("tst-j", "/no/such/tree", "trunk..branch")

    def test_a_sibling_named_in_prose_is_left_open_by_the_landing(self):
        found = self.landing(["tst-j.1", "tst-j.2"], [MENTIONS_A_SIBLING])
        self.assertEqual(
            found,
            [("tst-j.1", "abc1234", "tst-j.1: let the reader take the wide path")])

    def test_a_landing_still_closes_every_item_its_subject_names(self):
        both = commit("bcd2345", "tst-j.1 tst-j.2: one change landing two items")
        found = self.landing(["tst-j.1", "tst-j.2", "tst-j.3"], [both])
        self.assertEqual([cid for cid, _, _ in found], ["tst-j.1", "tst-j.2"])

    def test_a_landing_whose_subjects_name_nothing_open_closes_nothing(self):
        other = commit("eef5678", "tst-k.1: another job\'s work",
                       "Reads a little like tst-j.1, and lands none of it.\n")
        self.assertEqual(self.landing(["tst-j.1"], [other]), [])


if __name__ == "__main__":
    unittest.main()
