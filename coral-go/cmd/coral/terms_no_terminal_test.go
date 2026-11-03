package main

import (
	"strings"
	"testing"
)

func TestAStartThatEndsAtTheTermsExitsByWhetherAnybodyCouldBeAsked(t *testing.T) {
	var said int
	note := func() { said++ }
	for _, goos := range []string{"windows", "linux", "darwin"} {
		said = 0
		if got := termsDeclinedExit(goos, false, note); got != 0 || said != 0 {
			t.Errorf("%s, declined in a terminal: exit %d, note %d times; want 0 and none (as before)", goos, got, said)
		}
	}
	said = 0
	if got := termsDeclinedExit("windows", true, note); got != 1 || said != 1 {
		t.Errorf("windows, no terminal: exit %d, note %d times; want 1 and the note once", got, said)
	}
	for _, goos := range []string{"linux", "darwin"} {
		said = 0
		if got := termsDeclinedExit(goos, true, note); got != 0 || said != 0 {
			t.Errorf("%s, no terminal: exit %d, note %d times; want 0 and no note (a restarting supervisor must not loop; nothing to show it on)", goos, got, said)
		}
	}
}

func TestTheTermsNeededNoteSaysHowToOpenCoralAndCarriesNoLink(t *testing.T) {
	for _, bad := range []string{"http", "token", "\\", "/"} {
		for _, s := range []string{termsNeededNote, termsNeededNoteTitle} {
			if strings.Contains(strings.ToLower(s), bad) {
				t.Errorf("the note holds %q: %q", bad, s)
			}
		}
	}
}
