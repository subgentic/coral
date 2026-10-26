#!/usr/bin/env python3
"""The release provenance record (#5550, Security's rule 3 of the 05:20 decision): the first step of release.yml writes down who pushed the tag,
the tagged commit, whether it is the tip of main (or at least on it), and whether the heavy gates (go-tests, go-race, cdp-gate: .github/gate.json
"always") were green on that exact code, and FAILS the release when they were not.

"That exact code": the heavy gates run on the commit that is pushed to a ci/ branch (the gated commit); the commit that is tagged is the same
tree with the release notes on top (a notes-only commit, tools/devops/land-main.sh). So the runs are looked up for the tagged commit first, and,
when it has none and it changes RELEASE_NOTES.md only, for its single parent. A tagged commit that changes anything else and has no green gates
fails.

By name (#6067): a notes commit whose message carries a trailer "Gated-commit: <40 hex>" (which must be its single parent) is judged on exactly that
commit: each gate's newest automatic push run there, runs on any other commit ignored. Without the trailer the rule above applies.

Known red (#8643): a notes commit that also carries ONE line "Accepted-red: <suite>[, <suite>...]" (1 to 3 names) lets cdp-gate be red for exactly those suites, and
nothing else. It needs the Gated-commit trailer (the waiver is for that one commit), go-tests and go-race must be success whatever it says, and every name must really be
red in cdp-gate's newest push run on the gated commit: that run's own cdp-summary artifact (named by run id and attempt, never by name across runs) lists the suites that
failed, and they must be exactly the named ones, with every part reported (a results file each; a part killed before its end is not), the parts job failed, no flaky suite, no end-check failure and the stripped-dashboard job green. A name is printed
only after it matched that list. The record gives the run, its attempt, the gated commit and the waived names: the owner reads it before approving the release
environment. The summary is made by the gated commit's own gate code, like every gate result: the protection is that the owner reads the run, not that it cannot be forged.

Usage (release.yml):  release_provenance.py REPO TAG_COMMIT_SHA ACTOR   (GITHUB_TOKEN in the environment, read-only: contents and actions)
Prints a markdown record (also fit for $GITHUB_STEP_SUMMARY). Exits 0 (gates green), 1 (not green), 2 (usage or a broken configuration).
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gate_check as g  # noqa: E402

NOTES = "RELEASE_NOTES.md"
GATED_TRAILER = re.compile(r"^Gated-commit: ([0-9a-f]{40})\s*$", re.MULTILINE)
# a cdp suite as results.json names it: "x.test.mjs", "strict: x.test.mjs", "tmux: x.test.mjs", a sequence's name. No comma (the separator), no "::" (a workflow command).
SUITE_NAME = re.compile(r"[a-z0-9_][a-z0-9_.: -]{0,100}")
ACCEPTED_LINE = re.compile(r"Accepted-red: (.+)")
MAX_ACCEPTED = 3
SUMMARY_MAX_BYTES = 65536


def suite_ok(name):
    return isinstance(name, str) and SUITE_NAME.fullmatch(name) is not None and "::" not in name and name == name.strip()


def safe(text, n=100):
    """Text of a commit message or an artifact as it may be printed into the step summary: no control character, no characters a workflow command or markdown row would use."""
    return re.sub(r"[^A-Za-z0-9_.:, -]", "?", str(text))[:n]


def accepted_red(message):
    """The names of the commit message's Accepted-red line: (None, None) when it has none, (names, None) for one well-formed line, (None, reason) for anything else."""
    lines = [l for l in message.splitlines() if re.match(r"(?i)\s*accepted-red\s*:", l)]
    if not lines:
        return None, None
    if len(lines) != 1:
        return None, "more than one Accepted-red line"
    m = ACCEPTED_LINE.fullmatch(lines[0])
    if not m:
        return None, "not in the form 'Accepted-red: <suite>[, <suite>...]': " + safe(lines[0].strip(), 60)
    names = m.group(1).split(", ")
    if not all(suite_ok(n) for n in names):
        return None, "a suite name is not a plain cdp suite name: " + safe(m.group(1), 60)
    if len(set(names)) != len(names) or len(names) > MAX_ACCEPTED:
        return None, f"names must be different, at most {MAX_ACCEPTED}"
    return names, None


