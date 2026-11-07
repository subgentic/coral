package main

import "testing"

// #14107: the first-launch remote-access question waited on a terminal even when Coral was started headless (--no-browser, an agent's shell) or for this computer only (--host 127.0.0.1): those answer it.
func TestRemoteQuestionIsMootForNoBrowserAndLoopbackOnlyHosts(t *testing.T) {
	for _, c := range []struct {
		noBrowser bool
		host      string
		moot      bool
	}{
		{false, "", false},                        // an interactive start with no flags still asks
		{true, "", true}, {true, "0.0.0.0", true}, // --no-browser: nobody at the screen
		{false, "127.0.0.1", true}, {false, "localhost", true}, {false, "::1", true}, {false, "[::1]", true}, {false, "127.0.0.1, ::1", true}, {false, "127.0.0.2", true},
		{false, "0.0.0.0", false}, {false, "192.168.1.5", false}, {false, "127.0.0.1,100.101.102.103", false}, {false, "my-host.local", false}, {false, " ", false},
	} {
		if got := remoteQuestionMoot(c.noBrowser, c.host); got != c.moot {
			t.Errorf("noBrowser=%v host=%q: moot=%v, want %v", c.noBrowser, c.host, got, c.moot)
		}
	}
}
