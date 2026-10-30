package main

import (
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/safefs"
	"github.com/subgentic/coral/internal/secfile"
	"github.com/subgentic/coral/internal/updater/status"
	"github.com/subgentic/coral/internal/updater/trigger"
)

// applyProbe says what install an APPLY run is judged by. It is installProbe, except on Windows (install_apply_windows.go), where the dashboard starts the apply from a COPY
// of coral-update.exe in <data>/updates/apply: the copy's own folder is never the registered install, so judging it by its folder (#6436's portable-copy guard) refused every
// dashboard install as "portable_install", silently, since v2.0.0.
var applyProbe = func(dataDir string) *status.Install { return installProbe() }

// copyOfTheRegisteredUpdater says whether the program at exe is a dashboard copy of the REGISTERED install's coral-update.exe, made for the click whose marker is in dataDir. All of:
//   - exe is a file named coral-update-*.exe directly in <data>/updates/apply (compared by final path, so a link cannot stand in for the folder);
//   - the click's marker is good (present, not damaged, not expired) and its install_dir is the registered install's folder: an EQUALITY of final paths, never a substitute for it;
//   - the copy's bytes are the registered coral-update.exe's, byte for byte (SHA-256, both read through a no-follow open).
//
// It relaxes ONE thing, the portable-copy guard: RunMSI still takes its install folder from Windows Installer (m.Install()), never from the marker, and everything after the
// gate (the marker's nonce and version, the verification of the staged package, the consent) is unchanged. A portable updater run by hand has no such marker or no such bytes.
func copyOfTheRegisteredUpdater(registered string, dataDir, exe string, now time.Time) bool {
	if registered == "" || dataDir == "" || exe == "" {
		return false
	}
	realExe, err := safefs.Resolve(exe)
	if err != nil {
		return false
	}
	applyDir, err := safefs.Resolve(filepath.Join(dataDir, "updates", "apply"))
	if err != nil {
		return false
	}
	if ok, _ := filepath.Match("coral-update-*.exe", strings.ToLower(filepath.Base(realExe))); !ok || !sameFolder(filepath.Dir(realExe), applyDir) {
		return false
	}
	m, err := trigger.Peek(dataDir, now)
	if err != nil || m.InstallDir == "" {
		return false
	}
	markerDir, err := safefs.Resolve(m.InstallDir)
	if err != nil {
		return false
	}
	regDir, err := safefs.Resolve(registered)
	if err != nil || !sameFolder(markerDir, regDir) {
		return false
	}
	want, err := fileSHA256(filepath.Join(regDir, "coral-update.exe"))
	if err != nil {
		return false
	}
	got, err := fileSHA256(realExe)
	return err == nil && got == want
}

// fileSHA256 is the hex SHA-256 of the plain file at path, opened without following a link.
func fileSHA256(path string) (string, error) {
	f, err := secfile.OpenNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !fi.Mode().IsRegular() {
		return "", errors.New("not a plain file")
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hexOf(h.Sum(nil)), nil
}

func hexOf(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, digits[c>>4], digits[c&15])
	}
	return string(out)
}
