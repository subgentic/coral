#!/usr/bin/env python3
"""Run one Go package's tests as several test processes at once, and check that every test ran exactly once (#350).

internal/server/routes has 2,200 tests that run one after another; on Windows that is 559 s, the floor under the whole suite. Its tests are
isolated per process (own temp folder, ephemeral ports), so the same tests split over N processes finish in about 1/N of the time.

    python3 tools/go_test_shard.py [--shards 4] [--shard I] [--tags fts5] [--timeout 40m] [--count 1] PKG [-- extra test-binary flags]

PKG is a package path under coral-go, e.g. ./internal/server/routes (its TestMain must call internal/testshard.Apply).
No --shard: all shards run here, together. With --shard I (1-based), only that one runs (one CI job per shard); every shard computes the
same split from the same list, so the shards together are the whole package.
--alone TEST (repeatable) runs a wall-clock-bounded test by itself, before the shards, in one process, and in no shard. It runs in exactly one job: with no --shard, here;
with --shard I, in shard 1's run only, so if CI ever splits the shards across jobs the alone tests run once, in job 1.

The test binary is built into a folder of its own and removed when the run ends: nothing is kept for a later run. The processes share no data
folder or port: every test makes its folder with t.TempDir or os.MkdirTemp (a name no other process draws) and listens on port 0. The
environment is the caller's, unchanged, so a shard sees what the whole package would (a longer TEMP would cost a test its path budget).

A test is assigned to shard crc32(name) % N: the same on every machine, with no list to keep (the measured split of routes on 4 shards is
within 10% of an even one). The check, after the run: each assigned Test and Fuzz name reported exactly one result, and nothing unassigned ran.
"""
import argparse
import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zlib

MODULE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "coral-go")
LISTABLE = ("Test", "Fuzz", "Example")


def shard_of(name, shards):
    return zlib.crc32(name.encode("utf-8")) % shards


def split(names, shards):
    """The names of each shard (0-based), in the order given. Every name lands in exactly one."""
    out = [[] for _ in range(shards)]
    for n in names:
        out[shard_of(n, shards)].append(n)
    return out


def unknown_alone(alone, names):
    """The --alone names the package has no test of: a renamed test must not silently leave the quiet step and run in a shard."""
    have = set(names)
    return sorted(n for n in set(alone) if n not in have)


def empty_shards(parts, mine):
    """The 1-based numbers of the selected shards that were given no test. A shard that runs nothing passes, so an empty one is an error:
    a test list that did not come out (a package that lists nothing, a --shards larger than the package) must not look like a pass."""
    return [i + 1 for i in mine if not parts[i]]


def verify(assigned, results):
    """Problems with a shard's results: a Test or Fuzz name that did not report exactly once, a name nobody assigned, or an Example that
    reported twice. (An Example without an Output comment is built but never run, so it need not report.)"""
    problems = []
    seen = {}
    for name in results:
        seen[name] = seen.get(name, 0) + 1
    want = set(assigned)
    for n in sorted(want):
        if seen.get(n, 0) == 0 and not n.startswith("Example"):
            problems.append("%s was assigned and never reported a result" % n)
    for n, c in sorted(seen.items()):
        if n not in want:
            problems.append("%s ran but was not assigned to this shard" % n)
        elif c > 1:
            problems.append("%s reported %d results" % (n, c))
    return problems


def parse(lines):
    """The test2json events among the lines of a shard's output; a line that is not one is returned as (None, line)."""
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            yield None, line
            continue
        yield (e if isinstance(e, dict) else None), line


def top_level_results(lines):
    """Names of the top-level tests with a final pass/fail/skip event."""
    return [e["Test"] for e, _ in parse(lines)
            if e and e.get("Test") and "/" not in e["Test"] and e.get("Action") in ("pass", "fail", "skip")]


def failure_output(lines):
    """What a failed shard printed: lines that are not events, the output of each failed test (a failed subtest's too), and any output
    that belongs to no test (a panic, a timeout dump, a TestMain message)."""
    failed, out, loose = set(), {}, []
    for e, line in parse(lines):
        if e is None:
            loose.append(line)
        elif e.get("Action") == "fail" and e.get("Test"):
            failed.add(e["Test"])
        elif e.get("Action") == "output":
            if e.get("Test"):
                out.setdefault(e["Test"], []).append(e["Output"])
            else:
                loose.append(e["Output"].rstrip("\n"))
    parts = loose[:]
    for name in sorted(failed):
        parts.append("".join(out.get(name, [])).rstrip("\n"))
    return "\n".join(parts)


def go(args, **kw):
    return subprocess.run(["go"] + args, cwd=MODULE_DIR, **kw)


