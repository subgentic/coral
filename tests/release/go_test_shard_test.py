#!/usr/bin/env python3
"""Unit tests of tools/go_test_shard.py: the split is the whole package, and the exactly-once check catches what it must (#350)."""
import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("go_test_shard", os.path.join(HERE, "..", "..", "tools", "go_test_shard.py"))
shard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shard)

NAMES = ["Test%d" % i for i in range(500)] + ["FuzzA", "ExampleB", "TestSub_Name"]


def event(action, test=None, out=""):
    e = {"Action": action}
    if test:
        e["Test"] = test
    if out:
        e["Output"] = out
    return json.dumps(e)


class SplitTests(unittest.TestCase):
    def test_every_name_lands_in_exactly_one_shard(self):
        for n in (1, 2, 3, 4, 7):
            parts = shard.split(NAMES, n)
            self.assertEqual(n, len(parts))
            self.assertEqual(sorted(NAMES), sorted(sum(parts, [])))

    def test_the_split_does_not_depend_on_the_order_or_the_machine(self):
        a = shard.split(NAMES, 4)
        b = shard.split(list(reversed(NAMES)), 4)
        self.assertEqual([sorted(x) for x in a], [sorted(x) for x in b])

    def test_crc32_assignment_is_pinned(self):
        # A change of hash would move every test to another shard: harmless for correctness, but it must be a decision.
        self.assertEqual(2, shard.shard_of("TestA", 4))
        self.assertEqual(shard.shard_of("TestA", 4), shard.shard_of("TestA", 4))

    def test_shards_are_balanced(self):
        sizes = [len(p) for p in shard.split(["TestName%d" % i for i in range(2000)], 4)]
        self.assertLess(max(sizes) - min(sizes), 120, sizes)


class EmptyShardTests(unittest.TestCase):
    def test_a_shard_with_no_test_is_reported(self):
        self.assertEqual([2], shard.empty_shards([["TestA"], [], ["TestB"]], [0, 1, 2]))
        self.assertEqual([], shard.empty_shards([["TestA"], [], ["TestB"]], [0, 2]), "only the selected shards count")

    def test_a_package_that_lists_nothing_leaves_every_shard_empty(self):
        self.assertEqual([1, 2, 3, 4], shard.empty_shards(shard.split([], 4), range(4)))

    def test_more_shards_than_tests_is_caught(self):
        self.assertTrue(shard.empty_shards(shard.split(["TestA", "TestB"], 8), range(8)))


class AloneTests(unittest.TestCase):
    def test_a_name_the_package_lacks_is_reported(self):
        self.assertEqual(["TestGone"], shard.unknown_alone(["TestA", "TestGone"], ["TestA", "TestB"]))
        self.assertEqual([], shard.unknown_alone([], ["TestA"]))

    def test_the_alone_tests_and_the_shards_are_the_whole_package(self):
        names = ["Test%d" % i for i in range(100)]
        alone = ["Test3", "Test50"]
        parts = shard.split([n for n in names if n not in alone], 4)
        self.assertEqual(sorted(names), sorted(sum(parts, []) + alone))
        self.assertFalse(set(alone) & set(sum(parts, [])))


class VerifyTests(unittest.TestCase):
    def test_a_clean_shard_has_no_problem(self):
        self.assertEqual([], shard.verify(["TestA", "TestB"], ["TestB", "TestA"]))

    def test_a_missing_test_is_a_problem(self):
        p = shard.verify(["TestA", "TestB"], ["TestA"])
        self.assertEqual(1, len(p))
        self.assertIn("TestB", p[0])

    def test_a_test_that_ran_twice_or_belongs_elsewhere_is_a_problem(self):
        self.assertTrue(any("2 results" in p for p in shard.verify(["TestA"], ["TestA", "TestA"])))
        self.assertTrue(any("not assigned" in p for p in shard.verify(["TestA"], ["TestA", "TestZ"])))

    def test_an_example_without_output_need_not_report(self):
        self.assertEqual([], shard.verify(["TestA", "ExampleB"], ["TestA"]))

    def test_a_fuzz_target_must_report(self):
        self.assertTrue(shard.verify(["FuzzA"], []))


class ParseTests(unittest.TestCase):
    def test_only_top_level_final_results_count(self):
        lines = [event("run", "TestA"), event("output", "TestA", "x\n"), event("run", "TestA/sub"), event("pass", "TestA/sub"), event("pass", "TestA"),
                 event("fail", "TestB"), event("skip", "TestC"), event("pass"), "not json", "3"]
        self.assertEqual(["TestA", "TestB", "TestC"], shard.top_level_results(lines))

    def test_failure_output_has_the_failed_test_and_the_loose_lines(self):
        lines = [event("output", "TestA", "fine\n"), event("pass", "TestA"), event("output", "TestB", "boom\n"), event("fail", "TestB"),
                 event("output", None, "panic: x\n"), "stray line"]
        out = shard.failure_output(lines)
        self.assertIn("boom", out)
        self.assertIn("panic: x", out)
        self.assertIn("stray line", out)
        self.assertNotIn("fine", out)


if __name__ == "__main__":
    unittest.main()
