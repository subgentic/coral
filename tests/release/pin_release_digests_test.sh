#!/usr/bin/env bash
# tools/pin-release-digests.sh with a shim gh and a shim cosign (#12626): a good bundle prints the two rows; a wrong identity, a wrong tag, a wrong commit, a missing file, a draft, a release that is not
# immutable, a duplicated or missing line, a malformed digest, equal digests, a version that is not plain and a missing cosign each exit 1 and print NOTHING on stdout.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$here/../../tools/pin-release-digests.sh"
T="$(mktemp -d /tmp/prd.XXXXXX)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/nocosign" "$T/fix"
fail() { echo "FAIL: $*" >&2; exit 1; }

rep() { local c="$1" n="$2" out="" i; for ((i = 0; i < n; i++)); do out+="$c"; done; printf '%s' "$out"; }
D1=$(rep a 64); D2=$(rep b 64); D3=$(rep c 64); SHA=$(rep 1 40); OTHER=$(rep 2 40)

# the shim gh: what the repository and the release say, from files in $FIX
cat > "$T/bin/gh" <<'SHIM'
#!/usr/bin/env bash
case "$1 $2" in
  "api repos/subgentic/coral/releases/tags/v2.0.36"|"api repos/example/other/releases/tags/v2.0.36") cat "$FIX/release.json" ;;
  "api repos/subgentic/coral/commits/v2.0.36"|"api repos/example/other/commits/v2.0.36") cat "$FIX/sha" ;;
  "release download")
    dir=""; while [ $# -gt 0 ]; do [ "$1" = "--dir" ] && dir="$2"; shift; done
    mkdir -p "$dir"
    [ -e "$FIX/SHA256SUMS.txt" ] && cp "$FIX/SHA256SUMS.txt" "$dir/"
    [ -e "$FIX/SHA256SUMS.txt.sigstore.json" ] && cp "$FIX/SHA256SUMS.txt.sigstore.json" "$dir/"
    exit 0 ;;
  *) echo "gh shim: unexpected: $*" >&2; exit 2 ;;
esac
SHIM
# the shim cosign: accepts only the identity, tag, commit and trigger the "bundle" was signed for (SIGNED_*), and records what it was asked
cat > "$T/bin/cosign" <<'SHIM'
#!/usr/bin/env bash
if [ "$1" = version ]; then [ "$COSIGN_SHIM_VERSION" = none ] || printf 'GitVersion:    %s\nGitCommit:     abc\n' "$COSIGN_SHIM_VERSION"; exit 0; fi
echo "$*" >> "$FIX/cosign.calls"
id=""; iss=""; repo=""; ref=""; wsha=""; trig=""; [ "$1" = verify-blob ] || { echo "cosign shim: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do case "$1" in
  --certificate-identity) id="$2"; shift ;; --certificate-oidc-issuer) iss="$2"; shift ;; --certificate-github-workflow-repository) repo="$2"; shift ;;
  --certificate-github-workflow-ref) ref="$2"; shift ;; --certificate-github-workflow-sha) wsha="$2"; shift ;; --certificate-github-workflow-trigger) trig="$2"; shift ;;
