package main

import (
	"bytes"
	"strings"
	"testing"
)

// A display does not mean a browser: under WSLg (DISPLAY and WAYLAND_DISPLAY set) with no xdg-open, the opener does not start, and the
// sign-in link must then be printed, or a new user is left with no way in (the WSL2 install walk, task #485).
func TestOpenPrintsTheLinkWhenNoBrowserOpened(t *testing.T) {
	t.Setenv("DISPLAY", ":0")
	t.Setenv("TMUX", "")
	const link = "http://localhost:8420/?login_token=x"
	for _, started := range []bool{false, true} {
		var asked string
		old := openLogin
		openLogin = func(l string) bool { asked = l; return started }
		var out bytes.Buffer
		openDashboard(&out, link, true)
		openLogin = old
		if asked != link {
			t.Fatalf("opener started=%v: asked to open %q, want the link", started, asked)
		}
		printed := strings.Contains(out.String(), link)
		if !started && !printed {
			t.Errorf("the opener did not start and the link was not printed:\n%s", out.String())
		}
		if started && out.Len() > 0 {
			t.Errorf("a browser opened and something was printed anyway:\n%s", out.String())
		}
	}
}