def read_summary(blob):
    """cdp-gate's cdp-summary artifact (a zip of one file) as a dict, or None. Untrusted data: size-limited, parsed, never interpolated."""
    import io
    import json
    import zipfile
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            infos = z.infolist()
            if [i.filename for i in infos] != ["cdp-summary.json"] or infos[0].file_size > SUMMARY_MAX_BYTES:
                return None
            data = json.loads(z.read("cdp-summary.json"))
    except (zipfile.BadZipFile, ValueError, OSError, KeyError):
        return None
    return data if isinstance(data, dict) else None


def judge_waiver(cfg, get, get_zip, gated, run, names):
    """Whether cdp-gate's red run `run` (of the gated commit) is red only for `names`. Returns (ok, evidence): evidence is safe to print."""
    rid, attempt = run.get("id"), run.get("run_attempt", 1)
    if get_zip is None:
        return False, "the cdp summary cannot be read here"
    if run.get("event") != "push" or run.get("head_sha") != gated or not isinstance(rid, int) or not isinstance(attempt, int):
        return False, f"run {safe(rid, 20)} is not a push run of the gated commit"
    arts = [a for a in get(f"/actions/runs/{rid}/artifacts?per_page=100").get("artifacts", [])
            if a.get("name") == f"cdp-summary-a{attempt}" and not a.get("expired")
            and (a.get("workflow_run") or {}).get("id") == rid and (a.get("workflow_run") or {}).get("head_sha") == gated]
    if len(arts) != 1 or not isinstance(arts[0].get("id"), int):
        return False, f"run {rid} attempt {attempt} has no single cdp-summary artifact"
    d = read_summary(get_zip(arts[0]["id"]))
    if d is None:
        return False, f"run {rid}: the cdp summary is not a one-file zip of a JSON object"
    failed = d.get("failed")
    ok_types = (d.get("head_sha") == gated and d.get("event") == "push" and d.get("run_id") == rid and d.get("run_attempt") == attempt
                and isinstance(failed, list) and all(suite_ok(x) for x in failed) and isinstance(d.get("flaky"), list) and isinstance(d.get("ends"), int)
                and isinstance(d.get("parts_reported"), int) and isinstance(d.get("suites_run"), int) and d.get("stripped") in ("success", "skipped", "failure", "cancelled"))
    if not ok_types:
        return False, f"run {rid}: the cdp summary is not of this run or is malformed"
    if d.get("parts") != "failure":  # the matrix result: a red suite makes the parts job fail; cancelled, or success with a named red, is not an accepted state
        return False, f"run {rid}: the parts result is {safe(d.get('parts'), 20)}, not failure"
    if d["parts_reported"] != cfg.get("cdp_parts"):
        return False, f"run {rid}: {d['parts_reported']} parts reported, {cfg.get('cdp_parts')} expected"
    if d["flaky"] or d["ends"] or d["stripped"] not in ("success", "skipped") or d["suites_run"] < 1:
        return False, f"run {rid}: red for more than suites (a flaky suite, an end-check failure, a part or the stripped dashboard)"
    if sorted(failed) != sorted(names):
        return False, f"run {rid}: the suites that failed are not exactly the accepted ones ({len(failed)} failed, {len(names)} named)"
    return True, f"run {rid} attempt {attempt}, {d['suites_run']} suites ran, {url_of(run)}"


def url_of(run):
    u = str(run.get("html_url", ""))
    return u if re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+", u) else "(no run link)"


