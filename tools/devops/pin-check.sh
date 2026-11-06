#!/usr/bin/env bash
# pin-check.sh X.Y.Z [REPO_DIR]: fail release prep when the PREVIOUS release has no digest row (#13779). Read-only: it never writes a row.
#
#   tools/devops/pin-check.sh 2.0.57            # the batch is the checked-out tree
#   tools/devops/pin-check.sh 2.0.57 /tmp/wt-b  # the batch is in a worktree
#
# `coral machine launch` installs a release on a cloud machine only when the CLI pins that release's Linux digests
# (coral-go/internal/machinelaunch/releases.go). A build cannot hold its own release's digest, so each batch must add the row
# of the release BEFORE it: v2.0.57's batch pins v2.0.56 (tools/pin-release-digests.sh 2.0.56, cosign-verified, reviewed diff).
# This check finds the newest plain vX.Y.Z tag below X.Y.Z and exits 1, printing the exact command, when the batch's releases.go has no row for it.
# It does not run the pin script, does not fetch anything and does not edit a file: a row is only ever added from a verified SHA256SUMS.txt by a person's reviewed diff.
#
# Exit codes: 0 the previous release is pinned; 1 it is not (the command to run is printed); 2 usage or a broken tree.
set -euo pipefail

die() { echo "pin-check: $*" >&2; exit 2; }

VERSION="${1:-}"
DIR="${2:-.}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: pin-check.sh X.Y.Z [REPO_DIR] (X.Y.Z is the release being prepared)"
TABLE="$DIR/coral-go/internal/machinelaunch/releases.go"
[ -f "$TABLE" ] || die "no $TABLE: pass the batch's repository folder"

# The newest plain tag below VERSION (a -dev, -beta or -rc tag is never pinned).
prev="$(git -C "$DIR" tag --list 'v[0-9]*.[0-9]*.[0-9]*' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' \
  | awk -v v="$VERSION" -F. 'BEGIN{split(v,t,".")} {if ($1<t[1] || ($1==t[1] && ($2<t[2] || ($2==t[2] && $3<t[3])))) print}' \
  | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
[ -n "$prev" ] || die "no plain release tag below $VERSION in $DIR"

if grep -Eq "^[[:space:]]*\"${prev//./\\.}\":[[:space:]]*\{" "$TABLE"; then
  echo "pin-check: v$prev is pinned in $TABLE (release $VERSION may be prepared)"
  exit 0
fi
echo "pin-check: v$prev has NO digest row in $TABLE: the batch for $VERSION must add it before the gate." >&2
echo "  run:  tools/pin-release-digests.sh $prev   (needs gh logged in and the pinned cosign; it prints nothing unless the release checks hold)" >&2
echo "  then paste its two lines into releaseDigests in versions order and REVIEW the diff; Security reads it." >&2
exit 1
