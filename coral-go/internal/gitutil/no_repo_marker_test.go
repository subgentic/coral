package gitutil

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// forget drops the kept answers: a test that makes a .git between two asks wants the second answer from the file system.
func forget() {
	noRepoMu.Lock()
	clear(noRepoUntil)
	noRepoMu.Unlock()
}

// #17483: the answer for a folder that is not a repository comes from the file system, at once.
func TestNoRepoMarkerFor(t *testing.T) {
	plain := t.TempDir()
	if !NoRepoMarkerFor(plain) {
		t.Fatal("a folder with no .git in it, above it or one level below is not a repository")
	}
	forget()
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

// #17599: the answer is kept for a few seconds (the Branches tab polls), a folder with more than the cap of entries takes the slow answer, and a .git made later is seen once the answer has expired.
func TestNoRepoMarkerForIsKeptBrieflyAndCapped(t *testing.T) {
	forget()
	now := time.Now()
	noRepoNow = func() time.Time { return now }
	t.Cleanup(func() { noRepoNow = time.Now })
	plain := t.TempDir()
	if !NoRepoMarkerFor(plain) {
		t.Fatal("not a repository")
	}
	if err := os.Mkdir(filepath.Join(plain, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !NoRepoMarkerFor(plain) {
		t.Fatal("within the TTL the kept answer is given (no listing on every poll)")
	}
	now = now.Add(noRepoTTL + time.Second)
	if NoRepoMarkerFor(plain) {
		t.Fatal("after the TTL a .git made since is seen")
	}
	big := t.TempDir()
	for i := 0; i <= noRepoMaxEntries; i++ {
		if err := os.Mkdir(filepath.Join(big, "d"+strconv.Itoa(i)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if NoRepoMarkerFor(big) {
		t.Fatal("a folder with more than the cap of entries is not said to be non-git (the slow answer decides)")
	}
}
