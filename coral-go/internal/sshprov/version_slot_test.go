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
	for _, c := range []Command{CmdMkVersionDir, CmdReceive, CmdTarList, CmdUnpack, CmdStartTmux, CmdReadAPIKey, CmdAcceptTerms, CmdReadInstalledSum} {
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
