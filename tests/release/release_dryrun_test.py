#!/usr/bin/env python3
"""The pre-tag dry run (#8642) runs exactly the checks release.yml's resolve step runs: every self-test line of that step must be in release-dryrun.yml,
and the dry run may add only the provenance record and the workflow lint. Run from anywhere: python3 tests/release/release_dryrun_test.py"""
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
WF = os.path.join(ROOT, ".github", "workflows")
CHECK = re.compile(r"^\s*(?:bash|python3(?: -I)?) (tests/release/[\w.]+)")


def resolve_checks(text):
    """The tests/release scripts of release.yml's `resolve` job, except resolve_release.sh itself (it needs a tag: the dry run has none)."""
    start = text.index("\n  resolve:")
    end = text.index("\n  build-linux:")
    found = []
    for line in text[start:end].splitlines():
        m = CHECK.match(line)
        if m and not m.group(1).endswith("/resolve_release.sh"):
            found.append(m.group(1))
    return found


def dryrun_checks(text):
    found = []
    for line in text.splitlines():
        m = re.search(r'run_check "[^"]+" (?:bash|python3(?: -I)?) (tests/release/[\w.]+)', line)
        if m:
            found.append(m.group(1))
        elif re.search(r'out=\$\(python3 (tests/release/release_provenance\.py) ', line):
            found.append("tests/release/release_provenance.py")   # the provenance record has its own step: only it gets the token
    return found


def main():
    rel = resolve_checks(open(os.path.join(WF, "release.yml")).read())
    dry = dryrun_checks(open(os.path.join(WF, "release-dryrun.yml")).read())
    bad = []
    for r in rel:
        if r not in dry:
            bad.append(f"release.yml's resolve step runs {r}, the dry run does not")
    for d in dry:
        if d not in rel and d not in ("tests/release/release_provenance.py", "tests/release/workflows_lint.py", "tests/release/release_dryrun_test.py"):
            bad.append(f"the dry run runs {d}, which release.yml's resolve step does not")
    if len(rel) < 15:
        bad.append(f"only {len(rel)} checks found in release.yml's resolve step: the parser is stale")
    for b in bad:
        print("FAIL: " + b)
    print(f"release_dryrun_test: {len(rel)} resolve checks, {len(dry)} in the dry run, {len(bad)} difference(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