# -test.paniconexit0 is the flag `go test` always gives a test binary, and internal/testtemp (the private temp, home and data folder of every test package) acts only in a process that has it: a runner
# that starts the binary itself must pass it, or its tests run in the real folders (#356).
def run_shard(label, names, binary, pkgdir, work, flags, timeout, count):
    listfile = os.path.join(work, "%s.txt" % label)
    with open(listfile, "w", newline="\n") as f:
        f.write("\n".join(names) + "\n")
    env = dict(os.environ, CORAL_TEST_SHARD_LIST=listfile)
    cmd = ["go", "tool", "test2json", "-p", "shard", binary, "-test.paniconexit0", "-test.v=test2json", "-test.timeout=" + timeout, "-test.count=%d" % count] + flags
    log = os.path.join(work, "%s.log" % label)
    with open(log, "wb") as out:
        rc = subprocess.run(cmd, cwd=pkgdir, env=env, stdout=out, stderr=subprocess.STDOUT).returncode
    with open(log, encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    return label, rc, lines


def report(label, rc, lines, assigned):
    """Print one process's result; True when it failed (a non-zero exit, or a test that did not report exactly once)."""
    problems = verify(assigned, top_level_results(lines))
    counts = {}
    for e, _ in parse(lines):
        if e and e.get("Test") and "/" not in e["Test"] and e.get("Action") in ("pass", "fail", "skip"):
            counts[e["Action"]] = counts.get(e["Action"], 0) + 1
    print("%s: exit %d, %s" % (label, rc, ", ".join("%d %s" % (v, k) for k, v in sorted(counts.items())) or "no results"), flush=True)
    if rc or problems:
        print(failure_output(lines))
        for p in problems:
            print("%s: %s" % (label, p))
        return True
    return False


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--shards", type=int, default=4)
    ap.add_argument("--shard", type=int, help="run only this shard (1-based)")
    ap.add_argument("--tags", default="")
    ap.add_argument("--timeout", default="40m")
    ap.add_argument("--count", type=int, default=1)
    ap.add_argument("--alone", action="append", default=[], metavar="TEST",
                    help="a test with a wall-clock bound: run by itself, in one process before the shards start (with --shard, in shard 1's run), and in no shard. Repeatable. A name the package does not have is an error")
    ap.add_argument("pkg")
    ap.add_argument("flags", nargs="*", help="after --: flags for the test binary, as -test.short")
    a = ap.parse_args(argv)
    if a.shards < 1 or (a.shard is not None and not 1 <= a.shard <= a.shards):
        ap.error("--shard must be between 1 and --shards")

    work = tempfile.mkdtemp(prefix="gotestshard-")
    try:
        tagargs = ["-tags", a.tags] if a.tags else []
        binary = os.path.join(work, "pkg.test" + (".exe" if os.name == "nt" else ""))
        t = go(["list", "-f", "{{.Dir}}"] + tagargs + [a.pkg], capture_output=True, text=True)
        if t.returncode:
            sys.stderr.write(t.stderr)
            return 2
        pkgdir = t.stdout.strip()
        if go(["test", "-c", "-o", binary] + tagargs + [a.pkg]).returncode:
            return 2
        listing = subprocess.run([binary, "-test.list", "."], cwd=pkgdir, capture_output=True, text=True)
        if listing.returncode:
            sys.stderr.write(listing.stdout + listing.stderr)
            return 2
        names = [n for n in listing.stdout.split() if n.startswith(LISTABLE)]
        missing = unknown_alone(a.alone, names)
        if missing:
            print("FAIL: --alone names no test of %s: %s (renamed or removed? edit the list)" % (a.pkg, ", ".join(missing)))
            return 2
        alone = sorted(set(a.alone))
        shared = [n for n in names if n not in alone]
        parts = split(shared, a.shards)
        assert sorted(sum(parts, []) + alone) == sorted(names), "the shards are not the whole package"
        mine = [i for i in range(a.shards) if a.shard in (None, i + 1)]
        empty = empty_shards(parts, mine)
        if empty:
            print("FAIL: %s lists %d tests, and shard(s) %s of %d would run none" % (a.pkg, len(names), ",".join(map(str, empty)), a.shards))
            return 2
        print("%s: %d tests; shards %s of %d: %s tests; alone: %d" % (a.pkg, len(names), ",".join(str(i + 1) for i in mine), a.shards,
                                                               ",".join(str(len(parts[i])) for i in mine), len(alone)), flush=True)
        failed = []
        if alone and 0 in mine:
            # The timing tests run first, in a quiet process: nothing else of this run is using the machine yet.
            label, rc, lines = run_shard("alone", alone, binary, pkgdir, work, a.flags, a.timeout, a.count)
            if report(label, rc, lines, alone):
                failed.append(label)
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(mine)) as pool:
            jobs = [pool.submit(run_shard, "shard %d" % (i + 1), parts[i], binary, pkgdir, work, a.flags, a.timeout, a.count) for i in mine]
            for job in concurrent.futures.as_completed(jobs):
                label, rc, lines = job.result()
                if report(label, rc, lines, parts[int(label.split()[1]) - 1]):
                    failed.append(label)
        if failed:
            print("FAIL: %s" % ", ".join(sorted(failed)))
            return 1
        print("ok: every test of the shard(s) ran exactly once")
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
