package ptymanager

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// #413: memoLookPath remembers a found program for the same PATH and a "not found" only for lookupNotFoundFor, so a program installed a moment later is picked up; a change of PATH asks again.
func TestMemoLookPathPicksUpAProgramInstalledAfterANotFound(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	name := "zzmemo-tool"
	file := name
	if runtime.GOOS == "windows" {
		file += ".exe"
	}
	clock := time.Now()
	now := func() time.Time { return clock }
	lookupClock.Store(&now)
	t.Cleanup(func() { lookupClock.Store(nil) })

	if _, err := memoLookPath(name); err == nil {
		t.Fatal("not installed yet: want an error")
	}
	if err := os.WriteFile(filepath.Join(dir, file), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := memoLookPath(name); err == nil {
		t.Error("inside the window the earlier not-found answer is reused (that is the saving)")
	}
	clock = clock.Add(lookupNotFoundFor + time.Second)
	got, err := memoLookPath(name)
	if err != nil || filepath.Base(got) != file {
		t.Fatalf("after the window the newly installed program is found: %q %v", got, err)
	}

	// found answers stay: removing the file does not change the answer for the same PATH
	if err := os.Remove(filepath.Join(dir, file)); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Hour)
	if again, err := memoLookPath(name); err != nil || again != got {
		t.Errorf("a found program is remembered: %q %v", again, err)
	}

	// a different PATH is a different question
	t.Setenv("PATH", t.TempDir())
	if _, err := memoLookPath(name); err == nil {
		t.Error("another PATH asks again and does not find it")
	}
}
