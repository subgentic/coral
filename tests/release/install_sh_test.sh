#!/usr/bin/env bash
# install_sh_test.sh: the root install.sh (#11935) against a local fake release (file:// via CORAL_INSTALL_BASE_URL), no network.
# Everything is in one temp folder with its own HOME: nothing reaches /Applications, ~/Applications, ~/.local or ~/.coral.
# Linux is run as a simulation on any host (CORAL_INSTALL_OS/ARCH); the macOS install runs only on a Mac (it needs hdiutil).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/install.sh"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-sh-test.XXXXXX")"
trap 'chmod -R u+w "$tmp" 2>/dev/null; rm -rf "$tmp"' EXIT
export HOME="$tmp/home"; mkdir -p "$HOME"
unset CORAL_LINK_DIR
# A real cosign on the PATH would check the fixture's stand-in bundle and fail it: the "checksum only" cases need none, and the cosign cases bring a stub. Drop every PATH folder that holds one.
clean_path=""; IFS=: read -ra path_dirs <<<"$PATH"
for d in "${path_dirs[@]}"; do [ -e "$d/cosign" ] || clean_path="${clean_path:+$clean_path:}$d"; done
export PATH="$clean_path"
fails=0
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
ok() { echo "ok: $*"; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

# --- the fake release: latest/download and download/v9.9.9 hold the same files ------------------------
rel="$tmp/releases"
make_release() { # make_release <folder>
    local d="$1" pk="$tmp/pk-$RANDOM"
    mkdir -p "$d" "$pk"
    for a in amd64 arm64; do
        rm -rf "$pk/t"; mkdir -p "$pk/t"
        printf '#!/bin/sh\necho coral-%s\n' "$a" >"$pk/t/coral"; chmod 755 "$pk/t/coral"
        printf '#!/bin/sh\necho board\n' >"$pk/t/coral-board"; chmod 755 "$pk/t/coral-board"
        mkdir -p "$pk/t/licenses/vendor/x" "$pk/t/licenses/fonts" # the real package holds a licenses/ tree beside the programs (QA's MUST on #11935)
        echo "license text" >"$pk/t/licenses/vendor/x/LICENSE"; echo font >"$pk/t/licenses/fonts/F.txt"
        tar czf "$d/coral-linux-$a.tar.gz" -C "$pk/t" .
    done
    if [ "$(uname -s)" = Darwin ]; then
        rm -rf "$pk/dmg"; mkdir -p "$pk/dmg/Coral.app/Contents/MacOS"
        printf '#!/bin/sh\necho app\n' >"$pk/dmg/Coral.app/Contents/MacOS/coral"; chmod 755 "$pk/dmg/Coral.app/Contents/MacOS/coral"
        printf '#!/bin/bash\nmkdir -p "${CORAL_LINK_DIR:-$HOME/.local/bin}" && ln -sf "$(dirname "$0")/coral" "${CORAL_LINK_DIR:-$HOME/.local/bin}/coral"\n' >"$pk/dmg/Coral.app/Contents/MacOS/install-cli.sh"; chmod 755 "$pk/dmg/Coral.app/Contents/MacOS/install-cli.sh"
        hdiutil create -quiet -srcfolder "$pk/dmg" -volname Coral -format UDZO "$d/Coral.dmg"
    fi
    echo '{}' >"$d/SHA256SUMS.txt.sigstore.json" # a stand-in bundle: the cosign cases use a stub cosign
    sums "$d"
}
sums() { (cd "$1" && : >SHA256SUMS.txt && for f in *.tar.gz *.dmg; do [ -e "$f" ] && echo "$(sha "$f")  $f" >>SHA256SUMS.txt; done; true); }
make_release "$rel/latest/download"
mkdir -p "$rel/download"; cp -R "$rel/latest/download" "$rel/download/v9.9.9"
export CORAL_INSTALL_BASE_URL="file://$rel"
run() { local out; out="$("$@" 2>&1)" && rc=0 || rc=$?; output="$out"; }

# --- the program list is the shipped one (tests/release/commands.txt) ---------------------------------------------
want_progs="$(grep -vE '^[[:space:]]*(#|$)' "$root/tests/release/commands.txt" | sort | tr '\n' ' ')"
have_progs="$(grep -E '^PROGRAMS=\(' "$script" | sed -E 's/^PROGRAMS=\((.*)\)$/\1/' | tr ' ' '\n' | grep . | sort | tr '\n' ' ')"
[ "$want_progs" = "$have_progs" ] && ok "install.sh's PROGRAMS equal commands.txt" || fail "PROGRAMS differ from commands.txt: [$have_progs] vs [$want_progs]"

grep -qE '^CORAL_TEAM_ID="33UR27T84L"' "$script" && ok "install.sh pins Coral's Developer ID team" || fail "the pinned team is not 33UR27T84L"
# --- flags ---------------------------------------------------------------------------------------------
run bash "$script" --version; [ "$rc" = 0 ] && [[ "$output" == "Coral installer "* ]] && ok "--version prints the installer's version" || fail "--version: $rc $output"
run bash "$script" --help; [ "$rc" = 0 ] && [[ "$output" == *"--dry-run"* ]] && ok "--help lists the options" || fail "--help: $rc"
run bash "$script" --bogus; [ "$rc" = 2 ] && ok "an unknown option exits 2" || fail "unknown option exit $rc"
run bash "$script" --release; [ "$rc" != 0 ] && ok "--release with no version is refused" || fail "--release with no value passed"
run bash "$script" --release '../x' --dry-run; [ "$rc" != 0 ] && ok "a release that is not a version is refused" || fail "odd --release accepted"
CORAL_INSTALL_BASE_URL=http://example.invalid/x run bash "$script" --dry-run; [ "$rc" != 0 ] && ok "a plain http base is refused" || fail "http base accepted"

# --- dry run: says what, changes nothing -------------------------------------------------------------
dest="$tmp/dry/bin"
CORAL_INSTALL_OS=Linux CORAL_INSTALL_ARCH=x86_64 run bash "$script" --dry-run --dir "$dest"
if [ "$rc" = 0 ] && [[ "$output" == *"coral-linux-amd64.tar.gz"* ]] && [[ "$output" == *"Dry run"* ]] && [ ! -e "$dest" ] && [ -z "$(ls -A "$HOME")" ]; then ok "--dry-run names the package and changes nothing"; else fail "dry run: $rc $output"; fi

# --- the signing-team pin shows in the plan: pinned from Coral's own release location, not from another one ----------
CORAL_INSTALL_OS=Darwin CORAL_INSTALL_ARCH=arm64 CORAL_INSTALL_BASE_URL= run bash "$script" --dry-run
[[ "$output" == *"must be signed by Coral's Developer ID team (33UR27T84L)"* ]] && ok "the default release location pins Coral's team" || fail "default pin not shown: $output"
CORAL_INSTALL_OS=Darwin CORAL_INSTALL_ARCH=arm64 run bash "$script" --dry-run
[[ "$output" != *"must be signed by"* ]] && ok "a custom location pins no team" || fail "custom location pinned: $output"
CORAL_INSTALL_OS=Darwin CORAL_INSTALL_ARCH=arm64 CORAL_INSTALL_TEAM_ID=ABCDE12345 run bash "$script" --dry-run
[[ "$output" == *"(ABCDE12345)"* ]] && ok "CORAL_INSTALL_TEAM_ID names the team to pin" || fail "named team not shown: $output"

# --- Windows and odd systems ---------------------------------------------------------------------------
CORAL_INSTALL_OS=MINGW64_NT run bash "$script" --dry-run; [ "$rc" = 1 ] && [[ "$output" == *".msi"* ]] && ok "Windows is told to use the .msi" || fail "windows: $rc $output"
CORAL_INSTALL_OS=Linux CORAL_INSTALL_ARCH=riscv64 run bash "$script" --dry-run; [ "$rc" != 0 ] && ok "an unsupported CPU is refused" || fail "riscv64 accepted"

# --- Linux install (simulated) ---------------------------------------------------------------------------
lx() { CORAL_INSTALL_OS=Linux CORAL_INSTALL_ARCH="${ARCH_UNDER_TEST:-x86_64}" run bash "$script" "$@"; }
dest="$tmp/lx/bin"
lx --dir "$dest"
if [ "$rc" = 0 ] && [ -x "$dest/coral" ] && [ -x "$dest/coral-board" ] && [ "$("$dest/coral")" = coral-amd64 ] && [ ! -e "$dest/licenses" ] && [[ "$output" == *"not programs: licenses"* ]] && [[ "$output" == *"Checksum-verified only"* ]] && [ -z "$(ls -A "$HOME")" ]; then ok "Linux amd64: installs the programs, says it was checksum-verified only, touches nothing else"; else fail "linux install: $rc $output"; fi
ARCH_UNDER_TEST=aarch64 lx --dir "$tmp/lx2/bin"; [ "$rc" = 0 ] && [ "$("$tmp/lx2/bin/coral")" = coral-arm64 ] && ok "Linux arm64 gets the arm64 tarball" || fail "arm64: $rc $output"
lx --dir "$dest" --release 9.9.9; [ "$rc" = 0 ] && ok "--release 9.9.9 installs from that release's folder" || fail "release pin: $rc $output"
lx --dir "$dest" --release 1.0.0; [ "$rc" != 0 ] && ok "a release that does not exist fails" || fail "missing release passed"
[ -z "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'coral-install.*' -newer "$script" 2>/dev/null)" ] && ok "no temp folder is left behind" || fail "a coral-install temp folder is left"

# --- the checksum is the gate --------------------------------------------------------------------------
bad="$tmp/bad"; cp -R "$rel/latest/download" "$bad-dl"; mkdir -p "$bad/latest"; mv "$bad-dl" "$bad/latest/download"
printf 'tampered' >>"$bad/latest/download/coral-linux-amd64.tar.gz"
CORAL_INSTALL_BASE_URL="file://$bad" lx --dir "$tmp/bad-out"
if [ "$rc" != 0 ] && [[ "$output" == *"does not match SHA256SUMS.txt"* ]] && [ -z "$(ls -A "$tmp/bad-out")" ]; then ok "a tampered tarball is refused and nothing is installed"; else fail "tamper: $rc $output"; fi
grep -v 'coral-linux-amd64' "$bad/latest/download/SHA256SUMS.txt" >"$bad/sums" && mv "$bad/sums" "$bad/latest/download/SHA256SUMS.txt"
CORAL_INSTALL_BASE_URL="file://$bad" lx --dir "$tmp/bad-out2"; [ "$rc" != 0 ] && [[ "$output" == *"lists no single checksum"* ]] && ok "an asset missing from SHA256SUMS.txt is refused" || fail "missing sum: $rc $output"
printf 'XYZ  coral-linux-amd64.tar.gz\n' >"$bad/latest/download/SHA256SUMS.txt"
CORAL_INSTALL_BASE_URL="file://$bad" lx --dir "$tmp/bad-out3"; [ "$rc" != 0 ] && [[ "$output" == *"malformed"* ]] && ok "a malformed checksum is refused" || fail "malformed sum: $rc $output"

# --- a tarball that reaches out of the folder or holds a link is refused before it is unpacked ---------
mk_evil() { # mk_evil <name> <how>
    local d="$tmp/evil-$1"; mkdir -p "$d/latest/download" "$d/w"
    printf '#!/bin/sh\n' >"$d/w/coral"; chmod 755 "$d/w/coral"
    case "$2" in
        traverse) python3 - "$d/latest/download/coral-linux-amd64.tar.gz" "$d/w/coral" <<'PY'
import sys,tarfile
with tarfile.open(sys.argv[1],'w:gz') as t:
    t.add(sys.argv[2],arcname='coral'); t.add(sys.argv[2],arcname='../escaped')
PY
        ;;
        link) ln -s /etc/passwd "$d/w/passwd"; tar czf "$d/latest/download/coral-linux-amd64.tar.gz" -C "$d/w" . ;;
        extra) printf '#!/bin/sh\n' >"$d/w/ls"; chmod 755 "$d/w/ls"; tar czf "$d/latest/download/coral-linux-amd64.tar.gz" -C "$d/w" . ;;
        nocoral) rm "$d/w/coral"; printf x >"$d/w/other"; tar czf "$d/latest/download/coral-linux-amd64.tar.gz" -C "$d/w" . ;;
    esac
    printf '%s  coral-linux-amd64.tar.gz\n' "$(sha "$d/latest/download/coral-linux-amd64.tar.gz")" >"$d/latest/download/SHA256SUMS.txt"
    echo "$d"
}
for how in traverse link nocoral; do
    d="$(mk_evil "$how" "$how")"
    CORAL_INSTALL_BASE_URL="file://$d" lx --dir "$tmp/evil-out-$how"
    want_msg=""; [ "$how" != traverse ] || want_msg="unsafe path" # the installer's own refusal, not only tar's
    if [ "$rc" != 0 ] && [[ "$output" == *"$want_msg"* ]] && [ -z "$(ls -A "$tmp/evil-out-$how")" ] && [ ! -e "$tmp/evil-out-$how/../escaped" ] && [ ! -e "$tmp/escaped" ]; then ok "a $how tarball is refused and nothing is installed"; else fail "$how tarball: $rc $output"; fi
