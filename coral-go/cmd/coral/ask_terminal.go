package main

import (
	"net"
	"os"
	"strings"

	"golang.org/x/term"
)

// canAskAtTerminal reports whether a first-launch question can be asked and answered here
// (#4052). A terminal on stdin alone is not enough: on Windows a CI runner or a scheduled
// task can hand Coral a console nobody types in while its output goes to a pipe, and on
// Unix "coral &" keeps the terminal as stdin while a read would stop the process. So both
// stdin and stdout must be terminals, and on Unix Coral must be the terminal's foreground
// job. Otherwise nothing is asked: the safe default holds and the log says how to change it.
func canAskAtTerminal(stdin, stdout *os.File) bool {
	return term.IsTerminal(int(stdin.Fd())) && term.IsTerminal(int(stdout.Fd())) && inForeground(stdin)
}

// remoteQuestionMoot says whether the first-launch remote-access question has already been answered by how Coral was started (#14107, the v2.0.59 first-run walkthrough): --no-browser says nobody is at the screen
// for a dialog (a scripted or headless start, an agent's shell, which is a terminal too), and a --host of loopback addresses only says "this computer only", which is what "no" gives. Remote access then stays off, nothing is
// saved, and the next start without those flags still asks.
func remoteQuestionMoot(noBrowser bool, host string) bool {
	if noBrowser {
		return true
	}
	host = strings.TrimSpace(host)
	if host == "" {
		return false
	}
	for _, h := range strings.Split(host, ",") {
		h = strings.Trim(strings.TrimSpace(h), "[]")
		if h == "localhost" {
			continue
		}
		if ip := net.ParseIP(h); ip == nil || !ip.IsLoopback() {
			return false
		}
	}
	return true
}
