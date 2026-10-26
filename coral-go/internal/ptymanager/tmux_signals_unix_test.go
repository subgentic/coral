//go:build !windows

package ptymanager

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/terminalinput"
)

// Tests for what the mutation audit of 159 (#6196) found nothing pinning in the tmux tree kill.

// A pane pid of 0, 1 or one that is no number does nothing: beginTreeKill hands back the same do-nothing function for all of them. It is never called here: with a pid of 1 the real tree would be
// every process of the user's session, and a test must not signal that even when it is the guard that is broken (the function for a real pane is a different one).
func TestATmuxTreeKillForPid0Or1DoesNothing(t *testing.T) {
	code := func(f func()) uintptr { return reflect.ValueOf(f).Pointer() }
	nothing := code(beginTreeKill("not-a-pid claude-00000000-0000-4000-8000-000000000000", ""))
	for _, answer := range []string{"0 claude-00000000-0000-4000-8000-000000000000", "1 claude-00000000-0000-4000-8000-000000000000", "-5 x"} {
		if got := code(beginTreeKill(answer, "")); got != nothing {
			t.Fatalf("%q: the pane's pid is not a process to end, so nothing is to be done (got a function that does something)", answer)
		}
	}
	// the control: a live process that is not Coral's pane gives a function that does something
	if got := code(beginTreeKill(strconv.Itoa(os.Getppid())+" claude-00000000-0000-4000-8000-000000000000", "")); got == nothing {
		t.Fatal("a real pid gives a function that acts, not the do-nothing one")
	}
}

// The polite stop: a child that leaves only on SIGHUP and one that leaves only on SIGTERM are both ended within the grace by the signal itself, not by the SIGKILL after it (which writes no marker).
func TestTmuxKillSendsTheHangupAndTheTerminate(t *testing.T) {
	needPerl(t)
	term := newTmuxTestTerminal(t)
	dir := t.TempDir()
	const name = "claude-00006196-0001-4000-8000-000000000000"
	spawnTmuxSession(t, term, name, dir)
	// A long grace: the markers prove the SIGNALS ended the children (the SIGKILL after the grace writes none), and a stall of the machine of a few seconds cannot let that SIGKILL come first (#8025: under CI load the
	// 3 s grace ran out before a child's handler had run, and the test read the late SIGKILL as a hangup never sent).
	setWaits(t, func(w *waitTimings) { w.treeGrace = 30 * time.Second })
	f := func(s string) string { return filepath.Join(dir, s) }
	cmd := `perl -e 'use POSIX; ` +
		`if (!fork) { POSIX::setsid(); $SIG{TERM} = "IGNORE"; $SIG{HUP} = sub { open M, ">` + f("hup.mark") + `"; print M "x"; close M; exit 0 }; open F, ">` + f("hup.pid") + `"; print F $$; close F; sleep 600; exit 0 } ` +
		`if (!fork) { setpgrp(0, 0); $SIG{HUP} = "IGNORE"; $SIG{TERM} = sub { open M, ">` + f("term.mark") + `"; print M "x"; close M; exit 0 }; open F, ">` + f("term.pid") + `"; print F $$; close F; sleep 600; exit 0 } ` +
		`wait; wait'`
	if err := term.SendInput(context.Background(), terminalinput.Internal, name, cmd, "", ""); err != nil {
		t.Fatal(err)
	}
	hup, termPID := pidFrom(t, f("hup.pid")), pidFrom(t, f("term.pid"))
	if err := term.KillSession(context.Background(), name, "", ""); err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{"hup.mark", "term.mark"} {
		ok := false
		for end := time.Now().Add(waits().treeGrace - 10*time.Second); time.Now().Before(end); time.Sleep(25 * time.Millisecond) {
			if _, err := os.Stat(f(m)); err == nil {
				ok = true
				break
			}
		}
		if !ok {
			t.Fatalf("%s was not written within the grace: the signal that child handles was not sent (a child ended only by the SIGKILL leaves no marker)", m)
		}
	}
	waitGone(t, hup, 2*time.Second)
	waitGone(t, termPID, 2*time.Second)
}

// The other side of the grace (#8025): a child whose hangup handler needs longer than the grace is ended by the SIGKILL that follows it and leaves no marker. This is what a machine that stalls for a few seconds
// does to the test above on its production 3 s, which is why that test runs with a long grace: the missing marker there did not mean the hangup was not sent.
func TestTmuxKillEndsAChildThatIsSlowerThanTheGraceWithTheKill(t *testing.T) {
	needPerl(t)
	term := newTmuxTestTerminal(t)
	dir := t.TempDir()
	const name = "claude-00008025-0001-4000-8000-000000000000"
	spawnTmuxSession(t, term, name, dir)
	setWaits(t, func(w *waitTimings) { w.treeGrace = 400 * time.Millisecond })
	f := func(s string) string { return filepath.Join(dir, s) }
	cmd := `perl -e 'use POSIX; ` +
		`if (!fork) { POSIX::setsid(); $SIG{TERM} = "IGNORE"; $SIG{HUP} = sub { select(undef, undef, undef, 2); open M, ">` + f("slow.mark") + `"; print M "x"; close M; exit 0 }; open F, ">` + f("slow.pid") + `"; print F $$; close F; sleep 600; exit 0 } ` +
		`wait'`
	if err := term.SendInput(context.Background(), terminalinput.Internal, name, cmd, "", ""); err != nil {
		t.Fatal(err)
	}
	slow := pidFrom(t, f("slow.pid"))
	if err := term.KillSession(context.Background(), name, "", ""); err != nil {
		t.Fatal(err)
	}
	waitGone(t, slow, 5*time.Second)    // the SIGKILL after the 400 ms grace ended it, long before its 2 s handler could finish
	time.Sleep(2500 * time.Millisecond) // sleep-ok: the marker, if the handler were to finish, would appear in 2 s; there is no event for a file that must not appear
	if _, err := os.Stat(f("slow.mark")); err == nil {
		t.Fatal("the slow handler finished: the SIGKILL after the grace did not end it")
	}
}