done

# --- a name that is not one of Coral's programs is left behind, never put in the folder (it could shadow a system command) ---
d="$tmp/extra"; mkdir -p "$d/latest/download" "$d/w/licenses"
printf '#!/bin/sh\n' >"$d/w/coral"; printf '#!/bin/sh\n' >"$d/w/ls"; echo l >"$d/w/licenses/LICENSE"; chmod 755 "$d/w/coral" "$d/w/ls"
tar czf "$d/latest/download/coral-linux-amd64.tar.gz" -C "$d/w" .
printf '%s  coral-linux-amd64.tar.gz\n' "$(sha "$d/latest/download/coral-linux-amd64.tar.gz")" >"$d/latest/download/SHA256SUMS.txt"
CORAL_INSTALL_BASE_URL="file://$d" lx --dir "$tmp/extra-out"
if [ "$rc" = 0 ] && [ -x "$tmp/extra-out/coral" ] && [ ! -e "$tmp/extra-out/ls" ] && [ ! -e "$tmp/extra-out/licenses" ] && [[ "$output" == *"not programs:"*"ls"* ]]; then ok "an extra program name is named and left out of the folder; coral is installed"; else fail "extra name: $rc $output"; fi

# --- a read-only folder in the package does not leave the temp folder behind --------------------------------------
d="$tmp/ro-pkg"; mkdir -p "$d/latest/download" "$d/w/licenses/sub"
printf '#!/bin/sh\n' >"$d/w/coral"; chmod 755 "$d/w/coral"; echo l >"$d/w/licenses/sub/LICENSE"; chmod 555 "$d/w/licenses/sub" "$d/w/licenses"
tar czf "$d/latest/download/coral-linux-amd64.tar.gz" -C "$d/w" .; chmod -R u+w "$d/w"
printf '%s  coral-linux-amd64.tar.gz\n' "$(sha "$d/latest/download/coral-linux-amd64.tar.gz")" >"$d/latest/download/SHA256SUMS.txt"
mkdir -p "$tmp/own-tmp"
TMPDIR="$tmp/own-tmp" CORAL_INSTALL_BASE_URL="file://$d" lx --dir "$tmp/ro-out"
if [ "$rc" = 0 ] && [ -x "$tmp/ro-out/coral" ] && [ -z "$(ls -A "$tmp/own-tmp")" ]; then ok "a read-only licenses/ folder does not leave the temp folder behind"; else fail "read-only package: $rc $(ls -A "$tmp/own-tmp") $output"; fi

