#!/usr/bin/env python3
"""Every test and smoke step release.yml runs is on the checked-in "run before a tag" list (#13015, Part A).

v2.0.12 and v2.0.40 failed in a release-only step (a smoke that runs only in the tag's release run) that no gate had run. This census
reads .github/workflows/release.yml, takes every script under tests/ or tools/ and every `go test` command a step runs (comments are
skipped), and holds them to tests/release/pre_tag_steps.txt:

  - each item the workflow runs is on the list, and each list line is still in the workflow (a renamed or removed step fails here);
  - each line says WHEN it runs before a tag, one of
      dryrun        the dry run (release-dryrun.yml) runs it on the notes commit, so a green dry run has run it;
      release-only  only the tag's release run runs it: DevOps reads it before the tag and names it in the pre-tag post (Part C);
    and "dryrun" is checked against release-dryrun.yml itself (a line that says dryrun must be in that workflow; one that says
    release-only must not be), so the list cannot claim a check the dry run does not make;
  - a line has a reason in its last column (what the step proves), not an empty one.

The checks are also run against edited copies (a new step, a dropped line, a wrong stage, an empty reason), each of which must fail:
a census that cannot fail is no census. No network.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RELEASE = ROOT / ".github/workflows/release.yml"
DRYRUN = ROOT / ".github/workflows/release-dryrun.yml"
LIST = ROOT / "tests/release/pre_tag_steps.txt"

SCRIPT = re.compile(r"(?<![\w./-])((?:tests|tools)/[A-Za-z0-9_./-]+\.(?:sh|py|ps1|mjs))")
GOTEST = re.compile(r"\bgo test\b(.*)")
STAGES = {"dryrun", "release-only"}


def commands(text):
    """The text of every `run:` block (comment lines and trailing comments removed), one string per workflow line."""
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        out.append(re.sub(r"\s+#.*$", "", line))
    return out


def items(text):
    """{key} of what a workflow runs: a script path, or 'go test <package> <-run pattern>'."""
    keys = set()
    for line in commands(text):
        # a Windows step writes ..\tests\x.ps1; a job in a subfolder writes ../tools/x.sh: both are the repo's tests/ or tools/ path
        norm = re.sub(r"(?<![\w-])(?:\.{1,2}/)+(?=(?:tests|tools)/)", "", line.replace("\\", "/"))
        for m in SCRIPT.finditer(norm):
            keys.add(m.group(1))
        g = GOTEST.search(line)
        if g and not line.lstrip().startswith(("-", "name:", "description")):
            args = g.group(1).split()
            pkg = next((a for a in args if a.startswith("./") or a.startswith("coral-go/")), "")
            run = ""
            if "-run" in args:
                i = args.index("-run")
                run = args[i + 1].strip("'\"") if i + 1 < len(args) else ""
            keys.add(f"go test {pkg} {run}".strip())
    return keys


def parse_list(text):
    rows = {}
    for n, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        cols = [c.strip() for c in line.split("|")]
        if len(cols) != 3:
            raise SystemExit(f"FAIL: pre_tag_steps.txt line {n}: want 'item | stage | reason', got {line!r}")
        rows[cols[0]] = (cols[1], cols[2], n)
    return rows


def problems(release_text, dryrun_text, list_text):
    bad = []
    run = items(release_text)
    dry = items(dryrun_text)
    rows = parse_list(list_text)
    for k in sorted(run - set(rows)):
        bad.append(f"release.yml runs {k!r} but it is not on pre_tag_steps.txt: say when it runs before a tag")
    for k in sorted(set(rows) - run):
        bad.append(f"pre_tag_steps.txt lists {k!r} but release.yml does not run it (renamed or removed?)")
    for k, (stage, why, n) in rows.items():
        if stage not in STAGES:
            bad.append(f"line {n} {k!r}: stage {stage!r} is not one of {sorted(STAGES)}")
        if not why:
            bad.append(f"line {n} {k!r}: no reason (what does the step prove?)")
        if stage == "dryrun" and k not in dry:
            bad.append(f"line {n} {k!r}: says dryrun but release-dryrun.yml does not run it")
        if stage == "release-only" and k in dry:
            bad.append(f"line {n} {k!r}: says release-only but release-dryrun.yml runs it: say dryrun")
    return bad


def main():
    release, dryrun, lst = RELEASE.read_text(), DRYRUN.read_text(), LIST.read_text()
    bad = problems(release, dryrun, lst)
    if bad:
        print("FAIL: the release's steps and the run-before-a-tag list disagree:")
        for b in bad:
            print("  " + b)
        return 1
    rows = parse_list(lst)
    n_dry = sum(1 for v in rows.values() if v[0] == "dryrun")
    print(f"ok: {len(rows)} release steps listed ({n_dry} in the dry run, {len(rows) - n_dry} release-only)")

    # mutants: each must be caught
    first_dry = next(k for k, v in rows.items() if v[0] == "dryrun")
    first_rel = next(k for k, v in rows.items() if v[0] == "release-only")
    muts = {
        "a new test step in release.yml": (release + "\n      - name: New\n        run: bash tests/release/brand_new_smoke.sh\n", dryrun, lst),
        "a new Windows step with backslashes": (release + "\n      - name: New\n        run: powershell -File ..\\tests\\release\\brand_new_win.ps1\n", dryrun, lst),
        "a new step under ../tools": (release + "\n      - name: New\n        run: bash ../tools/brand_new.sh\n", dryrun, lst),
        "a new go test step in release.yml": (release + "\n      - name: New\n        run: go test ./internal/x -run '^TestNew$' -count=1\n", dryrun, lst),
        "a list line dropped": (release, dryrun, "\n".join(l for l in lst.splitlines() if not l.startswith(first_rel + " "))),
        "a list line for a step that is gone": (release, dryrun, lst + "tests/release/not_there.sh | release-only | proves nothing\n"),
        "dryrun claimed for a release-only step": (release, dryrun, lst.replace(f"{first_rel} | release-only", f"{first_rel} | dryrun")),
        "release-only claimed for a dry-run step": (release, dryrun, lst.replace(f"{first_dry} | dryrun", f"{first_dry} | release-only")),
        "an unknown stage": (release, dryrun, lst.replace(f"{first_rel} | release-only", f"{first_rel} | sometime")),
        "an empty reason": (release, dryrun, re.sub(rf"^({re.escape(first_rel)} \| release-only \|).*$", r"\1 ", lst, flags=re.M)),
    }
    missed = [name for name, args in muts.items() if not problems(*args)]
    if missed:
        print("FAIL: the census did not catch: " + "; ".join(missed))
        return 1
    print(f"ok: the census catches all {len(muts)} edited copies")
    return 0


if __name__ == "__main__":
    sys.exit(main())