esac; shift; done
[ "$id" = "$SIGNED_ID" ] && [ "$iss" = https://token.actions.githubusercontent.com ] && [ "$repo" = "$SIGNED_REPO" ] && [ "$ref" = "$SIGNED_REF" ] && [ "$wsha" = "$SIGNED_SHA" ] && [ "$trig" = push ] \
  || { echo "Error: none of the expected identities matched" >&2; exit 1; }
echo "Verified OK" >&2
SHIM
chmod +x "$T/bin/gh" "$T/bin/cosign"
ln -s "$(command -v jq)" "$T/nocosign/jq"; cp "$T/bin/gh" "$T/nocosign/gh"
PINNED="$(sed -n 's/^COSIGN_VERSION=//p' "$here/../../tools/devops/install-cosign.sh" | head -1)"
[ -n "$PINNED" ] || fail "no pinned cosign version in install-cosign.sh"

export FIX="$T/fix" GITHUB_SERVER_URL=https://github.com
export COSIGN_SHIM_VERSION="$PINNED"
good_files() {
  rm -f "$FIX"/*
  printf '{"draft":false,"tag_name":"v2.0.36","immutable":true}\n' > "$FIX/release.json"
  printf '%s' "$SHA" > "$FIX/sha"
  printf '%s  coral-linux-amd64-2.0.36.tar.gz\n%s  coral-linux-arm64-2.0.36.tar.gz\n%s  Coral.v2.0.36.dmg\n' "$D1" "$D2" "$D3" > "$FIX/SHA256SUMS.txt"
  echo bundle > "$FIX/SHA256SUMS.txt.sigstore.json"
  export SIGNED_ID="https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.36" SIGNED_REPO=subgentic/coral SIGNED_REF=refs/tags/v2.0.36 SIGNED_SHA="$SHA"
}
run() { # args...: sets OUT, ERR, CODE
  OUT="$(PATH="$T/bin:$PATH" bash "$SCRIPT" "$@" 2>"$T/err")"; CODE=$?; ERR="$(cat "$T/err")"
}
refused() { # name args...: exit 1 with nothing on stdout
  local name="$1"; shift
  run "$@"
  [ "$CODE" = 1 ] || fail "$name: exit $CODE, want 1 ($ERR)"
  [ -z "$OUT" ] || fail "$name: printed on stdout: $OUT"
  [ -n "$ERR" ] || fail "$name: said nothing on stderr"
}

# 1. a good bundle prints the two rows, from the verified file, and cosign was asked for the exact identity
good_files
run 2.0.36
[ "$CODE" = 0 ] || fail "good: exit $CODE ($ERR)"
grep -q "\"2.0.36\": {" <<<"$OUT" || fail "good: no row key: $OUT"
grep -q "AMD64: \"$D1\"," <<<"$OUT" || fail "good: amd64 digest: $OUT"
grep -q "ARM64: \"$D2\"," <<<"$OUT" || fail "good: arm64 digest: $OUT"
grep -q "cosign-verified" <<<"$OUT" || fail "good: the row says it was verified"
grep -q "$SHA" <<<"$OUT" || fail "good: the row names the commit"
grep -q -- "--certificate-identity https://github.com/subgentic/coral/.github/workflows/release.yml@refs/tags/v2.0.36 " "$FIX/cosign.calls" || fail "the exact identity was not asked: $(cat "$FIX/cosign.calls")"
grep -q -- "--certificate-github-workflow-sha $SHA " "$FIX/cosign.calls" && grep -q -- "--certificate-github-workflow-trigger push" "$FIX/cosign.calls" || fail "commit and trigger not asked"
[ "$(grep -c . <<<"$OUT")" = 5 ] || fail "good: five lines (a comment and a row): $OUT"

# 2. what cosign does not accept: nothing printed
good_files; SIGNED_ID="https://github.com/example/other/.github/workflows/release.yml@refs/tags/v2.0.36"; refused "wrong identity" 2.0.36
good_files; SIGNED_REF=refs/tags/v2.0.35; refused "wrong tag" 2.0.36
good_files; SIGNED_SHA="$OTHER"; refused "wrong commit" 2.0.36
good_files; SIGNED_REPO=example/other; refused "wrong repository" 2.0.36

# 3. what the release says
good_files; rm "$FIX/SHA256SUMS.txt"; refused "no sums file" 2.0.36
good_files; rm "$FIX/SHA256SUMS.txt.sigstore.json"; refused "no bundle" 2.0.36
good_files; printf '{"draft":true,"tag_name":"v2.0.36","immutable":true}\n' > "$FIX/release.json"; refused "a draft" 2.0.36
good_files; printf '{"draft":false,"tag_name":"v2.0.36","immutable":false}\n' > "$FIX/release.json"; refused "not immutable" 2.0.36
good_files; printf '{"draft":false,"tag_name":"v2.0.35","immutable":true}\n' > "$FIX/release.json"; refused "a release for another tag" 2.0.36
good_files; printf 'not-a-sha' > "$FIX/sha"; refused "an unreadable commit" 2.0.36

# 4. what the signed file says
good_files; printf '%s  coral-linux-amd64-2.0.36.tar.gz\n%s  coral-linux-amd64-2.0.36.tar.gz\n%s  coral-linux-arm64-2.0.36.tar.gz\n' "$D1" "$D1" "$D2" > "$FIX/SHA256SUMS.txt"; refused "a line twice" 2.0.36
good_files; printf '%s  coral-linux-amd64-2.0.36.tar.gz\n' "$D1" > "$FIX/SHA256SUMS.txt"; refused "a line missing" 2.0.36
good_files; printf '%s  coral-linux-amd64-2.0.36.tar.gz\n%s  coral-linux-arm64-2.0.36.tar.gz\n' "$(tr a-f A-F <<<"$D1")" "$D2" > "$FIX/SHA256SUMS.txt"; refused "an upper-case digest" 2.0.36
good_files; printf '%s  coral-linux-amd64-2.0.36.tar.gz\n%s  coral-linux-arm64-2.0.36.tar.gz\n' "$D1" "$D1" > "$FIX/SHA256SUMS.txt"; refused "the two digests equal" 2.0.36
good_files; printf '%s  coral-linux-amd64-2.0.36.tar.gz\n%s  coral-linux-arm64-2.0.36.tar.gz\n' "short" "$D2" > "$FIX/SHA256SUMS.txt"; refused "a short digest" 2.0.36

# 5. the version and the tools
good_files; refused "a version with a suffix" 2.0.36-rc1
good_files; refused "a version with a v" v2.0.36
good_files; refused "no version"
good_files; refused "two versions" 2.0.36 2.0.35
good_files
OUT="$(PATH="$T/nocosign:/usr/bin:/bin" bash "$SCRIPT" 2.0.36 2>"$T/err")"; CODE=$?
[ "$CODE" = 1 ] && [ -z "$OUT" ] && grep -q "cosign is not on PATH" "$T/err" || fail "cosign missing: exit $CODE out '$OUT' $(cat "$T/err")"

# 6. the repository: the home that built the tag by default (tools/release-homes.txt); --repo only names another home the table lists
good_files; run 2.0.36 --repo example/other
[ "$CODE" = 1 ] && [ -z "$OUT" ] && grep -q "is not a home listed" <<<"$ERR" || fail "--repo of an unlisted repository must be refused: exit $CODE $ERR"
printf 'v0.0.0 cdknorowski/coral\nv1.4.142 subgentic/coral\nv2.0.0 example/other\n' > "$T/homes.txt"
good_files; export SIGNED_ID="https://github.com/example/other/.github/workflows/release.yml@refs/tags/v2.0.36" SIGNED_REPO=example/other
OUT="$(RELEASE_HOMES_FILE="$T/homes.txt" PATH="$T/bin:$PATH" bash "$SCRIPT" 2.0.36 --repo example/other 2>"$T/err")"; CODE=$?
[ "$CODE" = 0 ] && grep -q "example/other/.github/workflows/release.yml@refs/tags/v2.0.36" <<<"$OUT" || fail "--repo of a listed home: exit $CODE $(cat "$T/err")"

# 7. the cosign version: only the pinned one; a v2 gets --new-bundle-format, as verify-release.sh passes it
good_files; COSIGN_SHIM_VERSION=v9.9.9 refused "a cosign that is not the pinned version" 2.0.36
grep -q "not the pinned" <<<"$ERR" || fail "the refusal names the pinned version: $ERR"
good_files; COSIGN_SHIM_VERSION=none refused "a cosign that prints no version" 2.0.36
good_files; run 2.0.36; [ "$CODE" = 0 ] || fail "the pinned cosign: exit $CODE $ERR"
if [[ "$PINNED" == v2.* ]]; then grep -q -- "--new-bundle-format" "$FIX/cosign.calls" || fail "a v2 cosign is given --new-bundle-format"; else ! grep -q -- "--new-bundle-format" "$FIX/cosign.calls" || fail "a v3 cosign is not"; fi

# the pin is READ from install-cosign.sh, not remembered: a copy of the tools whose pin is v3.0.6 accepts v3.0.6 (and passes no --new-bundle-format) and refuses the v2.4.1 that was the pin
mkdir -p "$T/tools2/devops"; cp "$here/../../tools/pin-release-digests.sh" "$here/../../tools/release-homes.sh" "$here/../../tools/release-homes.txt" "$T/tools2/"
sed 's/^COSIGN_VERSION=.*/COSIGN_VERSION=v3.0.6/' "$here/../../tools/devops/install-cosign.sh" > "$T/tools2/devops/install-cosign.sh"
good_files
OUT="$(COSIGN_SHIM_VERSION=v3.0.6 PATH="$T/bin:$PATH" bash "$T/tools2/pin-release-digests.sh" 2.0.36 2>"$T/err")"; CODE=$?
[ "$CODE" = 0 ] || fail "a copy pinned to v3.0.6 accepts v3.0.6: exit $CODE $(cat "$T/err")"
! grep -q -- "--new-bundle-format" "$FIX/cosign.calls" || fail "a v3 pin passes no --new-bundle-format"
good_files
OUT="$(COSIGN_SHIM_VERSION=v2.4.1 PATH="$T/bin:$PATH" bash "$T/tools2/pin-release-digests.sh" 2.0.36 2>"$T/err")"; CODE=$?
[ "$CODE" = 1 ] && [ -z "$OUT" ] || fail "a copy pinned to v3.0.6 refuses v2.4.1: exit $CODE '$OUT'"
echo "PASS pin_release_digests"
