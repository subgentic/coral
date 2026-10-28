#!/usr/bin/env python3
"""Tests of release_provenance.py (#5550) against a stand-in GitHub API: no network."""
import io
import json
import os
import sys
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import release_provenance as p  # noqa: E402

REPO = "subgentic/coral"
# Keep the policy exercised by these cases fixed, independent of changes to the
# live gate.json. The real release_provenance.main still loads that live policy.
CFG = {
    "branch_prefix": "ci/",
    "always": ["go-tests", "go-race", "cdp-gate"],
    "events": ["push", "pull_request", "workflow_dispatch"],
    "always_events": ["push", "workflow_dispatch"],
    "workflow_files": {n: f".github/workflows/{n}.yml" for n in ("go-tests", "go-race", "cdp-gate")},
    "cdp_parts": 9,
}
TAGGED = "b" * 40  # the notes commit that is tagged
GATED = "a" * 40  # its parent: the code the gates ran on


def run(name, sha, conclusion="success", status="completed", event="push", branch="ci/v14144", rid=1, repo=REPO, at="2026-10-21T01:00:00Z"):
    return {"id": rid, "name": name, "status": status, "conclusion": conclusion, "event": event, "head_branch": branch, "head_sha": sha,
            "created_at": at, "run_attempt": 1, "head_repository": {"full_name": repo},
            "path": f".github/workflows/{name}.yml@refs/heads/{branch}"}


def full_jobs(n=9, conclusion="success"):
    return [{"name": f"cdp (job {i})", "conclusion": conclusion} for i in range(n)] + [{"name": "cdp (repeat)", "conclusion": "skipped"}, {"name": "cdp-gate", "conclusion": "success"}]


def repeat_only_jobs():
    """what a dispatch with suites=... runs: the repeat job, and one skipped placeholder for the matrix"""
    return [{"name": "cdp (repeat)", "conclusion": "success"}, {"name": "cdp (${{ matrix.name }})", "conclusion": "skipped"}, {"name": "cdp-gate", "conclusion": "skipped"}]


def api(commits, compare, runs, artifacts=None, jobs=None):
    """commits: sha -> {files, parents}; compare: sha -> status; runs: list of run dicts; artifacts: run id -> list of artifact dicts;
    jobs: run id -> list of job dicts (default: a full green matrix)"""
    def get(path):
        if path.startswith("/actions/runs/") and "/jobs" in path:
            return {"jobs": (jobs or {}).get(int(path.split("/")[3]), full_jobs())}
        if path.startswith("/actions/runs/") and "/artifacts" in path:
            return {"artifacts": (artifacts or {}).get(int(path.split("/")[3]), [])}
        if path.startswith("/commits/"):
            c = commits[path.split("/")[2]]
            return {"files": [{"filename": f} for f in c["files"]], "parents": [{"sha": s} for s in c["parents"]], "commit": {"message": c.get("message", "")}}
        if path.startswith("/compare/main..."):
            return {"status": compare[path.split("...")[1]]}
        if path.startswith("/actions/runs?head_sha="):
            sha = path.split("head_sha=")[1].split("&")[0]
            return {"workflow_runs": [r for r in runs if r["head_sha"] == sha]}
        raise AssertionError(path)
    return get


def go(commits, compare, runs, actor="the-pusher", artifacts=None, zips=None, jobs=None):
    lines = []
    rc = p.provenance(CFG, api(commits, compare, runs, artifacts, jobs), REPO, TAGGED, actor, out=lines.append, get_zip=(lambda i: zips[i]) if zips is not None else None)
    return rc, "\n".join(lines)


NOTES_ONLY = {TAGGED: {"files": ["RELEASE_NOTES.md"], "parents": [GATED]}}
ALL_GREEN = [run("go-tests", GATED, rid=1), run("go-race", GATED, rid=2), run("cdp-gate", GATED, rid=3)]


