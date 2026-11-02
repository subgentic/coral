#!/usr/bin/env bash
# Coral installer for macOS and Linux (#11935).
#
#   curl -fsSL https://raw.githubusercontent.com/subgentic/coral/main/install.sh | bash
#
# Read it first: it is this file. To pass options through the pipe:  ... | bash -s -- --dry-run
#
# What it does: finds the latest Coral release on github.com/subgentic/coral, downloads the package for
# this computer over https, checks it against the release's SHA256SUMS.txt (and checks the signature on
# that file when `cosign` is installed), and installs it where you can write, with no sudo:
#   macOS  Coral.app (the universal DMG) in ~/Applications, and the command-line tools linked into ~/.local/bin
#   Linux  the programs from the tarball for your CPU (amd64 or arm64) in ~/.local/bin
# Nothing else is downloaded and nothing downloaded is piped into a shell. Windows: use the .msi instead.
#
# Options:
#   --dry-run          say what would be downloaded and installed, and change nothing
#   --release <x.y.z>  install that release instead of the latest (for example 2.0.36)
#   --dir <path>       install into <path> (macOS: the folder for Coral.app; Linux: the folder for the programs)
#   --no-cli           macOS: do not link the command-line tools into ~/.local/bin
#   --version          print this installer's version
#   -h, --help         this text
#
# It never uses sudo. If the folder is not yours to write, it says so: choose another with --dir, or run it
# as the user who should own the install.
#
# For testing, CORAL_INSTALL_BASE_URL replaces https://github.com/subgentic/coral/releases (https:// or file://).

set -euo pipefail

INSTALLER_VERSION="1"
REPO="subgentic/coral"
BASE_URL="${CORAL_INSTALL_BASE_URL:-https://github.com/${REPO}/releases}"
MSI_URL="https://github.com/${REPO}/releases/latest/download/Coral-x64.msi"

say() { printf '%s\n' "$*"; }
note() { printf '==> %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'USAGE'
Coral installer for macOS and Linux.

  curl -fsSL https://raw.githubusercontent.com/subgentic/coral/main/install.sh | bash
  ... | bash -s -- --dry-run        (options go after --)

Downloads the latest Coral release for this computer over https, checks it against the release's
SHA256SUMS.txt (and the signature on that file when cosign is installed), and installs it where you can
write, with no sudo: Coral.app in ~/Applications on macOS (and the command-line tools linked into
~/.local/bin), the programs in ~/.local/bin on Linux. Windows: use the .msi.

Options:
  --dry-run          say what would be downloaded and installed, and change nothing
  --release <x.y.z>  install that release instead of the latest (for example 2.0.36)
  --dir <path>       install into <path> (macOS: the folder for Coral.app; Linux: the folder for the programs)
  --no-cli           macOS: do not link the command-line tools into ~/.local/bin
  --version          print this installer's version
  -h, --help         this text
USAGE
}

WORK=""
MOUNT=""
cleanup() {
    if [ -n "$MOUNT" ]; then hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || hdiutil detach -force -quiet "$MOUNT" >/dev/null 2>&1 || true; fi
    if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
}

have() { command -v "$1" >/dev/null 2>&1; }

sha256_of() {
    if have sha256sum; then sha256sum "$1" | awk '{print $1}'
    elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
    else die "neither sha256sum nor shasum is installed, so the download cannot be checked."; fi
}

# fetch <url> <file>: https only (file:// for tests), redirects stay on https.
fetch() {
    local url="$1" out="$2"
    case "$url" in
        https://*) curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 --output "$out" "$url" ;;
        file://*)  curl --fail --silent --show-error --proto '=file' --output "$out" "$url" ;;
        *) die "refusing to download from $url: only https is used." ;;
    esac || die "could not download $url"
}

