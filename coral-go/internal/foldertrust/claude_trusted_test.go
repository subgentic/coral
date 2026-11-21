package foldertrust

import (
	"os"
	"path/filepath"
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