def provenance(cfg, get, repo, sha, actor, out=print, get_zip=None):
    commit = get(f"/commits/{sha}")
    files = [f["filename"] for f in commit.get("files", [])]
    parents = [p["sha"] for p in commit.get("parents", [])]
    cmp = get(f"/compare/main...{sha}")["status"]  # "identical": the tip of main; "behind": an ancestor of main
    need = list(cfg["always"])

    def runs_for(s):
        return g.Gate(cfg, get, [], s, repo=repo).latest_runs()

    def runs_for_named(s):
        """The runs of a commit the notes commit NAMED (#6067): each gate's newest automatic push run on exactly that commit; only a gate with no push run there
        falls back to a dispatched one. A manual repeat or a stray dispatch of a heavy gate (a flake repeat, a cdp-gate on main) is a newer run of the same
        workflow, and must not become the one the release reads."""
        push_cfg = dict(cfg, events=["push"], always_events=["push"])
        best_push = g.Gate(push_cfg, get, [], s, repo=repo).latest_runs()
        if all(n in best_push for n in need):
            return best_push
        best_any = runs_for(s)
        return {n: best_push.get(n) or best_any[n] for n in need if n in best_push or n in best_any}

    message = (commit.get("commit") or {}).get("message", "")
    named = GATED_TRAILER.findall(message)
    # a line that starts "Gated-commit:" but is not exactly "Gated-commit: <40 lowercase hex>" (upper case, a short sha, text after it) is a typo: refuse and
    # show the line, rather than silently judging by the old rule as if no trailer had been written
    malformed = [l.strip() for l in message.splitlines() if re.match(r"(?i)\s*gated-commit\s*:", l) and not GATED_TRAILER.match(l)]
    lines, ok = [], True
    waive, waive_why = accepted_red(message)
    waived = []
    if waive_why:
        lines.append(f"| trailer | refused | Accepted-red: {waive_why} |")
        ok = False
    elif waive and not named:
        lines.append("| trailer | refused | Accepted-red needs the Gated-commit trailer: the waiver is for that one commit |")
        ok = False
        waive = None
    if malformed:
        lines.append(f"| trailer | refused | a Gated-commit line is not in the exact form 'Gated-commit: <40 lowercase hex>': {malformed[0][:100]} |")
        ok = False
        gated, best = sha, {}
    elif named:
        # "Gated-commit: <sha>" (a trailer of the notes commit, written by whoever lands it): the release is judged on THAT commit, by name; runs on any other
        # commit (the tagged commit's own included) are ignored. It must be the single parent of a notes-only commit, so it cannot name some other code.
        if len(set(named)) != 1 or files != [NOTES] or len(parents) != 1 or named[0] != parents[0]:
            lines.append(f"| trailer | refused | Gated-commit names {', '.join(sorted(set(named)))[:100]} but the tagged commit is "
                         + ("not a notes-only commit with one parent" if files != [NOTES] or len(parents) != 1 else f"on parent {parents[0][:9]}") + " |")
            ok = False
            gated, best = sha, {}
        else:
            gated, best = named[0], runs_for_named(named[0])
    else:
        gated, best = sha, runs_for(sha)
        if not any(n in best for n in need) and files == [NOTES] and len(parents) == 1:
            gated, best = parents[0], runs_for(parents[0])
    for n in need:
        r = best.get(n)
        if r is None:
            lines.append(f"| {n} | none | no run for {gated[:9]} |")
            ok = False
        elif r["status"] == "completed" and r["conclusion"] == "success":
            lines.append(f"| {n} | success | run {r['id']} |")
        elif n == "cdp-gate" and waive and named and r["status"] == "completed" and r["conclusion"] == "failure":
            good, why = judge_waiver(cfg, get, get_zip, gated, r, waive)
            if good:
                waived = waive
                lines.append(f"| {n} | accepted red | {', '.join(waive)}: {why} |")
            else:
                lines.append(f"| {n} | failure | run {r['id']}; Accepted-red refused: {why} |")
                ok = False
        else:
            lines.append(f"| {n} | {r.get('conclusion') or r['status']} | run {r['id']} |")
            ok = False
    where = {"identical": "the tip of main", "behind": "on main (main has moved on)"}.get(cmp, f"NOT on main (compare says {cmp})")
    out("### Release provenance")
    out(f"- tag pushed by: {actor}")
    out(f"- tagged commit: {sha}")
    out(f"- position: {where}")
    out(f"- gated commit: {gated}" + ("" if gated == sha else " (named by the notes commit's Gated-commit trailer)" if named and gated == (named[0] if named else None) else " (the tagged commit adds the release notes only)"))
    out("")
    out("| gate | result | evidence |")
    out("|---|---|---|")
    for l in lines:
        out(l)
    out("")
    out(("provenance: GATES GREEN except accepted red: " + ", ".join(waived)) if ok and waived else "provenance: GATES GREEN" if ok else "provenance: NOT green: a release is not built from code whose heavy gates did not pass")
    return 0 if ok else 1


def main(argv):
    if len(argv) != 4 or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", argv[1]) or not re.fullmatch(r"[0-9a-f]{40}", argv[2]) \
            or not re.fullmatch(r"[A-Za-z0-9_.\[\]-]{1,64}", argv[3]):
        print(__doc__, file=sys.stderr)
        return 2
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        cfg = g.load_config(os.path.join(here, "..", "..", ".github", "gate.json"))
    except (OSError, ValueError) as e:
        print(f"release_provenance: {e}", file=sys.stderr)
        return 2
    return provenance(cfg, g.github_get(argv[1]), argv[1], argv[2], argv[3], get_zip=g.github_zip(argv[1]))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
