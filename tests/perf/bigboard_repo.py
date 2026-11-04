#!/usr/bin/env python3
# bigboard_repo.py DIR [NCHANGES]   (#13154)
# The 35k-change git repo of the big-board fixture: a repo with a few thousand committed files, then NCHANGES (35,000) changes
# left in the working tree (about 1 in 70 an edit of a committed file, the rest new untracked files in nested folders), the
# size of the one that froze the Hub (#13079). Small files; the same names every run. Refuses a DIR that is not empty.
import os, subprocess, sys

root = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 35000
if os.path.exists(root) and os.listdir(root):
    sys.exit("refusing a folder that is not empty: " + root)
os.makedirs(root, exist_ok=True)
git = lambda *a: subprocess.run(["git", "-C", root, "-c", "user.name=perf", "-c", "user.email=perf@example.invalid", *a], check=True, stdout=subprocess.DEVNULL)
git("init", "-q", "-b", "main")
committed = max(200, n // 10)
for i in range(committed):
    d = os.path.join(root, "src", "pkg%02d" % (i % 40))
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "f%05d.txt" % i), "w").write("line %d\n" % i * 5)
git("add", "-A")
git("commit", "-q", "-m", "init")
edits = n // 70
for i in range(edits):
    open(os.path.join(root, "src", "pkg%02d" % ((i * 3) % 40), "f%05d.txt" % (i * 3)), "a").write("edited %d\n" % i)
for i in range(n - edits):
    d = os.path.join(root, "gen", "a%02d" % (i % 50), "b%02d" % ((i // 50) % 50))
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "n%06d.txt" % i), "w").write("new %d\n" % i)
print("repo %s: %d committed, %d edited, %d untracked" % (root, committed, edits, n - edits))
