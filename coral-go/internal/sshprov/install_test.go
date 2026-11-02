package sshprov

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type member struct {
	name, body, link string
	typ              byte
}

func makeTarGz(t *testing.T, members []member) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, m := range members {
		typ := m.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		h := &tar.Header{Name: m.name, Typeflag: typ, Mode: 0o755, Size: int64(len(m.body)), Linkname: m.link}
		if typ != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if typ == tar.TypeReg {
			tw.Write([]byte(m.body))
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func goodTar(t *testing.T) []byte {
	return makeTarGz(t, []member{{name: "coral", body: "#!/bin/sh\necho coral\n"}, {name: "bin/", typ: tar.TypeDir}, {name: "bin/coral-board", body: "x"}, {name: "alias", typ: tar.TypeSymlink, link: "coral"}})
}

func sha(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// farSide is the stand-in ssh as the far computer: the remote command is answered in Go in a temp HOME on this machine (farside_test.go). mode "corrupt" cuts the package short on its way; "full" says
// the disk has no room.
func farSide(t *testing.T, mode string) (ssh, home, log string) {
	t.Helper()
	dir := t.TempDir()
	home = filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	log = filepath.Join(dir, "ssh.log")
	ssh = newStandIn(t, "ssh", standCfg{Far: &farCfg{Home: home, Log: log, Mode: mode}})
	return ssh, home, log
}

type installEnv struct {
	in    Installer
	pkg   []byte
	steps []string
	mu    sync.Mutex
	dls   int
	helps int
}

func newInstallEnv(t *testing.T, pkg []byte, mode string) (*installEnv, string, string) {
	ssh, home, log := farSide(t, mode)
	e := &installEnv{pkg: pkg}
	if err := os.WriteFile(filepath.Join(filepath.Dir(home), "pkg.bin"), pkg, 0o600); err != nil { // what the far computer's "download" gets
		t.Fatal(err)
	}
	e.in = Installer{
		Runner:  Runner{SSH: ssh},
		Version: "2.0.10",
		TempDir: t.TempDir(),
		Download: func(_ context.Context, url, dst string, max int64) error {
			e.mu.Lock()
			e.dls++
			e.mu.Unlock()
			if !strings.HasPrefix(url, "https://github.com/subgentic/coral/releases/download/v2.0.10/") {
				t.Errorf("download url %s", url)
			}
			if strings.HasSuffix(url, ".tar.gz") {
				t.Errorf("the hub downloaded the package: %s (the far computer does that, #12217)", url)
			}
			return os.WriteFile(dst, []byte("x"), 0o600)
		},
		RunHelper: func(_ context.Context, tag, asset, dir string) (string, error) {
			e.mu.Lock()
			e.helps++
			e.mu.Unlock()
			if tag != "v2.0.10" || asset != "coral-linux-amd64-2.0.10.tar.gz" {
				t.Errorf("helper asked for %s %s", tag, asset)
			}
			if st, err := os.Stat(dir); err != nil || permsApply() && st.Mode().Perm() != 0o700 {
				t.Errorf("the download folder is not 0700: %v %v", st, err)
			}
			if _, err := os.Stat(filepath.Join(dir, asset)); err == nil {
				t.Errorf("the verifier was given a package: only the signed sums and their bundle belong in the folder")
			}
			return sha(e.pkg), nil
		},
		Progress: func(step, state, detail string) { e.steps = append(e.steps, state+": "+detail) },
	}
	return e, home, log
}

func TestInstallPutsTheVerifiedPackageOnTheFarSideAndIsIdempotent(t *testing.T) {
	pkg := goodTar(t)
	e, home, log := newInstallEnv(t, pkg, "")
	tg, _ := ParseTarget("user@box.example.com")
	got, err := e.in.Install(context.Background(), tg, ArchAMD64)
	if err != nil {
		t.Fatalf("Install: %v (%v)", err, e.steps)
	}
	if got != sha(pkg) {
		t.Errorf("sha = %s", got)
	}
	root := filepath.Join(home, ".coral-server", "2.0.10")
	if b, err := os.ReadFile(filepath.Join(root, "root", "coral")); err != nil || !strings.Contains(string(b), "echo coral") {
		t.Errorf("coral was not unpacked: %v %q", err, b)
	}
	if st, err := os.Stat(filepath.Join(root, "root", "coral")); err != nil || permsApply() && (st.Mode().Perm()&0o700 != 0o700 || st.Mode().Perm()&0o077 != 0) {
		t.Errorf("mode of coral: %v %v", st, err)
	}
	for _, d := range []string{filepath.Join(home, ".coral-server"), root} {
		if st, err := os.Stat(d); err != nil || permsApply() && st.Mode().Perm() != 0o700 {
			t.Errorf("%s is not 0700: %v %v", d, st, err)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(root, "package.sha256")); strings.TrimSpace(string(b)) != sha(pkg) {
		t.Errorf("recorded sum = %q", b)
	}
	if e.dls != 2 || e.helps != 1 {
		t.Errorf("downloads %d, helper runs %d", e.dls, e.helps)
	}

	// the far computer downloaded the package for its own platform, pinned to the verified SHA-256, and nothing was copied from the hub
	if l, _ := os.ReadFile(log); !strings.Contains(string(l), "coral-linux-amd64-2.0.10.tar.gz") || !strings.Contains(string(l), "= '"+sha(pkg)+"'") || strings.Contains(string(l), "cat >") {
		t.Errorf("the far side was not told to download and check the package:\n%s", l)
	}
	// a re-run downloads and verifies the sums again (cheap) but does not download the package again or unpack
	before, _ := os.ReadFile(log)
	e.steps = nil
	if _, err := e.in.Install(context.Background(), tg, ArchAMD64); err != nil {
		t.Fatalf("re-run: %v", err)
	}
	after, _ := os.ReadFile(log)
	added := strings.TrimPrefix(string(after), string(before))
	if strings.Contains(added, "curl ") || strings.Contains(added, "tar -xzf") {
		t.Errorf("a re-run downloaded or unpacked again:\n%s", added)
	}
	if !strings.Contains(strings.Join(e.steps, "|"), "Already installed") {
		t.Errorf("steps: %v", e.steps)
	}
	// nothing the far computer printed or the network said is in a sentence
	for _, s := range e.steps {
		if strings.Contains(s, home) || strings.Contains(s, "sh -c") {
			t.Errorf("a step says too much: %s", s)
		}
	}
}

func TestInstallRefusesBeforeTouchingTheFarSide(t *testing.T) {
	tg, _ := ParseTarget("user@box.example.com")
	pkg := goodTar(t)

	e, _, log := newInstallEnv(t, pkg, "")
	e.in.Version = "2.0.10+dev"
	if _, err := e.in.Install(context.Background(), tg, ArchAMD64); err == nil || !strings.Contains(err.Error(), "development build") {
		t.Errorf("a version that is not a release: %v", err)
	}
	e.in.Version = ""
	if _, err := e.in.Install(context.Background(), tg, ArchAMD64); err == nil {
		t.Error("no version")
	}
	if _, err := (e.in).Install(context.Background(), tg, Arch("386")); err == nil {
		t.Error("an architecture that is not supported")
	}

	e, _, log = newInstallEnv(t, pkg, "")
	e.in.RunHelper = func(context.Context, string, string, string) (string, error) { return "", errors.New("signature") }
	if _, err := e.in.Install(context.Background(), tg, ArchAMD64); err == nil || !strings.Contains(err.Error(), "could not be verified") {
		t.Errorf("a verifier that refuses: %v", err)
	}
	if _, err := os.Stat(log); err == nil {
		t.Error("ssh was started for a release that did not verify")
	}

	e, _, log = newInstallEnv(t, pkg, "")
	e.in.RunHelper = func(context.Context, string, string, string) (string, error) { return "not-a-hash", nil }
	if _, err := e.in.Install(context.Background(), tg, ArchAMD64); err == nil {
		t.Error("a helper that answered something that is not a SHA-256")
	}
	if _, err := os.Stat(log); err == nil {
		t.Error("ssh was started")
	}

	e, _, log = newInstallEnv(t, pkg, "")
	e.in.Download = func(context.Context, string, string, int64) error {
		return errors.New("HTTP 404 from https://secret.example")
	}
	_, err := e.in.Install(context.Background(), tg, ArchAMD64)
	if err == nil || strings.Contains(err.Error(), "secret.example") || strings.Contains(err.Error(), "404") {
		t.Errorf("a download failure must be a fixed sentence: %v", err)
	}

	e, _, _ = newInstallEnv(t, pkg, "")
	e.in.Helper = ""
	e.in.RunHelper = nil
	if _, err := e.in.Install(context.Background(), tg, ArchAMD64); err == nil || !strings.Contains(err.Error(), "could not be verified") {
		t.Errorf("no verifier at all must refuse: %v", err)
	}
	e.in.Helper = "relative/coral-update"
	if _, err := e.in.Install(context.Background(), tg, ArchAMD64); err == nil {
		t.Error("a relative verifier path")
	}
	_ = log
}

// The package is pinned to the signed SHA-256, so the hub no longer reads it (#12217); the far computer still lists its members and the hub refuses names that are not plain relative paths before anything is unpacked.
func TestInstallRefusesAPackageWithBadPathsFromTheListing(t *testing.T) {
	tg, _ := ParseTarget("user@box.example.com")
	for name, members := range map[string][]member{
		"dotdot":         {{name: "../evil", body: "x"}},
		"nested dotdot":  {{name: "a/../../evil", body: "x"}},
		"absolute":       {{name: "/etc/evil", body: "x"}},
		"backslash name": {{name: "a\\b", body: "x"}},
		"empty":          {},
	} {
		pkg := makeTarGz(t, members)
		e, home, _ := newInstallEnv(t, pkg, "")
		_, err := e.in.Install(context.Background(), tg, ArchAMD64)
		if err == nil || !strings.Contains(err.Error(), "paths that are not allowed") {
			t.Errorf("%s: %v", name, err)
		}
		if _, serr := os.Stat(filepath.Join(home, ".coral-server", "2.0.10", "root")); serr == nil {
			t.Errorf("%s: unpacked", name)
		}
	}
}

// The far computer's own failures to download are named in fixed sentences, and nothing is unpacked.
func TestInstallSaysWhyTheFarComputerCouldNotDownload(t *testing.T) {
	tg, _ := ParseTarget("user@box.example.com")
	for mode, want := range map[string]string{
		"nocurl": "has no curl",
		"dlfail": "could not download the release from GitHub",
	} {
		e, home, _ := newInstallEnv(t, goodTar(t), mode)
		_, err := e.in.Install(context.Background(), tg, ArchAMD64)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v", mode, err)
		}
		if _, serr := os.Stat(filepath.Join(home, ".coral-server", "2.0.10", "root")); serr == nil {
			t.Errorf("%s: unpacked", mode)
		}
	}
}

func TestInstallRefusesAPackageThatChangedOnTheWayAndUnpacksNothing(t *testing.T) {
	pkg := goodTar(t)
	e, home, _ := newInstallEnv(t, pkg, "corrupt")
	tg, _ := ParseTarget("user@box.example.com")
	_, err := e.in.Install(context.Background(), tg, ArchAMD64)
	if err == nil || !strings.Contains(err.Error(), "is not the one that was verified") {
		t.Fatalf("err = %v", err)
	}
	if _, serr := os.Stat(filepath.Join(home, ".coral-server", "2.0.10", "package.tar.gz")); serr == nil {
		t.Error("a package with the wrong hash was kept")
	}
	if _, serr := os.Stat(filepath.Join(home, ".coral-server", "2.0.10", "root")); serr == nil {
		t.Error("a package that failed the far-side hash was unpacked")
	}
}

func TestMemberNamesAreChecked(t *testing.T) {
	if err := checkMemberNames([]string{"coral", "bin/", "bin/x", "./coral", "a/b.c/d"}); err != nil {
		t.Errorf("good names: %v", err)
	}
	for _, bad := range [][]string{nil, {""}, {"/x"}, {"../x"}, {"a/../x"}, {"a/.."}, {"a\\b"}, {"a\x00b"}, {"a\nb"}, {strings.Repeat("a", 600)}} {
		if err := checkMemberNames(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestArchOf(t *testing.T) {
	if a, ok := ArchOf("Linux x86_64\n"); !ok || a != ArchAMD64 {
		t.Error("x86_64")
	}
	if a, ok := ArchOf("Linux aarch64"); !ok || a != ArchARM64 {
		t.Error("aarch64")
	}
	for _, s := range []string{"Darwin arm64", "Linux armv7l", "", "Linux x86_64 x"} {
		if _, ok := ArchOf(s); ok {
			t.Errorf("%q", s)
		}
	}
}

func TestDownloadReleaseIsHardened(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if err := downloadRelease(ctx, "http://github.com/x", filepath.Join(dir, "a"), 10); err == nil {
		t.Error("http accepted")
	}
	if err := downloadRelease(ctx, "https://evil.example.com/x", filepath.Join(dir, "a"), 10); err == nil {
		t.Error("a host that is not allowed")
	}
	if err := downloadRelease(ctx, "https://user:pw@github.com/x", filepath.Join(dir, "a"), 10); err == nil {
		t.Error("credentials accepted")
	}

	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			io.WriteString(w, "0123456789")
		case "/big":
			io.WriteString(w, strings.Repeat("x", 100))
		case "/redirect":
			http.Redirect(w, r, "https://evil.example.com/x", http.StatusFound)
		case "/redirect-http":
			http.Redirect(w, r, "http://127.0.0.1/x", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	oldHosts, oldTr := AllowedHosts, releaseTransport
	AllowedHosts, releaseTransport = []string{"127.0.0.1"}, ts.Client().Transport
	defer func() { AllowedHosts, releaseTransport = oldHosts, oldTr }()

	dst := filepath.Join(dir, "ok")
	if err := downloadRelease(ctx, ts.URL+"/ok", dst, 10); err != nil {
		t.Fatalf("a good download: %v", err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "0123456789" {
		t.Errorf("body %q", b)
	}
	if st, _ := os.Stat(dst); permsApply() && st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", st.Mode())
	}
	for _, p := range []string{"/big", "/redirect", "/redirect-http", "/missing"} {
		d := filepath.Join(dir, strings.ReplaceAll(p, "/", "_"))
		if err := downloadRelease(ctx, ts.URL+p, d, 10); err == nil {
			t.Errorf("%s accepted", p)
		}
		if _, err := os.Stat(d); err == nil {
			t.Errorf("%s left a file behind", p)
		}
	}
	if err := downloadRelease(ctx, ts.URL+"/ok", dst, 10); err == nil {
		t.Error("an existing file was overwritten")
	}
}

func TestInstallRefusesWhenTheFarSideHasNoRoomAndCopiesNothing(t *testing.T) {
	pkg := goodTar(t)
	e, home, log := newInstallEnv(t, pkg, "full")
	tg, _ := ParseTarget("user@box.example.com")
	_, err := e.in.Install(context.Background(), tg, ArchAMD64)
	if err == nil || !strings.Contains(err.Error(), "not enough free disk space") {
		t.Fatalf("err = %v", err)
	}
	b, _ := os.ReadFile(log)
	if strings.Contains(string(b), "cat >") || strings.Contains(string(b), "mkdir") {
		t.Errorf("something was copied or made before the room check:\n%s", b)
	}
	if _, serr := os.Stat(filepath.Join(home, ".coral-server")); serr == nil {
		t.Error("the install folder was made on a computer with no room")
	}
}

func TestParseKB(t *testing.T) {
	for in, want := range map[string]int64{"123\n": 123, " 0 ": 0} {
		if n, ok := parseKB(in); !ok || n != want {
			t.Errorf("%q = %d %v", in, n, ok)
		}
	}
	for _, bad := range []string{"", "x", "12 34", "-5", "1e3", "1234567890123456"} {
		if _, ok := parseKB(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

// The sum is removed before the folder it describes: an interrupted re-unpack must not leave a matching sum next to a half-written root.
func TestUnpackRemovesTheRecordedSumFirstAndWritesItLast(t *testing.T) {
	text, err := remoteText(CmdUnpack, "2.0.10")
	if err != nil {
		t.Fatal(err)
	}
	rmSum, rmRoot, tarX, write := strings.Index(text, "rm -f package.sha256"), strings.Index(text, "rm -rf root"), strings.Index(text, "tar -xzf"), strings.Index(text, "> package.sha256")
	if !(rmSum >= 0 && rmSum < rmRoot && rmRoot < tarX && tarX < write) {
		t.Errorf("order is wrong: %s", text)
	}
}
