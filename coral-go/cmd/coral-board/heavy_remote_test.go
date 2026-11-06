//go:build !windows

package main

import (
	"context"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/heavy"
)

// QA Reviewer 2's SHOULDs on #13750: the lost-slot case on the MINI path (a stub transport into the real wrapper, no ssh), and the exit code when a command succeeded but its slot was lost.

// wrapperTransport is ssh without ssh: the stream goes into the real wrapper through pipes, and when the run's context ends the connection ends (as killing ssh does).
func wrapperTransport(t *testing.T) heavy.Transport {
	return func(ctx context.Context) (heavy.Conn, error) {
		inR, inW := io.Pipe()
		outR, outW := io.Pipe()
		errR, errW := io.Pipe()
		done := make(chan struct{})
		cfg := heavy.Config{Root: filepath.Join(t.TempDir(), "coral-test"), Home: t.TempDir(), Shell: "/bin/sh", Now: time.Now, WatchStdin: true}
		go func() {
			heavy.Serve(context.Background(), inR, outW, errW, cfg)
			outW.Close()
			errW.Close()
			close(done)
		}()
		go func() {
			select {
			case <-ctx.Done():
				inW.Close() // what killing ssh does to the wrapper's stdin
			case <-done:
			}
		}()
		return heavy.Conn{Stdin: inW, Stdout: outR, Stderr: errR, Wait: func() error { <-done; return nil }}, nil
	}
}

func inTempRepo(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "x"}} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Skipf("no git: %v %s", err, out)
		}
	}
	t.Chdir(dir)
}

func TestAHeavyRunOnTheMiniThatLosesItsSlotIsStoppedThereToo(t *testing.T) {
	inTempRepo(t)
	prev := heavyTestTransport
	heavyTestTransport = wrapperTransport(t)
	defer func() { heavyTestTransport = prev }()
	prevFloor := heavyRenewFloor
	heavyRenewFloor = 50 * time.Millisecond
	defer func() { heavyRenewFloor = prevFloor }()
	soon := time.Now().Add(600 * time.Millisecond).UTC().Format(time.RFC3339Nano)
	s := &heavyStub{renewStatus: 409, grants: []string{`{"granted":true,"place":0,"entry":{"id":1,"member":"mini","machine":"Mini","lease_until":"` + soon + `"}}`}}
	start := time.Now()
	out, code := runHeavy(t, s, "run", "--", "sleep 60; echo should-not-print")
	if code == 0 || strings.Contains(out, "should-not-print") || time.Since(start) > 15*time.Second {
		t.Fatalf("a mini run that lost its slot is stopped: code=%d after %v out=%q", code, time.Since(start), out)
	}
	if !strings.Contains(out, "lost its slot") || !strings.Contains(out, "on Mini") {
		t.Fatalf("it ran on the mini and says it lost its slot: %q", out)
	}
}

func TestAHeavyRunOnTheMiniRunsAndReturnsTheExitCode(t *testing.T) {
	inTempRepo(t)
	prev := heavyTestTransport
	heavyTestTransport = wrapperTransport(t)
	defer func() { heavyTestTransport = prev }()
	s := &heavyStub{grants: []string{`{"granted":true,"place":0,"entry":{"id":1,"member":"mini","machine":"Mini"}}`}}
	out, code := runHeavy(t, s, "run", "--", "echo from-the-wrapper; exit 6")
	if code != 6 || !strings.Contains(out, "from-the-wrapper") {
		t.Fatalf("code=%d out=%q", code, out)
	}
}
