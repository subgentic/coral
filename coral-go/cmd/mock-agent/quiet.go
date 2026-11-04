package main

import (
	"fmt"
	"os"
)

// MOCK_AGENT_QUIET=1 (#13180, for the demo film): the mock prints none of its "[mock-agent] ..." lines (its session id, board id, port and transcript path
// at start, the echo of each typed line, its prompt notes) to the terminal, so a terminal view on camera shows only a plain banner. Every such line goes
// through these helpers; unset, they print exactly what they always did, so no suite changes.
func quietMode() bool { return os.Getenv("MOCK_AGENT_QUIET") == "1" }

func sayf(format string, a ...any) {
	if !quietMode() {
		fmt.Printf(format, a...)
	}
}

func say(s string) {
	if !quietMode() {
		fmt.Print(s)
	}
}

func sayErrf(format string, a ...any) {
	if !quietMode() {
		fmt.Fprintf(os.Stderr, format, a...)
	}
}

func sayErrln(s string) {
	if !quietMode() {
		fmt.Fprintln(os.Stderr, s)
	}
}

// quietBanner is the one line a quiet mock draws at start: plain, and honest about what it is.
const quietBanner = "Demo agent (a stand-in for a real agent). Messages arrive in the chat view.\r\n"