main() {
    local dry=0 release="" dir="" cli=1
    while [ $# -gt 0 ]; do
        case "$1" in
            --dry-run) dry=1; shift ;;
            --release) [ $# -ge 2 ] && [ -n "$2" ] || die "--release needs a version, for example --release 2.0.36"; release="$2"; shift 2 ;;
            --dir) [ $# -ge 2 ] && [ -n "$2" ] || die "--dir needs a folder"; dir="$2"; shift 2 ;;
            --no-cli) cli=0; shift ;;
            --version) say "Coral installer $INSTALLER_VERSION"; return 0 ;;
            -h|--help) usage; return 0 ;;
            *) printf 'Unknown option: %s (try --help)\n' "$1" >&2; return 2 ;;
        esac
    done

    case "$BASE_URL" in https://*|file://*) ;; *) die "CORAL_INSTALL_BASE_URL must start with https:// (or file:// for a test)." ;; esac
    if [ -n "$release" ]; then
        release="${release#v}"
        case "$release" in *[!0-9A-Za-z._-]*|"") die "that is not a release version: $release" ;; esac
        RELEASE_BASE="$BASE_URL/download/v$release"
    else
        RELEASE_BASE="$BASE_URL/latest/download"
    fi

    local os arch
    os="${CORAL_INSTALL_OS:-$(uname -s)}"
    arch="${CORAL_INSTALL_ARCH:-$(uname -m)}"
    case "$os" in
        Darwin) os=macos ;;
        Linux) os=linux ;;
        MINGW*|MSYS*|CYGWIN*|Windows*) say "This installer is for macOS and Linux. On Windows, download and run the installer: $MSI_URL"; return 1 ;;
        *) die "unsupported system: $os. Coral has packages for macOS, Linux and Windows." ;;
    esac
    case "$arch" in
        x86_64|amd64) arch=amd64 ;;
        arm64|aarch64) arch=arm64 ;;
        *) [ "$os" = macos ] || die "unsupported CPU: $arch. Coral for Linux is built for amd64 and arm64." ;;
    esac

    local asset target
    if [ "$os" = macos ]; then
        asset="Coral.dmg"; target="${dir:-$HOME/Applications}"
    else
        asset="coral-linux-$arch.tar.gz"; target="${dir:-$HOME/.local/bin}"
    fi

    local which="the latest release"; [ -z "$release" ] || which="release $release"
    note "Coral for $os${arch:+ ($arch)}: $asset, $which"
    say "    from $RELEASE_BASE/$asset"
    say "    checked against $RELEASE_BASE/SHA256SUMS.txt"
    if [ "$os" = macos ]; then say "    installs Coral.app in $target"; else say "    installs the programs in $target"; fi
    if [ "$dry" = 1 ]; then
        say "Dry run: nothing was downloaded or changed."
        return 0
    fi

    have curl || die "curl is not installed."
    if [ "$os" = linux ]; then have tar || die "tar is not installed."; else have hdiutil || die "hdiutil is not available: this does not look like macOS."; fi
    mkdir -p "$target" 2>/dev/null || die "cannot create $target. Choose a folder you own with --dir."
    [ -w "$target" ] || die "$target is not writable by $(id -un). Choose a folder you own with --dir; this installer never uses sudo."

    WORK="$(mktemp -d "${TMPDIR:-/tmp}/coral-install.XXXXXX")"
    trap cleanup EXIT
    trap 'exit 130' INT TERM

    note "Downloading"
    fetch "$RELEASE_BASE/SHA256SUMS.txt" "$WORK/SHA256SUMS.txt"
    fetch "$RELEASE_BASE/$asset" "$WORK/$asset"

    note "Checking the download"
    local want got
    want="$(awk -v n="$asset" '$2 == n { print $1 }' "$WORK/SHA256SUMS.txt" | sort -u)"
    [ -n "$want" ] && [ "$(printf '%s\n' "$want" | wc -l | tr -d ' ')" = 1 ] || die "SHA256SUMS.txt lists no single checksum for $asset: not installing."
    case "$want" in *[!0-9a-f]*) die "SHA256SUMS.txt holds a malformed checksum for $asset: not installing." ;; esac
    [ "${#want}" = 64 ] || die "SHA256SUMS.txt holds a malformed checksum for $asset: not installing."
    got="$(sha256_of "$WORK/$asset")"
    [ "$got" = "$want" ] || die "the checksum of $asset does not match SHA256SUMS.txt (got $got, want $want). It may be damaged or not an official build: not installing."
    say "    checksum ok ($asset)"
    verify_signature

    if [ "$os" = macos ]; then install_macos "$target" "$cli"; else install_linux "$target" "$arch"; fi
}

# The signature on SHA256SUMS.txt, when cosign can check it (the README's "Verify your download" command).
verify_signature() {
    if ! have cosign; then
        say "    Checksum-verified only: cosign is not installed, so the signature on SHA256SUMS.txt was not checked."
        say "    (The checksum guards against a damaged download. To prove the release came from Coral's release workflow, install cosign and run this again.)"
        return 0
    fi
    fetch "$RELEASE_BASE/SHA256SUMS.txt.sigstore.json" "$WORK/SHA256SUMS.txt.sigstore.json"
    local id='^https://github\.com/subgentic/coral/\.github/workflows/release\.yml@refs/tags/v'
    local iss='https://token.actions.githubusercontent.com'
    if cosign verify-blob "$WORK/SHA256SUMS.txt" --bundle "$WORK/SHA256SUMS.txt.sigstore.json" --new-bundle-format \
            --certificate-oidc-issuer "$iss" --certificate-identity-regexp "$id" >/dev/null 2>&1 \
        || cosign verify-blob "$WORK/SHA256SUMS.txt" --bundle "$WORK/SHA256SUMS.txt.sigstore.json" \
            --certificate-oidc-issuer "$iss" --certificate-identity-regexp "$id" >/dev/null 2>&1; then
        say "    signature ok (SHA256SUMS.txt was signed by Coral's release workflow)"
    else
        die "the signature on SHA256SUMS.txt did not verify: this is not an official build. Not installing."
    fi
}

