package gitutil

import (
	"os"
	"path/filepath"
	"testing"
)

// #17483: the answer for a folder that is not a repository comes from the file system, at once.
func TestNoRepoMarkerFor(t *testing.T) {
	plain := t.TempDir()
	if !NoRepoMarkerFor(plain) {
		t.Fatal("a folder with no .git in it, above it or one level below is not a repository")
	}
	if err := os.Mkdir(filepath.Join(plain, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if NoRepoMarkerFor(plain) {
		t.Fatal("a folder with a .git is a repository")
	}
	sub := filepath.Join(plain, "src")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if NoRepoMarkerFor(sub) {
		t.Fatal("a folder inside a repository is in it")
	}
	parent := t.TempDir()
	child := filepath.Join(parent, "app")
	if err := os.MkdirAll(filepath.Join(child, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if NoRepoMarkerFor(parent) {
		t.Fatal("a repository one level down is found, as ResolveGitRoot finds it")
	}
	if err := os.WriteFile(filepath.Join(t.TempDir(), "f"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if NoRepoMarkerFor(filepath.Join(plain, "missing")) || NoRepoMarkerFor("") || NoRepoMarkerFor("relative/dir") {
		t.Fatal("a folder that is not there, or no folder, is not claimed to be non-git")
	}
}
