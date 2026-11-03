#!/usr/bin/env bash
# pin-release-digests.sh X.Y.Z: print the two rows a release adds to the digest table of `coral machine launch` (#12626, #12623).
#
#   tools/pin-release-digests.sh 2.0.36
#
# `coral machine launch` passes the machine the SHA-256 of the Linux tarball it installs, and that digest comes from a table pinned in the CLI
# (coral-go/internal/machinelaunch/releases.go): a release is launchable by CLIs built after it, once it has a row. A build cannot hold its own
# release's digest (it does not exist until the release is made), so each release's row is added by the NEXT release: after a release, run this on its tag,
# paste the two lines it prints into releases.go, and review the diff.
#
# It trusts nothing it is not shown to have been signed. It checks the release's SHA256SUMS.txt with the SAME rules .github/workflows/promote.yml uses: the release is
# published (not a draft), is for this tag, is immutable; the tag's commit is read from the repository (an annotated tag is peeled), never from an input; and
# cosign verify-blob accepts the Sigstore bundle only for the exact identity of release.yml at this tag, from this commit, by a tag push. Only then are the
# two Linux lines read from the file the signature covers.
#
# ANY failure (cosign or gh or jq missing, a check that does not hold, a line missing or twice, a digest that is not 64 lower-case hex, the two digests equal)
# exits 1 and PRINTS NOTHING on stdout: the rows come out only from a verified file. Messages go to stderr.
#
# Needs: gh (logged in), jq, cosign (the PINNED one: tools/devops/install-cosign.sh), sha256 is not recomputed here. GITHUB_SERVER_URL defaults to https://github.com.
# The repository is the home that built and signed that tag (tools/release-homes.txt); --repo OWNER/NAME overrides it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "pin-release-digests: $*" >&2; exit 1; }

REPO=""
VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || die "--repo needs OWNER/NAME"; REPO="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$VERSION" ] || die "one version only"; VERSION="$1"; shift ;;
  esac
done
[ -n "$VERSION" ] || die "usage: pin-release-digests.sh X.Y.Z [--repo OWNER/NAME]"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the version must be a plain X.Y.Z (the table holds plain versions)"
TAG="v$VERSION"

for tool in gh jq cosign; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH: nothing is printed without a check (cosign: tools/devops/install-cosign.sh)"
done

if [ -z "$REPO" ]; then
  # shellcheck source=release-homes.sh
  . "$here/release-homes.sh"
  REPO="$(release_home_for_tag "$TAG" || true)"
fi
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "the repository must be OWNER/NAME"
SERVER="${GITHUB_SERVER_URL:-https://github.com}"

work="$(mktemp -d "${TMPDIR:-/tmp}/pin-digests.XXXXXX")"
trap 'rm -rf "$work"' EXIT

rel="$(gh api "repos/${REPO}/releases/tags/${TAG}")" || die "could not read the release ${TAG} of ${REPO}"
[ "$(jq -r .draft <<<"$rel")" = false ] || die "the release is a draft"
[ "$(jq -r .tag_name <<<"$rel")" = "$TAG" ] || die "the release is not for this tag"
# A row never rests on a release that could still change: the repository's immutable releases make the published assets and the tag final.
[ "$(jq -r .immutable <<<"$rel")" = true ] || die "the release is not immutable"
# The commit the tag points at, from the repository (an annotated tag is peeled to its commit), never from an input.
sha="$(gh api "repos/${REPO}/commits/${TAG}" --jq .sha)" || die "the tag's commit could not be read"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "the tag's commit could not be read"

gh release download "$TAG" --repo "$REPO" --pattern SHA256SUMS.txt --pattern SHA256SUMS.txt.sigstore.json --dir "$work/sums" >/dev/null \
  || die "could not download SHA256SUMS.txt and its bundle from ${TAG}"
[ -s "$work/sums/SHA256SUMS.txt" ] || die "SHA256SUMS.txt is missing from the release"
[ -s "$work/sums/SHA256SUMS.txt.sigstore.json" ] || die "SHA256SUMS.txt.sigstore.json is missing from the release"

# Only what release.yml signed at this tag, from this commit, by a tag push: the exact identity, not a pattern (promote.yml's rule).
cosign verify-blob "$work/sums/SHA256SUMS.txt" --bundle "$work/sums/SHA256SUMS.txt.sigstore.json" --new-bundle-format \
  --certificate-identity "${SERVER}/${REPO}/.github/workflows/release.yml@refs/tags/${TAG}" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository "$REPO" \
  --certificate-github-workflow-ref "refs/tags/${TAG}" \
  --certificate-github-workflow-sha "$sha" \
  --certificate-github-workflow-trigger push >/dev/null 2>"$work/cosign.err" \
  || { tail -3 "$work/cosign.err" >&2; die "cosign did not verify SHA256SUMS.txt for ${TAG} at ${sha}: nothing is printed"; }

line() { # the digest of exactly one line for this file name, or fail
  local name="$1" n d
  n="$(awk -v f="$name" '$2 == f || $2 == "*" f {c++} END {print c+0}' "$work/sums/SHA256SUMS.txt")"
  [ "$n" = 1 ] || die "SHA256SUMS.txt has $n lines for $name (it must have exactly one)"
  d="$(awk -v f="$name" '$2 == f || $2 == "*" f {print $1}' "$work/sums/SHA256SUMS.txt")"
  [[ "$d" =~ ^[0-9a-f]{64}$ ]] || die "the digest for $name is not 64 lower-case hex digits"
  printf '%s' "$d"
}
amd64="$(line "coral-linux-amd64-${VERSION}.tar.gz")"
arm64="$(line "coral-linux-arm64-${VERSION}.tar.gz")"
[ "$amd64" != "$arm64" ] || die "the two architectures share a digest: not a release of two builds"

# Everything held: only now is anything printed.
cat <<ROWS
	// ${VERSION}: the two Linux lines of the v${VERSION} release's SHA256SUMS.txt, cosign-verified by tools/pin-release-digests.sh against ${SERVER}/${REPO}/.github/workflows/release.yml@refs/tags/${TAG} at commit ${sha} (an immutable release).
	"${VERSION}": {
		AMD64: "${amd64}",
		ARM64: "${arm64}",
	},
ROWS
