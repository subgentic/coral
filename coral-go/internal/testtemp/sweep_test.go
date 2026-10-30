package testtemp

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// What a run that died left behind goes at the next run: only a folder named exactly as setup names them, older than a day. A newer one,
// one whose name only looks alike, a file, and a link are left as they are.
func TestALaterRunRemovesOnlyStalePrivateFolders(t *testing.T) {
	base := t.TempDir()
	old := time.Now().Add(-2 * staleAfter)
	mk := func(name string, when time.Time) string {
		p := filepath.Join(base, name)
		if err := os.MkdirAll(filepath.Join(p, "tmp"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(p, "tmp", "f"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, when, when); err != nil {
			t.Fatal(err)
		}
		return p
	}
	stale := mk("ct-1234567", old)
	fresh := mk("ct-7654321", time.Now())
	lookalike := mk("ct-12ab", old)
	other := mk("ctx-1", old)
	file := filepath.Join(base, "ct-555")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(file, old, old); err != nil {
		t.Fatal(err)
	}
	target := mk("kept-target", old)
	link := filepath.Join(base, "ct-999")
	linked := os.Symlink(target, link) == nil

	sweepStale(base, time.Now())

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("a private folder older than a day was not removed: %v", err)
	}
	for _, p := range []string{fresh, lookalike, other, file, target} {
		if _, err := os.Lstat(p); err != nil {
			t.Errorf("%s was removed: %v", filepath.Base(p), err)
		}
	}
	if _, err := os.Stat(filepath.Join(target, "tmp", "f")); err != nil {
		t.Errorf("a link's target lost its contents: %v", err)
	}
	if linked {
		if _, err := os.Lstat(link); err != nil {
			t.Errorf("a link with the private folders' name was removed: %v", err)
		}
	}
}

// When the private folder can't be made, the run goes on as before and says so in one line on stderr.
func TestAPrivateFolderThatCantBeMadeIsSaid(t *testing.T) {
	notAFolder := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(notAFolder, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	before := os.Getenv(Marker)
	setupIn(notAFolder, &stderr)()
	got := stderr.String()
	if !strings.HasPrefix(got, "testtemp: no private test folder (") || strings.Count(got, "\n") != 1 {
		t.Errorf("stderr = %q, want one line saying there is no private test folder", got)
	}
	if os.Getenv(Marker) != before {
		t.Error("a failed setup changed the environment")
	}
}
