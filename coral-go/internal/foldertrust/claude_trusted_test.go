package foldertrust

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestClaudeTrustedReadsTheFileAndAskedFoldersParents(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, ".claude.json")
	write := func(s string) {
		if err := os.WriteFile(cfg, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"projects":{"/work/app":{"hasTrustDialogAccepted":true},"/work/other":{"hasTrustDialogAccepted":false}}}`)
	for _, c := range []struct {
		path           string
		trusted, known bool
	}{
		{"/work/app", true, true},
		{"/work/app/sub/deeper", true, true}, // Claude trusts what is under a trusted folder
		{"/work/other", false, true},
		{"/elsewhere", false, true},
	} {
		if tr, kn := ClaudeTrusted(cfg, c.path); tr != c.trusted || kn != c.known {
			t.Errorf("%s: trusted=%v known=%v, want %v %v", c.path, tr, kn, c.trusted, c.known)
		}
	}
	write(`not json`)
	if tr, kn := ClaudeTrusted(cfg, "/work/app"); tr || kn {
		t.Errorf("a file that is not JSON must be unknown, got trusted=%v known=%v", tr, kn)
	}
	if tr, kn := ClaudeTrusted(filepath.Join(dir, "missing.json"), "/work/app"); tr || kn {
		t.Errorf("a missing file must be unknown, got trusted=%v known=%v", tr, kn)
	}
	link := filepath.Join(dir, "link.json")
	write(`{"projects":{"/work/app":{"hasTrustDialogAccepted":true}}}`)
	if err := os.Symlink(cfg, link); err == nil {
		if tr, kn := ClaudeTrusted(link, "/work/app"); tr || kn {
			t.Errorf("a link must be unknown, got trusted=%v known=%v", tr, kn)
		}
	}
}

// A Windows user's file keys folders with forward slashes and a drive letter, while the launch asks with backslashes and whatever case the disk gives; the two must meet (#20653). The key form itself is checked on every system.
func TestClaudeTrustedMeetsWindowsShapedPaths(t *testing.T) {
	cfg := filepath.Join(t.TempDir(), ".claude.json")
	if err := os.WriteFile(cfg, []byte(`{"projects":{"C:/Users/Me/App":{"hasTrustDialogAccepted":true},"C:/Users/Me/No":{"hasTrustDialogAccepted":false}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := trustKey(`C:/Users/Me/App/`); got != trustKey(filepath.FromSlash(`C:/Users/Me/App`)) {
		t.Errorf("a trailing slash must not change the key: %q", got)
	}
	if runtime.GOOS != "windows" {
		return
	}
	for _, c := range []struct {
		path    string
		trusted bool
	}{
		{`C:\Users\Me\App`, true},
		{`c:\users\me\app\sub\deeper`, true}, // the disk ignores case
		{`C:/Users/Me/App/sub`, true},
		{`C:\Users\Me\No`, false},
		{`D:\Users\Me\App`, false}, // another drive is another folder
		{`C:\Users\Me\Application`, false},
	} {
		if tr, kn := ClaudeTrusted(cfg, c.path); tr != c.trusted || !kn {
			t.Errorf("%s: trusted=%v known=%v, want %v true", c.path, tr, kn, c.trusted)
		}
	}
}
