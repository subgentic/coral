#!/usr/bin/env python3
"""tools/release-body.py VER NOTES_FILE OUT (#16503): the release page's body is the tag's own '## vVER ' section of RELEASE_NOTES.md,
never GitHub's generated PR list (which names each PR's author with an @). A missing or empty section exits 1, so the notes commit
must land before the tag. An @name outside a code span or fence would link (and ping) a GitHub account, so it is put in a code span
(`@name`); the check afterwards refuses any bare mention that is left."""
import re
import sys

MENTION = re.compile(r"(?<![A-Za-z0-9_`@/.])@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:/[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)?")


def section(text, ver):
    out, on = [], False
    for line in text.splitlines():
        if line.startswith("## v" + ver + " "):
            on = True
            continue
        if on and re.match(r"## v[0-9]", line):
            break
        if on:
            out.append(line)
    while out and not out[0].strip():
        out.pop(0)
    return out


def neutralize(lines):
    """Wrap each bare @mention in a code span, leaving fenced blocks and existing code spans alone."""
    res, fence = [], False
    for line in lines:
        if line.lstrip().startswith("```"):
            fence = not fence
            res.append(line)
            continue
        if fence:
            res.append(line)
            continue
        parts = re.split(r"(`[^`]*`)", line)
        res.append("".join(p if p.startswith("`") and p.endswith("`") and len(p) > 1 else MENTION.sub(lambda m: "`" + m.group(0) + "`", p) for p in parts))
    return res


def bare_mentions(lines):
    fence, bad = False, []
    for line in lines:
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence:
            continue
        for p in re.split(r"(`[^`]*`)", line):
            if not (p.startswith("`") and p.endswith("`") and len(p) > 1) and MENTION.search(p):
                bad.append(line)
    return bad


def main(argv):
    if len(argv) != 4:
        print("usage: release-body.py VER NOTES_FILE OUT", file=sys.stderr)
        return 2
    ver, notes, out = argv[1], argv[2], argv[3]
    with open(notes, encoding="utf-8") as f:
        lines = section(f.read(), ver)
    if not any(l.strip() for l in lines):
        print(f"::error::RELEASE_NOTES.md has no '## v{ver} ' section: commit the notes before the tag", file=sys.stderr)
        return 1
    lines = neutralize(lines)
    bad = bare_mentions(lines)
    if bad:
        print("::error::the release body still has an @mention: " + bad[0], file=sys.stderr)
        return 1
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"release body: {len(lines)} lines from RELEASE_NOTES.md, no @mentions")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
