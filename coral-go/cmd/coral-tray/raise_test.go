package main

import (
	"errors"
	"os"
	"testing"
)

type fakeProc struct {
	got []os.Signal
	err error
}

func (f *fakeProc) Signal(s os.Signal) error { f.got = append(f.got, s); return f.err }

// #19789: a click on Open Coral signals the app on macOS (the app raises itself), and nothing else runs on other systems.
func TestRaiseAppSignalsTheAppOnMac(t *testing.T) {
	p := &fakeProc{}
	called := false
	raiseApp("darwin", p, 1, func(int) error { called = true; return nil })
	if len(p.got) != 1 || p.got[0] != raiseSignal {
		t.Fatalf("signals = %v, want one SIGUSR1", p.got)
	}
	if called {
		t.Fatal("the AppleScript way ran although the signal was sent")
	}
}

func TestRaiseAppFallsBackToSystemEventsOnlyWhenTheSignalFails(t *testing.T) {
	called := 0
	raiseApp("darwin", failing{}, 4242, func(pid int) error {
		if pid != 4242 {
			t.Fatalf("pid = %d", pid)
		}
		called++
		return nil
	})
	if called != 1 {
		t.Fatalf("fallback ran %d times, want 1", called)
	}
}

type failing struct{}

func (f failing) Signal(os.Signal) error { return errors.New("no such process") }

func TestRaiseAppDoesNothingOffMac(t *testing.T) {
	p := &fakeProc{}
	raiseApp("linux", p, 1, func(int) error { t.Fatal("ran"); return nil })
	raiseApp("windows", p, 1, func(int) error { t.Fatal("ran"); return nil })
	if len(p.got) != 0 {
		t.Fatalf("signals = %v", p.got)
	}
}