# --- the real latest release (opt in: it is a network download; run it before a tag) -----------------------------
if [ "${INSTALL_SH_REAL:-}" = 1 ]; then
    CORAL_INSTALL_BASE_URL=https://github.com/subgentic/coral/releases lx --dir "$tmp/real-out"
    if [ "$rc" = 0 ] && [ -x "$tmp/real-out/coral" ] && [ ! -e "$tmp/real-out/licenses" ]; then ok "the real latest Linux tarball installs (checksum checked, licenses/ left out)"; else fail "real latest tarball: $rc $output"; fi
else
    echo "skip: the real latest release (set INSTALL_SH_REAL=1 to run it: it downloads the tarball)"
fi

# --- cosign: a good signature is reported, a bad one stops the install --------------------------------
stub="$tmp/stubbin"; mkdir -p "$stub"
printf '#!/bin/sh\nexit 0\n' >"$stub/cosign"; chmod 755 "$stub/cosign"
PATH="$stub:$PATH" lx --dir "$tmp/cs-ok"; [ "$rc" = 0 ] && [[ "$output" == *"signature ok"* ]] || fail "cosign ok: $rc $output"
printf '#!/bin/sh\nexit 1\n' >"$stub/cosign"
PATH="$stub:$PATH" lx --dir "$tmp/cs-bad"; [ "$rc" != 0 ] && [[ "$output" == *"did not verify"* ]] && [ -z "$(ls -A "$tmp/cs-bad")" ] && ok "cosign: a good signature is reported; a bad one stops the install" || fail "cosign bad: $rc $output"