install_linux() {
    local target="$1" arch="$2" listing name kind line
    mkdir -p "$WORK/unpack"
    # A name that leaves the folder, an absolute name, a link or a device is refused before anything is unpacked.
    listing="$(tar -tvzf "$WORK/coral-linux-$arch.tar.gz" 2>/dev/null)" || die "the tarball cannot be read."
    while IFS= read -r line; do
        kind="${line:0:1}"
        case "$kind" in -|d) ;; *) die "the tarball holds an entry that is not a plain file or folder: not installing." ;; esac
    done <<<"$listing"
    while IFS= read -r name; do
        case "$name" in /*|..|../*|*/..|*/../*) die "the tarball holds an unsafe path ($name): not installing." ;; esac
    done < <(tar -tzf "$WORK/coral-linux-$arch.tar.gz")
    tar -xzf "$WORK/coral-linux-$arch.tar.gz" -C "$WORK/unpack" || die "the tarball could not be unpacked."
    [ -x "$WORK/unpack/coral" ] || die "the tarball holds no 'coral' program: not installing."
    if [ -n "$(find "$WORK/unpack" -mindepth 1 -type d -print -quit)" ]; then die "the tarball holds folders, which this installer does not expect: not installing."; fi
    note "Installing in $target"
    local f base
    for f in "$WORK"/unpack/*; do
        base="$(basename "$f")"
        if ! { cp "$f" "$target/.$base.new.$$" && chmod 0755 "$target/.$base.new.$$" && mv -f "$target/.$base.new.$$" "$target/$base"; }; then
            rm -f "$target/.$base.new.$$"; die "could not write $target/$base."
        fi
        say "    $target/$base"
    done
    finish_linux "$target"
}

finish_linux() {
    local target="$1"
    case ":$PATH:" in
        *":$target:"*) ;;
        *) say ""; say "$target is not on your PATH. Add it for this and later terminals:"; say "    export PATH=\"$target:\$PATH\"" ;;
    esac
    say ""
    say "Coral is installed. Start it with:  $target/coral"
    say "Install and sign in to an agent CLI (Claude Code, Codex, Antigravity or Pi) first: Coral runs them, it does not install them."
}

install_macos() {
    local target="$1" cli="$2" mount app dest
    mount="$WORK/mount"; mkdir -p "$mount"
    hdiutil attach -nobrowse -readonly -noverify -noautoopen -mountpoint "$mount" "$WORK/Coral.dmg" >/dev/null || die "the disk image could not be opened."
    MOUNT="$mount"
    app="$mount/Coral.app"
    [ -d "$app" ] || die "the disk image holds no Coral.app: not installing."
    dest="$target/Coral.app"
    if pgrep -f "$dest/Contents/MacOS" >/dev/null 2>&1; then warn "Coral is running from $dest: quit it after this, then open it again to use the new version."; fi
    note "Installing in $target"
    rm -rf "$target/.Coral.app.new.$$"
    ditto "$app" "$target/.Coral.app.new.$$" || { rm -rf "$target/.Coral.app.new.$$"; die "could not copy Coral.app to $target."; }
    rm -rf "$target/.Coral.app.old.$$"
    if [ -e "$dest" ]; then mv "$dest" "$target/.Coral.app.old.$$" || { rm -rf "$target/.Coral.app.new.$$"; die "could not replace the Coral.app in $target."; }; fi
    mv "$target/.Coral.app.new.$$" "$dest" || { [ ! -e "$target/.Coral.app.old.$$" ] || mv "$target/.Coral.app.old.$$" "$dest"; die "could not put Coral.app in place."; }
    rm -rf "$target/.Coral.app.old.$$"
    say "    $dest"
    if [ "$cli" = 1 ] && [ -x "$dest/Contents/MacOS/install-cli.sh" ]; then
        note "Linking the command-line tools into ~/.local/bin"
        "$dest/Contents/MacOS/install-cli.sh" || warn "the command-line tools were not linked: run $dest/Contents/MacOS/install-cli.sh yourself."
    fi
    say ""
    say "Coral is installed. Open it from $target, or:  open \"$dest\""
    say "Install and sign in to an agent CLI (Claude Code, Codex, Antigravity or Pi) first: Coral runs them, it does not install them."
}

# main is called last, so a download that stops half way never runs half a script.
main "$@"
