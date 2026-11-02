//go:build !windows

package sshprov

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The real shell text of CmdDownload (#12217, QA): a stub curl on PATH writes a package, and the template's own sha256 check decides. The right hash keeps the file and exits 0; a wrong hash deletes it and exits 5;
// a failed download leaves nothing and exits 4; no curl exits 6. The curl it runs is https-only, bounded, and names the release URL built from the version and the architecture.
func TestDownloadCommandInARealShell(t *testing.T) {
	home := t.TempDir()
	vdir := filepath.Join(home, InstallDir, "2.0.10")
	if err := os.MkdirAll(vdir, 0o700); err != nil {
		t.Fatal(err)
	}
	pkg := []byte("the release package")
	sum := sha256.Sum256(pkg)
	good := hex.EncodeToString(sum[:])
	bad := strings.Repeat("0", 64)

	bin := t.TempDir()
	argvLog := filepath.Join(t.TempDir(), "curl.argv")
	pkgFile := filepath.Join(t.TempDir(), "served")
	if err := os.WriteFile(pkgFile, pkg, 0o600); err != nil {
		t.Fatal(err)
	}
	stub := "#!/bin/sh\necho \"$@\" >> '" + argvLog + "'\n[ -e '" + filepath.Join(bin, "fail") + "' ] && exit 22\nwhile [ $# -gt 0 ]; do if [ \"$1\" = -o ]; then out=\"$2\"; fi; shift; done\ncat '" + pkgFile + "' > \"$out\"\n"
	if err := os.WriteFile(filepath.Join(bin, "curl"), []byte(stub), 0o700); err != nil {
		t.Fatal(err)
	}
	run := func(path, sha string) int {
		text, err := remoteText(CmdDownload, "2.0.10", "amd64", sha)
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("/bin/sh", "-c", text)
		cmd.Env = []string{"HOME=" + home, "PATH=" + path}
		if err := cmd.Run(); err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				return ee.ExitCode()
			}
			t.Fatal(err)
		}
		return 0
	}
	path := bin + ":/usr/bin:/bin"
	file := filepath.Join(vdir, "package.tar.gz")

	if code := run(path, good); code != 0 {
		t.Fatalf("the right hash exited %d", code)
	}
	if b, err := os.ReadFile(file); err != nil || string(b) != string(pkg) {
		t.Errorf("the package was not kept: %v", err)
	}
	argv, _ := os.ReadFile(argvLog)
	for _, want := range []string{"--proto =https", "--proto-redir =https", "--tlsv1.2", "--max-redirs 3", "--max-filesize 314572800", "https://github.com/subgentic/coral/releases/download/v2.0.10/coral-linux-amd64-2.0.10.tar.gz"} {
		if !strings.Contains(string(argv), want) {
			t.Errorf("curl was run without %q: %s", want, argv)
		}
	}

	if code := run(path, bad); code != dlMismatch {
		t.Errorf("a wrong hash exited %d, want %d", code, dlMismatch)
	}
	if _, err := os.Stat(file); err == nil {
		t.Error("a package with the wrong hash was kept")
	}

	if err := os.WriteFile(filepath.Join(bin, "fail"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if code := run(path, good); code != dlFailed {
		t.Errorf("a failed download exited %d, want %d", code, dlFailed)
	}
	if _, err := os.Stat(file); err == nil {
		t.Error("a failed download left a file")
	}
	_ = os.Remove(filepath.Join(bin, "fail"))

	if code := run(t.TempDir(), good); code != dlNoCurl { // an empty PATH: no curl
		t.Errorf("no curl exited %d, want %d", code, dlNoCurl)
	}
}