# --- --require-signature: without cosign it stops; with a good cosign it goes on ----------------------------------
lx --dir "$tmp/rs-no" --require-signature
if [ "$rc" != 0 ] && [[ "$output" == *"--require-signature was given but cosign is not installed"* ]] && [ -z "$(ls -A "$tmp/rs-no")" ]; then ok "--require-signature without cosign stops and installs nothing"; else fail "require-signature no cosign: $rc $output"; fi
printf '#!/bin/sh\nexit 0\n' >"$stub/cosign"
PATH="$stub:$PATH" lx --dir "$tmp/rs-yes" --require-signature; [ "$rc" = 0 ] && [[ "$output" == *"signature ok"* ]] && ok "--require-signature with cosign installs" || fail "require-signature with cosign: $rc $output"
rm -f "$stub/cosign"

# --- never sudo: a folder that is not writable is said so -------------------------------------------------
ro="$tmp/ro"; mkdir -p "$ro"; chmod 555 "$ro"
if [ "$(id -u)" != 0 ]; then
    lx --dir "$ro"; [ "$rc" != 0 ] && [[ "$output" == *"never uses sudo"* ]] && ok "a folder that is not writable is refused with a way out, no sudo" || fail "read-only: $rc $output"
fi
if grep -vE '^[[:space:]]*#' "$script" | grep -E '(^|[;&|(]|^[[:space:]])[[:space:]]*sudo[[:space:]]' >/dev/null; then fail "install.sh runs sudo"; else ok "install.sh never runs sudo"; fi

