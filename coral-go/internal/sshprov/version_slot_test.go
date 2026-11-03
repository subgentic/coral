package sshprov

import (
	"errors"
	"testing"
)

// Every command that takes a release version puts it inside a double-quoted remote shell string ("$HOME/.coral-server/<version>/..."), so the version slot is the injection surface: a version that is
// not exactly numbers and an optional suffix must never reach the text (QA Reviewer 2, #11370: an unanchored versionRe passed every other test).
func TestVersionSlotRefusesAnythingButAVersion(t *testing.T) {
	bad := []string{
		`1.2.3"; rm -rf ~; "`, "$(id)", "`id`", "1.2.3\n", "1.2.3 ", " 1.2.3", "x1.2.3", "1.2.3/../x", "../1.2.3", "1.2.3-a/b", "1.2.3'x", "", "1.2", "latest", "12345.1.1",
	}
	for _, c := range []Command{CmdMkVersionDir, CmdReceive, CmdTarList, CmdUnpack, CmdReadAPIKey, CmdAcceptTerms, CmdReadInstalledSum} {
		for _, v := range bad {
			if _, err := remoteText(c, v); !errors.Is(err, ErrNotAllowed) {
				t.Errorf("command %d accepted the version %q (err %v)", c, v, err)
			}
		}
		for _, ok := range []string{"2.0.10", "0.9.1", "2.0.9-beta", "10.20.30-rc.1"} {
			if _, err := remoteText(c, ok); err != nil {
				t.Errorf("command %d refused the version %q: %v", c, ok, err)
			}
		}
	}
}

// The daemon start takes the version and a backend, each matched before anything is run (#12233); a version that is a path, or a backend that is anything but pty, tmux or keep, is refused.
func TestStartDaemonRefusesABadVersionOrBackend(t *testing.T) {
	for _, v := range []string{`1.2.3"; rm -rf ~; "`, "$(id)", "1.2.3/../x", "latest", ""} {
		if _, err := remoteText(CmdStartDaemon, v, "pty", "@keep"); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("the version %q: %v", v, err)
		}
	}
	for _, b := range []string{"", "PTY", "tmux; id", "$(id)", "screen", "pty ", "keep\n"} {
		if _, err := remoteText(CmdStartDaemon, "2.0.10", b, "@keep"); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("the backend %q: %v", b, err)
		}
	}
	for _, b := range []string{"pty", "tmux", "keep"} {
		if _, err := remoteText(CmdStartDaemon, "2.0.10", b, "@keep"); err != nil {
			t.Errorf("the backend %q: %v", b, err)
		}
	}
}
