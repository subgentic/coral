package sshprov

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// #15691: where the package comes from. By default the far computer downloads it (#12217); the hub can download it and send it over the SSH session, or the person can upload it. Either way the
// package is installed only when its SHA-256 is the one the signed sums give for this hub's own tag, and the far side hashes it again.

const wantAsset = "coral-linux-amd64-2.0.10.tar.gz"

// hubServes makes the hub's download fetch the package (and "x" for the signed files).
func hubServes(e *installEnv, pkg []byte) {
	e.in.Download = func(_ context.Context, url, dst string, max int64) error {
		e.mu.Lock()
		e.dls++
		e.mu.Unlock()
		if strings.HasSuffix(url, ".tar.gz") {
			if !strings.HasSuffix(url, "/v2.0.10/"+wantAsset) {
				e.t.Errorf("the hub downloaded %s", url)
			}
			return os.WriteFile(dst, pkg, 0o600)
		}
		return os.WriteFile(dst, []byte("x"), 0o600)
	}
}

func writeUpload(t *testing.T, name string, b []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func farLog(t *testing.T, log string) string {
	b, _ := os.ReadFile(log)
	return string(b)
}

func TestTheHubDownloadsAndSendsThePackageWhenAsked(t *testing.T) {
	pkg := goodTar(t)
	e, home, log := newInstallEnv(t, pkg, "")
	hubServes(e, pkg)
	e.in.Source = SourceHub
	tg, _ := ParseTarget("user@box.example.com")
	got, err := e.in.Install(context.Background(), tg, ArchAMD64)
	if err != nil {
		t.Fatalf("Install: %v (%v)", err, e.steps)
	}
	if got != sha(pkg) {
		t.Errorf("sha = %s", got)
	}
	if e.dls != 3 {
		t.Errorf("the hub downloaded %d files, want the sums, their bundle and the package", e.dls)
	}
	l := farLog(t, log)
	if !strings.Contains(l, "cat >") || strings.Contains(l, "curl ") {
		t.Errorf("the package was not sent over the session, or the far side downloaded it:\n%s", l)
	}
	root := filepath.Join(home, ".coral-server", "2.0.10")
	if b, err := os.ReadFile(filepath.Join(root, "root", "coral")); err != nil || !strings.Contains(string(b), "echo coral") {
		t.Errorf("coral was not unpacked: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "package.sha256")); strings.TrimSpace(string(b)) != sha(pkg) {
		t.Errorf("recorded sum = %q", b)
	}
}

// Failing-first: a package the hub downloaded that is not the signed one is refused before anything is sent.
func TestAHubDownloadThatIsNotTheSignedPackageIsRefusedAndNothingIsSent(t *testing.T) {
	pkg := goodTar(t)
	e, home, log := newInstallEnv(t, pkg, "")
	hubServes(e, append(append([]byte{}, pkg...), 'x')) // what GitHub (or a proxy) served is not what was signed
	e.in.Source = SourceHub
	tg, _ := ParseTarget("user@box.example.com")
	_, err := e.in.Install(context.Background(), tg, ArchAMD64)
	if err == nil || !strings.Contains(err.Error(), "is not the one that was verified") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(farLog(t, log), "cat >") {
		t.Error("a package that failed the check was sent")
	}
	if _, serr := os.Stat(filepath.Join(home, ".coral-server", "2.0.10", "root")); serr == nil {
		t.Error("unpacked")
	}
}

func TestAnUploadedPackageIsSentAfterItsHashMatchesTheSignedSum(t *testing.T) {
	pkg := goodTar(t)
	e, home, log := newInstallEnv(t, pkg, "")
	e.in.Source = SourceUpload
	e.in.Upload = Upload{Package: writeUpload(t, "p.tar.gz", pkg)}
	tg, _ := ParseTarget("user@box.example.com")
	got, err := e.in.Install(context.Background(), tg, ArchAMD64)
	if err != nil {
		t.Fatalf("Install: %v (%v)", err, e.steps)
	}
	if got != sha(pkg) {
		t.Errorf("sha = %s", got)
	}
	if e.dls != 2 {
		t.Errorf("downloads %d: only the signed sums and their bundle come from GitHub", e.dls)
	}
	if l := farLog(t, log); !strings.Contains(l, "cat >") || strings.Contains(l, "curl ") {
		t.Errorf("the upload was not sent over the session:\n%s", l)
	}
	if _, err := os.Stat(filepath.Join(home, ".coral-server", "2.0.10", "root", "coral")); err != nil {
		t.Errorf("not unpacked: %v", err)
	}
}

// The tampered upload: bytes that are not the signed release (a changed package, another version's, or another architecture's) are refused, and the far computer is sent nothing.
func TestATamperedUploadIsRefusedAndNothingIsSentOrUnpacked(t *testing.T) {
	pkg := goodTar(t)
	other := makeTarGz(t, []member{{name: "coral", body: "#!/bin/sh\necho evil\n"}})
	for name, up := range map[string][]byte{
		"a changed byte":    append(append([]byte{}, pkg...), 0),
		"another package":   other,
		"not a package":     []byte("hello"),
		"an empty file":     {},
		"the package twice": append(append([]byte{}, pkg...), pkg...),
	} {
		e, home, log := newInstallEnv(t, pkg, "") // the signed sums say pkg
		e.in.Source = SourceUpload
		e.in.Upload = Upload{Package: writeUpload(t, "p.tar.gz", up)}
		tg, _ := ParseTarget("user@box.example.com")
		_, err := e.in.Install(context.Background(), tg, ArchAMD64)
		if err == nil || !strings.Contains(err.Error(), "is not the signed v2.0.10 release") {
			t.Errorf("%s: err = %v", name, err)
		}
		if strings.Contains(farLog(t, log), "cat >") {
			t.Errorf("%s: a package that failed the check was sent", name)
		}
		if _, serr := os.Stat(filepath.Join(home, ".coral-server", "2.0.10", "root")); serr == nil {
			t.Errorf("%s: unpacked", name)
		}
	}
}

// A package whose hash IS the signed one but whose members are not plain paths is still refused (the member walk), so nothing outside the install folder can be written.
func TestASignedUploadWithBadMemberPathsIsStillRefused(t *testing.T) {
	evil := makeTarGz(t, []member{{name: "../evil", body: "x"}})
	e, _, log := newInstallEnv(t, evil, "")
	e.in.Source = SourceUpload
	e.in.Upload = Upload{Package: writeUpload(t, "p.tar.gz", evil)}
	tg, _ := ParseTarget("user@box.example.com")
	_, err := e.in.Install(context.Background(), tg, ArchAMD64)
	if err == nil || !strings.Contains(err.Error(), "paths that are not allowed") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(farLog(t, log), "cat >") {
		t.Error("sent")
	}
}

// With the signed sums and their bundle uploaded too, the hub never reaches GitHub (a computer behind a firewall): they go to the same verifier, in the same 0700 folder.
func TestUploadedSumsAndBundleNeedNoGitHub(t *testing.T) {
	pkg := goodTar(t)
	e, _, _ := newInstallEnv(t, pkg, "")
	e.in.Download = func(_ context.Context, url, _ string, _ int64) error {
		t.Errorf("the hub reached for %s although the sums were uploaded", url)
		return os.ErrInvalid
	}
	var seen []string
	run := e.in.RunHelper
	e.in.RunHelper = func(ctx context.Context, tag, asset, dir string) (string, error) {
		for _, n := range []string{sumsName, sumsBundleName} {
			if b, err := os.ReadFile(filepath.Join(dir, n)); err != nil || !strings.HasPrefix(string(b), "uploaded") {
				t.Errorf("%s in the verifier's folder: %v %q", n, err, b)
			}
			seen = append(seen, n)
		}
		return run(ctx, tag, asset, dir)
	}
	e.in.Source = SourceUpload
	e.in.Upload = Upload{Package: writeUpload(t, "p.tar.gz", pkg), Sums: writeUpload(t, "s", []byte("uploaded sums")), Bundle: writeUpload(t, "b", []byte("uploaded bundle"))}
	tg, _ := ParseTarget("user@box.example.com")
	if _, err := e.in.Install(context.Background(), tg, ArchAMD64); err != nil {
		t.Fatalf("Install: %v (%v)", err, e.steps)
	}
	if len(seen) != 2 {
		t.Errorf("the verifier saw %v", seen)
	}
}

// Sums that do not verify (forged, or for another tag) refuse the install, whatever the package is.
func TestUploadedSumsThatDoNotVerifyRefuseTheInstall(t *testing.T) {
	pkg := goodTar(t)
	e, _, log := newInstallEnv(t, pkg, "")
	e.in.RunHelper = func(context.Context, string, string, string) (string, error) { return "", os.ErrInvalid }
	e.in.Source = SourceUpload
	e.in.Upload = Upload{Package: writeUpload(t, "p.tar.gz", pkg), Sums: writeUpload(t, "s", []byte("forged")), Bundle: writeUpload(t, "b", []byte("forged"))}
	tg, _ := ParseTarget("user@box.example.com")
	_, err := e.in.Install(context.Background(), tg, ArchAMD64)
	if err == nil || !strings.Contains(err.Error(), "could not be verified") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(farLog(t, log), "cat >") {
		t.Error("sent")
	}
}

func TestTheUploadChoicesAreRefusedWhenIncomplete(t *testing.T) {
	pkg := goodTar(t)
	tg, _ := ParseTarget("user@box.example.com")
	for name, in := range map[string]Installer{
		"an unknown source":         {Source: "scp"},
		"upload without a package":  {Source: SourceUpload},
		"sums without their bundle": {Source: SourceUpload, Upload: Upload{Package: "x", Sums: "y"}},
		"a bundle without its sums": {Source: SourceUpload, Upload: Upload{Package: "x", Bundle: "y"}},
	} {
		e, _, log := newInstallEnv(t, pkg, "")
		in.Runner, in.Version, in.TempDir, in.Download, in.RunHelper = e.in.Runner, e.in.Version, e.in.TempDir, e.in.Download, e.in.RunHelper
		if _, err := in.Install(context.Background(), tg, ArchAMD64); err == nil {
			t.Errorf("%s: installed", name)
		}
		if l := farLog(t, log); strings.Contains(l, "cat >") || strings.Contains(l, "curl ") {
			t.Errorf("%s: touched the far side", name)
		}
	}
}

// The far side hashes what arrived and the hub compares again: a package that changes on the way is refused and not unpacked (the far-side check of #12217, now for a sent package).
func TestASentPackageThatChangedOnTheWayIsRefusedByTheFarSideCheck(t *testing.T) {
	pkg := goodTar(t)
	e, home, _ := newInstallEnv(t, pkg, "corrupt")
	e.in.Source = SourceUpload
	e.in.Upload = Upload{Package: writeUpload(t, "p.tar.gz", pkg)}
	tg, _ := ParseTarget("user@box.example.com")
	_, err := e.in.Install(context.Background(), tg, ArchAMD64)
	if err == nil || !strings.Contains(err.Error(), "is not the one that was verified") {
		t.Fatalf("err = %v", err)
	}
	if _, serr := os.Stat(filepath.Join(home, ".coral-server", "2.0.10", "root")); serr == nil {
		t.Error("unpacked")
	}
}

func TestHashCappedRefusesMoreThanTheCap(t *testing.T) {
	if _, _, err := hashCapped(strings.NewReader(strings.Repeat("a", 11)), 10); err == nil {
		t.Error("an over-long body was hashed")
	}
	got, n, err := hashCapped(strings.NewReader("abc"), 10)
	if err != nil || n != 3 || got != sha([]byte("abc")) {
		t.Errorf("hash %s %d %v", got, n, err)
	}
}
