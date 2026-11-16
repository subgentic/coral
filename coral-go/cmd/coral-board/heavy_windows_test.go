//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/winjob"
)

// #17721: if the job cannot be made, the command is not run loose: the run returns 1 and the command, started suspended, has run nothing.
func TestAFailureToMakeTheJobRunsNothingAndReturnsOne(t *testing.T) {
	if why := heavyUnsupportedHere(); why != "" {
		t.Skip(why)
	}
	old := newJob
	newJob = func(winjob.Limits) (*winjob.Job, error) { return nil, errors.New("no job today") }
	defer func() { newJob = old }()
	marker := filepath.Join(t.TempDir(), "ran")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if code := heavyRunLocal(ctx, "echo ran > '"+filepath.ToSlash(marker)+"'"); code != 1 {
		t.Fatalf("exit code %d, want 1", code)
	}
	time.Sleep(500 * time.Millisecond) // sleep-ok: the command must not have run in this time either
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the command ran without its job")
	}
}
