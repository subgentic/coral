#!/usr/bin/env bash
# tools/devops/notes-commit.sh VER NOTES.md GATED_SHA [ACCEPTED_RED]: make the "release notes: vVER" commit on the current HEAD, which must be GATED_SHA, the commit the heavy
# gates ran on. The commit message carries the trailer "Gated-commit: <GATED_SHA>", which tests/release/release_provenance.py reads: the release is then judged
# on exactly that commit, by name, not on whichever gate run is newest (#6067). The identity is the role's, set in the command (never the global config).
#
# ACCEPTED_RED (optional, #8667): when the operator has approved known red cdp suites for this release, their names, comma separated (1 to 3). The commit then also carries
# "Accepted-red: <suite>, <suite>", the line release_provenance.py reads (#8643): cdp-gate may then be red for exactly those suites and nothing else. The names are checked by
# release_provenance.accepted_red itself, so the rule cannot differ from the one the release applies; a name that is refused stops this script before any commit.
set -euo pipefail
V=${1:?usage: notes-commit.sh VER NOTES.md GATED_SHA [ACCEPTED_RED]}; NOTES=${2:?}; GATED=${3:?}
[[ "$GATED" =~ ^[0-9a-f]{40}$ ]] || { echo "notes-commit: GATED_SHA must be the full 40-hex commit" >&2; exit 1; }
[ "$(git rev-parse HEAD)" = "$GATED" ] || { echo "notes-commit: HEAD is not $GATED: the notes go on the gated commit itself" >&2; exit 1; }
TRAILER_RED=""
if [ "$#" -ge 4 ]; then
  TRAILER_RED="$(python3 -I - "$4" "$(dirname "$0")/../../tests/release" <<'PY'
import sys
sys.path.insert(0, sys.argv[2])
import release_provenance as p
names = [n.strip() for n in sys.argv[1].split(",")]
line = "Accepted-red: " + ", ".join(names)
got, why = p.accepted_red(line)
if why or not got:
    print("notes-commit: ACCEPTED_RED refused: " + (why or "no suite named"), file=sys.stderr)
    sys.exit(1)
print(", ".join(got))
PY
)" || exit 1
fi
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "notes-commit: the working tree is not clean" >&2; exit 1; }
python3 "$(dirname "$0")/insert-notes.py" RELEASE_NOTES.md "$NOTES" "$V"
[ "$(git diff --name-only)" = RELEASE_NOTES.md ] || { echo "notes-commit: more than RELEASE_NOTES.md changed" >&2; exit 1; }
MSG="release notes: v$V

Gated-commit: $GATED"
[ -z "$TRAILER_RED" ] || MSG="$MSG
Accepted-red: $TRAILER_RED"
MSG="$MSG

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
GIT_COMMITTER_NAME='DevOps Engineer' GIT_COMMITTER_EMAIL=devops-engineer@example.invalid \
  git -c user.name='DevOps Engineer' -c user.email=devops-engineer@example.invalid commit -q -a -m "$MSG"
git log -1 --format='%h %an|%ae|%cn|%ce %s'