# --- macOS: Coral.app from the DMG, in a temp folder ---------------------------------------------------------
if [ "$(uname -s)" = Darwin ]; then
    apps="$tmp/Apps"; run bash "$script" --dir "$apps"
    if [ "$rc" = 0 ] && [ -x "$apps/Coral.app/Contents/MacOS/coral" ] && [ -L "$HOME/.local/bin/coral" ] && [ ! -e "$HOME/Applications" ]; then ok "macOS: Coral.app installed in the folder given, CLI linked in the temp HOME, ~/Applications untouched"; else fail "macos install: $rc $output"; fi
    printf stale >"$apps/Coral.app/old-file"
    run bash "$script" --dir "$apps" --no-cli; [ "$rc" = 0 ] && [ ! -e "$apps/Coral.app/old-file" ] && ok "macOS: a second run replaces the app" || fail "macos reinstall: $rc $output"
    # The app's code signature: unsigned says so and installs; signed names the team; an invalid one stops (a stub codesign stands in).
    run bash "$script" --dir "$tmp/Apps-unsigned" --no-cli; [ "$rc" = 0 ] && [[ "$output" == *"not code-signed"* ]] && ok "macOS: an unsigned app is said so in one line and installs" || fail "unsigned: $rc $output"
    printf '#!/bin/sh\ncase "$1" in --verify) exit 0 ;; -dvv) echo "TeamIdentifier=ABCDE12345" >&2 ;; esac\n' >"$stub/codesign"; chmod 755 "$stub/codesign"
    PATH="$stub:$PATH" run bash "$script" --dir "$tmp/Apps-signed" --no-cli; [ "$rc" = 0 ] && [[ "$output" == *"signing team ABCDE12345"* ]] && ok "macOS: a signed app prints its signing team" || fail "signed: $rc $output"
    printf '#!/bin/sh\necho "a sealed resource is missing or invalid" >&2; exit 1\n' >"$stub/codesign"
    PATH="$stub:$PATH" run bash "$script" --dir "$tmp/Apps-bad" --no-cli; [ "$rc" != 0 ] && [[ "$output" == *"code signature of Coral.app is not valid"* ]] && [ ! -e "$tmp/Apps-bad/Coral.app" ] && ok "macOS: an invalid signature stops the install" || fail "invalid sig: $rc $output"
    rm -f "$stub/codesign"
    # The pin (#12508): with Coral's team named, a different team, an empty one and no signature stop the install; the right one goes on.
    printf '#!/bin/sh\ncase "$1" in --verify) exit 0 ;; -dvv) echo "TeamIdentifier=ABCDE12345" >&2 ;; esac\n' >"$stub/codesign"; chmod 755 "$stub/codesign"
    CORAL_INSTALL_TEAM_ID=ABCDE12345 PATH="$stub:$PATH" run bash "$script" --dir "$tmp/Apps-pin-ok" --no-cli; [ "$rc" = 0 ] && [[ "$output" == *"Coral's)"* ]] && ok "macOS pin: Coral's team goes on" || fail "pin ok: $rc $output"
    CORAL_INSTALL_TEAM_ID=ZZZZZ99999 PATH="$stub:$PATH" run bash "$script" --dir "$tmp/Apps-pin-other" --no-cli; [ "$rc" != 0 ] && [[ "$output" == *"not Coral's (ZZZZZ99999)"* ]] && [ ! -e "$tmp/Apps-pin-other/Coral.app" ] && ok "macOS pin: a different team stops the install" || fail "pin other: $rc $output"
    printf '#!/bin/sh\ncase "$1" in --verify) exit 0 ;; esac\n' >"$stub/codesign"; chmod 755 "$stub/codesign" # valid, but no team printed
    CORAL_INSTALL_TEAM_ID=ABCDE12345 PATH="$stub:$PATH" run bash "$script" --dir "$tmp/Apps-pin-empty" --no-cli; [ "$rc" != 0 ] && [[ "$output" == *"signed by team 'none'"* ]] && ok "macOS pin: an empty team stops the install" || fail "pin empty: $rc $output"
    rm -f "$stub/codesign"
    CORAL_INSTALL_TEAM_ID=ABCDE12345 run bash "$script" --dir "$tmp/Apps-pin-unsigned" --no-cli; [ "$rc" != 0 ] && [[ "$output" == *"not code-signed, but Coral's releases are"* ]] && [ ! -e "$tmp/Apps-pin-unsigned/Coral.app" ] && ok "macOS pin: an unsigned app stops the install" || fail "pin unsigned: $rc $output"
    [ -z "$(hdiutil info | grep "$tmp" || true)" ] && ok "macOS: the disk image is detached" || fail "the DMG is still mounted"

    # Real signatures (#12508, Security's SHOULD): the printed team is only text a certificate can carry, so a pinned install checks the signing requirement. An ad-hoc signed app, and one signed with a
    # certificate made here whose subject OU is Coral's team id, both print what a release would and both must be refused. (A temp keychain, named on the codesign line only: the search list is not changed.)
    team=33UR27T84L; fx="$tmp/fx"; mkdir -p "$fx"
    kc="$fx/fake.keychain-db"; before_list="$(security list-keychains -d user)"
    mk_signed_release() { # mk_signed_release <name> <codesign identity args...>: a release folder whose Coral.app is signed as given
        local n="$1"; shift
        local app="$fx/$n/Coral.app"; mkdir -p "$app/Contents/MacOS" "$fx/$n-rel/latest/download"
        printf '#!/bin/sh\necho app\n' >"$app/Contents/MacOS/coral"; chmod 755 "$app/Contents/MacOS/coral"
        printf '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>coral</string><key>CFBundleIdentifier</key><string>test.fake.%s</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>' "$n" >"$app/Contents/Info.plist"
        codesign --force --deep "$@" "$app" >/dev/null 2>&1 || return 1
        hdiutil create -quiet -srcfolder "$fx/$n" -volname Coral -format UDZO "$fx/$n-rel/latest/download/Coral.dmg" || return 1
        sums "$fx/$n-rel/latest/download"
    }
    ident_ok=0
    if openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Fake Coral Dev/OU=$team/O=Test" -keyout "$fx/k.pem" -out "$fx/c.pem" \
            -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1 \
        && openssl pkcs12 -export -inkey "$fx/k.pem" -in "$fx/c.pem" -out "$fx/c.p12" -passout pass:pw >/dev/null 2>&1 \
        && security create-keychain -p pw "$kc" >/dev/null 2>&1 && security unlock-keychain -p pw "$kc" \
        && security import "$fx/c.p12" -k "$kc" -P pw -T /usr/bin/codesign >/dev/null 2>&1 \
        && security set-key-partition-list -S apple-tool:,apple: -s -k pw "$kc" >/dev/null 2>&1; then ident_ok=1; fi
    if mk_signed_release adhoc -s - && CORAL_INSTALL_BASE_URL="file://$fx/adhoc-rel" CORAL_INSTALL_TEAM_ID=$team run bash "$script" --dir "$tmp/Apps-adhoc" --no-cli; then
        [ "$rc" != 0 ] && [ ! -e "$tmp/Apps-adhoc/Coral.app" ] && ok "macOS pin, real signature: an ad-hoc signed app is refused" || fail "ad-hoc app installed: $rc $output"
    else fail "could not make the ad-hoc signed fixture"; fi
    if [ "$ident_ok" = 1 ] && mk_signed_release forged -s "Fake Coral Dev" --keychain "$kc"; then
        CORAL_INSTALL_BASE_URL="file://$fx/forged-rel" CORAL_INSTALL_TEAM_ID=$team run bash "$script" --dir "$tmp/Apps-forged" --no-cli
        if [ "$rc" != 0 ] && [ ! -e "$tmp/Apps-forged/Coral.app" ]; then ok "macOS pin, real signature: a self-made certificate carrying Coral's team id as its OU is refused"; else fail "forged-OU app: rc $rc $output"; fi
    else echo "skip: could not make a certificate and keychain here for the forged-OU case"; fi
    security delete-keychain "$kc" >/dev/null 2>&1 || true
    [ "$(security list-keychains -d user)" = "$before_list" ] && ok "the keychain search list is unchanged" || fail "the keychain search list changed"
else
    echo "skip: the macOS install runs on a Mac only"
fi

if [ "$fails" -ne 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "PASS install.sh"