class T(unittest.TestCase):
    def test_a_notes_commit_is_gated_by_its_parents_runs(self):
        rc, out = go(NOTES_ONLY, {TAGGED: "identical"}, ALL_GREEN)
        self.assertEqual(rc, 0, out)
        self.assertIn("tag pushed by: the-pusher", out)
        self.assertIn(f"tagged commit: {TAGGED}", out)
        self.assertIn("the tip of main", out)
        self.assertIn(f"gated commit: {GATED} (the tagged commit adds the release notes only)", out)
        self.assertIn("GATES GREEN", out)

    def test_the_record_says_when_main_has_moved_on(self):
        rc, out = go(NOTES_ONLY, {TAGGED: "behind"}, ALL_GREEN)
        self.assertEqual(rc, 0, out)
        self.assertIn("on main (main has moved on)", out)

    def test_a_commit_not_on_main_is_recorded_and_still_judged_by_its_gates(self):
        rc, out = go(NOTES_ONLY, {TAGGED: "ahead"}, ALL_GREEN)
        self.assertEqual(rc, 0, out)
        self.assertIn("NOT on main (compare says ahead)", out)

    def test_runs_on_the_tagged_commit_itself_count(self):
        runs = [run(n, TAGGED, rid=i) for i, n in enumerate(["go-tests", "go-race", "cdp-gate"], 1)]
        rc, out = go({TAGGED: {"files": ["coral-go/main.go"], "parents": [GATED]}}, {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 0, out)
        self.assertIn(f"gated commit: {TAGGED}", out)
        self.assertNotIn("adds the release notes only", out)

    # the v2.0.2 dry run: the candidate was main's tip (no notes commit, no trailer); the full cdp-gate push run was red, and a newer repeat-only dispatch
    # (suites=..., only the "cdp (repeat)" job ran) was green and was read as the gate: the dry run said GO over a red cdp.
    def tip(self):
        return {TAGGED: {"files": ["coral-go/main.go"], "parents": [GATED]}}

    def test_a_repeat_only_dispatch_does_not_replace_the_red_push_run_on_the_candidate_itself(self):
        runs = [run("go-tests", TAGGED, rid=1), run("go-race", TAGGED, rid=2),
                run("cdp-gate", TAGGED, conclusion="failure", rid=3, branch="ci/v14144", at="2026-10-21T01:00:00Z"),
                run("cdp-gate", TAGGED, rid=9, event="workflow_dispatch", branch="main", at="2026-10-21T02:00:00Z")]
        rc, out = go(self.tip(), {TAGGED: "identical"}, runs, jobs={9: repeat_only_jobs()})
        self.assertEqual(rc, 1, out)
        self.assertIn("| cdp-gate | failure | run 3 |", out)

    def test_a_green_push_run_is_not_replaced_by_a_newer_red_dispatch_on_the_candidate_itself(self):
        runs = [run("go-tests", TAGGED, rid=1), run("go-race", TAGGED, rid=2), run("cdp-gate", TAGGED, rid=3),
                run("cdp-gate", TAGGED, conclusion="failure", rid=9, event="workflow_dispatch", branch="main", at="2026-10-21T02:00:00Z")]
        rc, out = go(self.tip(), {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 0, out)
        self.assertIn("| cdp-gate | success | run 3 |", out)

    def test_with_no_push_run_a_repeat_only_dispatch_is_not_the_gate(self):
        runs = [run("go-tests", TAGGED, rid=1), run("go-race", TAGGED, rid=2), run("cdp-gate", TAGGED, rid=9, event="workflow_dispatch", branch="main")]
        rc, out = go(self.tip(), {TAGGED: "identical"}, runs, jobs={9: repeat_only_jobs()})
        self.assertEqual(rc, 1, out)
        self.assertIn("| cdp-gate | not a full run |", out)
        self.assertIn("run 9 (dispatched, not a push run)", out)

    def test_with_no_push_run_a_full_dispatch_is_the_gate_and_is_marked_dispatched(self):
        runs = [run("go-tests", TAGGED, rid=1), run("go-race", TAGGED, rid=2), run("cdp-gate", TAGGED, rid=9, event="workflow_dispatch", branch="main")]
        rc, out = go(self.tip(), {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 0, out)
        self.assertIn("| cdp-gate | success | run 9 (dispatched, not a push run) |", out)

    def test_a_dispatch_with_a_skipped_or_short_matrix_is_not_a_full_run(self):
        runs = [run("go-tests", TAGGED, rid=1), run("go-race", TAGGED, rid=2), run("cdp-gate", TAGGED, rid=9, event="workflow_dispatch", branch="main")]
        for jobs in (full_jobs(8), full_jobs(9)[:8] + [{"name": "cdp (job 8)", "conclusion": "skipped"}]):
            rc, out = go(self.tip(), {TAGGED: "identical"}, runs, jobs={9: jobs})
            self.assertEqual(rc, 1, out)
            self.assertIn("| cdp-gate | not a full run |", out)

    def test_a_failed_gate_fails_the_release(self):
        runs = [run("go-tests", GATED), run("go-race", GATED, conclusion="failure", rid=2), run("cdp-gate", GATED, rid=3)]
        rc, out = go(NOTES_ONLY, {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 1)
        self.assertIn("| go-race | failure |", out)
        self.assertIn("NOT green", out)

    def test_a_gate_still_running_or_cancelled_is_not_green(self):
        for kw in ({"status": "in_progress", "conclusion": None}, {"conclusion": "cancelled"}, {"conclusion": "skipped"}, {"conclusion": "timed_out"}):
            runs = [run("go-tests", GATED), run("go-race", GATED, rid=2, **kw), run("cdp-gate", GATED, rid=3)]
            rc, _ = go(NOTES_ONLY, {TAGGED: "identical"}, runs)
            self.assertEqual(rc, 1, kw)

    def test_a_missing_gate_fails_and_says_which(self):
        rc, out = go(NOTES_ONLY, {TAGGED: "identical"}, [run("go-tests", GATED), run("go-race", GATED, rid=2)])
        self.assertEqual(rc, 1)
        self.assertIn("| cdp-gate | none |", out)

    def test_no_gates_at_all_fails(self):
        rc, _ = go(NOTES_ONLY, {TAGGED: "identical"}, [])
        self.assertEqual(rc, 1)

    def test_a_commit_that_changes_code_does_not_borrow_its_parents_gates(self):
        rc, out = go({TAGGED: {"files": ["RELEASE_NOTES.md", "coral-go/main.go"], "parents": [GATED]}}, {TAGGED: "identical"}, ALL_GREEN)
        self.assertEqual(rc, 1, out)
        self.assertIn(f"no run for {TAGGED[:9]}", out)

    def test_a_merge_commit_does_not_borrow_a_parents_gates(self):
        rc, _ = go({TAGGED: {"files": ["RELEASE_NOTES.md"], "parents": [GATED, "c" * 40]}}, {TAGGED: "identical"}, ALL_GREEN)
        self.assertEqual(rc, 1)

    def test_a_run_of_a_look_alike_or_another_repository_or_a_main_push_does_not_count(self):
        runs = [run("go-tests", GATED, repo="evil/coral"), run("go-race", GATED, rid=2, branch="main"), run("cdp-gate", GATED, rid=3, event="pull_request")]
        rc, _ = go(NOTES_ONLY, {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 1)

    # ---- by name (#6067): the notes commit's "Gated-commit" trailer ----
    def named(self, sha=GATED, files=("RELEASE_NOTES.md",), parents=(GATED,)):
        return {TAGGED: {"files": list(files), "parents": list(parents), "message": f"release notes: v1.4.157\n\nGated-commit: {sha}\n"}}

    def test_a_named_gated_commit_is_judged_and_the_tagged_commits_own_runs_are_ignored(self):
        # 156's second stop: a cdp-gate dispatched on main sat on the tagged commit; with the old rule it made the tagged commit the judged one
        # and go-tests, go-race showed "no run". Named, it is the parent that is judged, whatever ran on the tagged commit.
        runs = ALL_GREEN + [run("cdp-gate", TAGGED, rid=9, event="workflow_dispatch", branch="main")]
        rc, out = go(self.named(), {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 0, out)
        self.assertIn(f"gated commit: {GATED} (named by the notes commit's Gated-commit trailer)", out)
        self.assertIn("| cdp-gate | success | run 3 |", out)
        # a RED run on the tagged commit does not matter either: only the named commit is read
        runs = ALL_GREEN + [run("go-tests", TAGGED, conclusion="failure", rid=9, event="workflow_dispatch", branch="main")]
        rc, out = go(self.named(), {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 0, out)

    def test_a_flake_repeat_dispatched_on_the_gated_commit_does_not_replace_its_push_run(self):
        # 156's first stop: a 10x repeat of one suite (a cdp-gate dispatch, red by design for a flaky suite) was newer than the push run and became the one read
        runs = ALL_GREEN + [run("cdp-gate", GATED, conclusion="failure", rid=9, event="workflow_dispatch", branch="ci/v14144", at="2026-10-21T02:00:00Z")]
        rc, out = go(self.named(), {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 0, out)
        self.assertIn("| cdp-gate | success | run 3 |", out)

    def test_a_red_push_run_of_the_named_commit_still_fails_the_release(self):
        runs = [run("go-tests", GATED), run("go-race", GATED, rid=2), run("cdp-gate", GATED, conclusion="failure", rid=3),
                run("cdp-gate", GATED, rid=9, event="workflow_dispatch", at="2026-10-21T02:00:00Z")]
        rc, out = go(self.named(), {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 1, out)
        self.assertIn("| cdp-gate | failure | run 3 |", out)

    def test_a_gate_with_no_push_run_on_the_named_commit_may_use_a_dispatched_one(self):
        runs = [run("go-tests", GATED), run("go-race", GATED, rid=2), run("cdp-gate", GATED, rid=3, event="workflow_dispatch")]
        rc, out = go(self.named(), {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 0, out)

    def test_a_missing_gate_on_the_named_commit_fails_and_runs_elsewhere_do_not_fill_in(self):
        runs = [run("go-tests", GATED), run("go-race", GATED, rid=2), run("cdp-gate", TAGGED, rid=3, event="workflow_dispatch", branch="main")]
        rc, out = go(self.named(), {TAGGED: "identical"}, runs)
        self.assertEqual(rc, 1, out)
        self.assertIn("| cdp-gate | none |", out)

    def test_a_trailer_that_does_not_name_the_parent_or_a_commit_that_is_not_notes_only_is_refused(self):
        other = "c" * 40
        for commits in (self.named(sha=other),
                        self.named(files=("RELEASE_NOTES.md", "coral-go/main.go")),
                        self.named(parents=(GATED, other))):
            rc, out = go(commits, {TAGGED: "identical"}, ALL_GREEN + [run("go-tests", other, rid=8), run("go-race", other, rid=7), run("cdp-gate", other, rid=6)])
            self.assertEqual(rc, 1, out)
            self.assertIn("| trailer | refused |", out)

    def test_two_different_trailers_are_refused_even_when_the_first_is_the_parent(self):
        other = "c" * 40
        commits = {TAGGED: {"files": ["RELEASE_NOTES.md"], "parents": [GATED], "message": f"release notes: v1.4.157\n\nGated-commit: {GATED}\nGated-commit: {other}\n"}}
        rc, out = go(commits, {TAGGED: "identical"}, ALL_GREEN)
        self.assertEqual(rc, 1, out)
        self.assertIn("| trailer | refused |", out)

    def test_a_mistyped_trailer_is_refused_and_shown_not_silently_ignored(self):
        for bad in (GATED.upper(), GATED[:12], GATED + " (the parent)", GATED + "x"):
            commits = {TAGGED: {"files": ["RELEASE_NOTES.md"], "parents": [GATED], "message": f"release notes: v1.4.157\n\nGated-commit: {bad}\n"}}
            rc, out = go(commits, {TAGGED: "identical"}, ALL_GREEN)
            self.assertEqual(rc, 1, out)
            self.assertIn("| trailer | refused | a Gated-commit line is not in the exact form", out)
            self.assertIn(bad[:12], out)

    # ---- a known red (#8643): the notes commit's "Accepted-red" trailer ----
    RED = "strict: board_table_seeded.test.mjs"

    def summary(self, **kw):
        d = {"head_sha": GATED, "event": "push", "run_id": 3, "run_attempt": 1, "parts_reported": 9, "suites_run": 240, "failed": [self.RED], "flaky": [], "ends": 0,
             "stripped": "success", "parts": "failure"}
        d.update(kw)
        return d

    def zipped(self, d, name="cdp-summary.json"):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr(name, json.dumps(d) if not isinstance(d, (bytes, str)) else d)
        return buf.getvalue()

    def waive(self, names=None, summary=None, runs=None, message=None, artifact=None, zipbytes=None, nogz=False):
        """Run the release with a red cdp-gate and an Accepted-red trailer; returns (rc, out)."""
        names = [self.RED] if names is None else names
        msg = message if message is not None else f"release notes: v2.0.1\n\nGated-commit: {GATED}\nAccepted-red: {', '.join(names)}\n"
        commits = {TAGGED: {"files": ["RELEASE_NOTES.md"], "parents": [GATED], "message": msg}}
        runs = runs if runs is not None else [run("go-tests", GATED), run("go-race", GATED, rid=2), run("cdp-gate", GATED, conclusion="failure", rid=3)]
        art = artifact if artifact is not None else {"id": 77, "name": "cdp-summary-a1", "expired": False, "workflow_run": {"id": 3, "head_sha": GATED}}
        blob = zipbytes if zipbytes is not None else self.zipped(summary if summary is not None else self.summary())
        return go(commits, {TAGGED: "identical"}, runs, artifacts={3: [art]}, zips=None if nogz else {77: blob})

    def test_a_named_red_suite_that_is_really_the_only_red_one_is_accepted_and_recorded(self):
        rc, out = self.waive()
        self.assertEqual(rc, 0, out)
        self.assertIn(f"| cdp-gate | accepted red | {self.RED}: run 3 attempt 1, 240 suites ran,", out)
        self.assertIn(f"provenance: GATES GREEN except accepted red: {self.RED}", out)
        self.assertIn(f"gated commit: {GATED}", out)
        # two named, both red
        two = [self.RED, "x_browser.test.mjs"]
        rc, out = self.waive(names=two, summary=self.summary(failed=two))
        self.assertEqual(rc, 0, out)

    def test_without_the_trailer_a_red_cdp_gate_still_fails(self):
        rc, out = self.waive(message=f"release notes: v2.0.1\n\nGated-commit: {GATED}\n")
        self.assertEqual(rc, 1, out)
        self.assertIn("| cdp-gate | failure | run 3 |", out)
        self.assertNotIn("accepted red", out)

    def test_a_second_red_suite_that_is_not_named_is_refused(self):
        rc, out = self.waive(summary=self.summary(failed=[self.RED, "other.test.mjs"]))
        self.assertEqual(rc, 1, out)
        self.assertIn("Accepted-red refused", out)
        self.assertNotIn("other.test.mjs", out)  # a name that was not accepted is never printed

    def test_a_named_suite_that_did_not_fail_or_does_not_exist_is_refused(self):
        rc, out = self.waive(names=["fine.test.mjs"], summary=self.summary(failed=[self.RED]))
        self.assertEqual(rc, 1, out)
        rc, out = self.waive(summary=self.summary(failed=[]))  # a later green rerun: nothing is red, the waiver is refused
        self.assertEqual(rc, 1, out)

    def test_go_tests_and_go_race_are_never_excused(self):
        for gate in ("go-tests", "go-race"):
            runs = [run("go-tests", GATED), run("go-race", GATED, rid=2), run("cdp-gate", GATED, conclusion="failure", rid=3)]
            runs = [run(gate, GATED, conclusion="failure", rid=5 if r["name"] == gate else r["id"]) if r["name"] == gate else r for r in runs]
            rc, out = self.waive(runs=runs)
            self.assertEqual(rc, 1, (gate, out))
            self.assertIn(f"| {gate} | failure |", out)
            rc, out = self.waive(names=[gate], summary=self.summary(failed=[gate]), runs=runs)
            self.assertEqual(rc, 1, (gate, out))

    def test_a_red_for_more_than_suites_is_not_excusable(self):
        for bad in ({"parts_reported": 8}, {"parts": "cancelled"}, {"parts": "success"}, {"parts": None}, {"flaky": ["f.test.mjs"]}, {"ends": 1}, {"stripped": "failure"}, {"suites_run": 0}):
            rc, out = self.waive(summary=self.summary(**bad))
            self.assertEqual(rc, 1, (bad, out))

    def test_a_summary_of_another_run_or_commit_or_attempt_or_event_is_refused(self):
        for bad in ({"head_sha": "c" * 40}, {"run_id": 4}, {"run_attempt": 2}, {"event": "workflow_dispatch"}, {"failed": "x"}, {"ends": "0"}):
            rc, out = self.waive(summary=self.summary(**bad))
            self.assertEqual(rc, 1, (bad, out))

    def test_the_artifact_must_be_this_runs_own_of_that_attempt(self):
        base = {"id": 77, "name": "cdp-summary-a1", "expired": False, "workflow_run": {"id": 3, "head_sha": GATED}}
        for bad in (dict(base, name="cdp-summary"), dict(base, name="cdp-summary-a2"), dict(base, expired=True), dict(base, workflow_run={"id": 9, "head_sha": GATED}),
                    dict(base, workflow_run={"id": 3, "head_sha": "c" * 40})):
            rc, out = self.waive(artifact=bad)
            self.assertEqual(rc, 1, (bad, out))
        rc, out = self.waive(nogz=True)  # no way to read the artifact
        self.assertEqual(rc, 1, out)

    def test_a_summary_that_is_not_a_one_file_zip_of_a_json_object_is_refused(self):
        two = io.BytesIO()
        with zipfile.ZipFile(two, "w") as z:
            z.writestr("cdp-summary.json", json.dumps(self.summary()))
            z.writestr("extra.txt", "x")
        for blob in (two.getvalue(), b"", b"not a zip", self.zipped(self.summary(), name="other.json"), self.zipped("[1]"), self.zipped("{not json"),
                     self.zipped(json.dumps(self.summary(pad="x" * 70000)))):
            rc, out = self.waive(zipbytes=blob)
            self.assertEqual(rc, 1, (blob[:20], out))

    def test_a_cancelled_cdp_gate_run_does_not_carry_a_waiver(self):
        runs = [run("go-tests", GATED), run("go-race", GATED, rid=2), run("cdp-gate", GATED, conclusion="cancelled", rid=3)]
        rc, out = self.waive(runs=runs)
        self.assertEqual(rc, 1, out)
        self.assertNotIn("accepted red", out)

    def test_a_dispatched_cdp_gate_run_does_not_carry_a_waiver(self):
        runs = [run("go-tests", GATED), run("go-race", GATED, rid=2), run("cdp-gate", GATED, conclusion="failure", rid=3, event="workflow_dispatch")]
        rc, out = self.waive(runs=runs)  # the summary says push, the run is a dispatch: the run decides
        self.assertEqual(rc, 1, out)

    def test_a_malformed_or_unplaced_trailer_is_refused_and_never_printed_raw(self):
        hostile = "x\n::error::injected"
        for names_line in ("Accepted-red:strict_x.test.mjs", "Accepted-red: ", "accepted-red: x.test.mjs", "Accepted-red: A.test.mjs", "Accepted-red: a, a", "Accepted-red: a, b, c, d",
                           "Accepted-red: a::b", "Accepted-red: a,b", "Accepted-red: go-tests ; rm"):
            rc, out = self.waive(message=f"release notes\n\nGated-commit: {GATED}\n{names_line}\n")
            self.assertEqual(rc, 1, (names_line, out))
            self.assertIn("| trailer | refused |", out)
        rc, out = self.waive(message=f"release notes\n\nGated-commit: {GATED}\nAccepted-red: a.test.mjs\nAccepted-red: b.test.mjs\n")
        self.assertEqual(rc, 1, out)
        rc, out = self.waive(message=f"release notes\n\nGated-commit: {GATED}\nAccepted-red: {hostile}\n")
        self.assertEqual(rc, 1, out)
        self.assertNotIn("::error::", out)
        rc, out = self.waive(message=f"release notes\n\nGated-commit: {GATED}\nAccepted-red: a|b`c<d>$(x)\n")  # a character a table row or a command would use
        self.assertEqual(rc, 1, out)
        for c in "|`<>$()":
            self.assertNotIn(c, out.split("| trailer | refused |")[1].split("\n")[0].rstrip(" |"), c)
        rc, out = self.waive(message=f"release notes\n\nGated-commit: {GATED}\nAccepted-red: {self.RED}\nAccepted-red: {self.RED}\n")
        self.assertEqual(rc, 1, out)
        self.assertIn("more than one Accepted-red line", out)
        # without Gated-commit the waiver has no commit to be for
        rc, out = self.waive(message=f"release notes\n\nAccepted-red: {self.RED}\n")
        self.assertEqual(rc, 1, out)
        self.assertIn("needs the Gated-commit trailer", out)

    def test_the_summary_step_counts_the_parts_that_wrote_results_and_a_killed_part_is_not_excused(self):
        """The workflow's own inline summary script, run on a temp parts/ tree: nine part directories, one of them (killed by its timeout) holding run.log only."""
        import re
        import subprocess
        import tempfile
        here = os.path.dirname(os.path.abspath(__file__))
        wf = open(os.path.join(here, "..", "..", ".github", "workflows", "cdp-gate.yml")).read()
        start = wf.index("python3 - <<'PY'\n", wf.index("\n  summary:")) + len("python3 - <<'PY'\n")
        code = "\n".join(l[10:] for l in wf[start:wf.index("          PY\n", start)].splitlines())

        def run_step(missing):
            with tempfile.TemporaryDirectory(prefix="cdp-sum-") as d:
                for n in range(1, 10):
                    pd = os.path.join(d, "parts", f"cdp-{n}-a1")
                    os.makedirs(pd)
                    open(os.path.join(pd, "run.log"), "w").write("log\n")
                    if n != missing:
                        rows = [{"test": f"s{n}.test.mjs", "status": "pass"}] + ([{"test": self.RED, "status": "fail"}] if n == 1 else [])
                        open(os.path.join(pd, "results.json"), "w").write(json.dumps(rows))
                env = dict(os.environ, PARTS_RESULT="failure", STRIPPED_RESULT="success", GITHUB_OUTPUT=os.path.join(d, "out"), GITHUB_STEP_SUMMARY=os.path.join(d, "sum"),
                           GITHUB_SHA=GATED, GITHUB_EVENT_NAME="push", GITHUB_RUN_ID="3", GITHUB_RUN_ATTEMPT="1")
                subprocess.run([sys.executable, "-I", "-c", code], cwd=d, env=env, capture_output=True, check=False)
                return json.load(open(os.path.join(d, "cdp-summary", "cdp-summary.json")))

        whole = run_step(missing=None)
        self.assertEqual((whole["parts_reported"], whole["failed"], whole["suites_run"]), (9, [self.RED], 10))
        rc, out = self.waive(summary=whole)
        self.assertEqual(rc, 0, out)
        killed = run_step(missing=5)
        self.assertEqual(killed["parts_reported"], 8, "the part with run.log only is not reported")
        rc, out = self.waive(summary=killed)
        self.assertEqual(rc, 1, out)
        self.assertIn("8 parts reported, 9 expected", out)

    def test_only_cdp_gate_can_carry_a_waiver(self):
        """A red go-tests with a valid-looking summary of its own run and a matching trailer is still refused: the waiver is judged for cdp-gate alone."""
        runs = [run("go-tests", GATED, conclusion="failure", rid=5), run("go-race", GATED, rid=2), run("cdp-gate", GATED, rid=3)]
        art = {"id": 78, "name": "cdp-summary-a1", "expired": False, "workflow_run": {"id": 5, "head_sha": GATED}}
        msg = f"release notes: v2.0.1\n\nGated-commit: {GATED}\nAccepted-red: {self.RED}\n"
        commits = {TAGGED: {"files": ["RELEASE_NOTES.md"], "parents": [GATED], "message": msg}}
        rc, out = go(commits, {TAGGED: "identical"}, runs, artifacts={5: [art]}, zips={78: self.zipped(self.summary(run_id=5))})
        self.assertEqual(rc, 1, out)
        self.assertIn("| go-tests | failure | run 5 |", out)
        self.assertNotIn("accepted red", out)

    def test_the_live_gate_json_keeps_the_three_heavy_gates_and_the_part_count(self):
        import gate_check
        cfg = gate_check.load_config(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".github", "gate.json"))
        for n in ("go-tests", "go-race", "cdp-gate"):
            self.assertIn(n, cfg["always"], "dropping a heavy gate from gate.json needs the owner: the known-red input is the way to accept a red suite (#8643)")
        self.assertEqual(cfg.get("cdp_parts"), 9, "the cdp-gate matrix has nine parts")

    def test_main_rejects_a_bad_argument_before_any_request(self):
        for argv in (["x"], ["x", "a/b", "c" * 40], ["x", "a/b", "c" * 40, "bad actor;rm"], ["x", "a b", "c" * 40, "ok"], ["x", "a/b", "zz", "ok"]):
            self.assertEqual(p.main(argv), 2, argv)


if __name__ == "__main__":
    unittest.main()
