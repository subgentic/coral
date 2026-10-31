package agent

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// #413: CoralToolsSource remembers a FOUND folder for good, and "none" only for emptyFor. Agents with no tools folder fall back to whatever is first on PATH, the less trusted choice, so a
// coral-board that appears after a "none" answer must be seen: within emptyFor the answer is "none" (that is the saving), after it the folder is found.
func TestCoralToolsSourceSeesAToolThatAppearsAfterANoneAnswer(t *testing.T) {
	installed := t.TempDir()
	prevDir, prevAllow := installedToolsDir, installedFallback.Load()
	installedToolsDir = installed
	clock := time.Now()
	now := func() time.Time { return clock }
	toolsClock.Store(&now)
	t.Cleanup(func() { installedToolsDir = prevDir; installedFallback.Store(prevAllow); toolsClock.Store(nil) })
	SetInstalledToolsFallback(true)

	if dir, src := CoralToolsSource(); dir != "" || src != "" {
		t.Fatalf("nothing installed yet: %q %q", dir, src)
	}
	if err := os.WriteFile(filepath.Join(installed, "coral-board"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if dir, _ := CoralToolsSource(); dir != "" {
		t.Errorf("inside the window the earlier none answer is reused (that is what saves the stats): %q", dir)
	}
	clock = clock.Add(emptyFor + time.Second)
	if dir, src := CoralToolsSource(); dir != installed || src != "the installed Coral app" {
		t.Fatalf("after the window a coral-board created after a none answer is found: %q %q", dir, src)
	}

	// a found folder is kept, even for the next hour: it is not looked for again
	if err := os.Remove(filepath.Join(installed, "coral-board")); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Hour)
	if dir, _ := CoralToolsSource(); dir != installed {
		t.Errorf("a found folder is remembered: %q", dir)
	}
}
