package main

// Opt-in startup screen for dashboard regressions: no hook or first turn is
// emitted until the person answers it, as with a real CLI's trust question.
import (
	"fmt"
	"golang.org/x/term"
	"io"
	"os"
)

func holdStartupPrompt() {
	if os.Getenv("MOCK_AGENT_STARTUP_PROMPT") != "trust" {
		return
	}
	if term.IsTerminal(int(os.Stdin.Fd())) {
		before, err := term.MakeRaw(int(os.Stdin.Fd()))
		if err == nil {
			defer term.Restore(int(os.Stdin.Fd()), before)
		}
	}
	if !readStartupTrust(os.Stdin, os.Stdout) {
		os.Exit(0)
	}
}
func readStartupTrust(input io.Reader, output io.Writer) bool {
	fmt.Fprint(output, "Do you trust the files in this folder?\r\n\r\n ❯ 1. Yes, proceed\r\n   2. No, exit\r\n\r\n Enter to confirm · Esc to exit\r\n")
	var b [1]byte
	choice := byte('1')
	escape := 0
	for {
		n, err := input.Read(b[:])
		if err != nil || n == 0 {
			return false
		}
		if escape == 1 && b[0] == '[' {
			escape = 2
			continue
		}
		if escape == 2 {
			if b[0] == 'A' || b[0] == 'B' {
				if choice == '1' {
					choice = '2'
				} else {
					choice = '1'
				}
			}
			escape = 0
			continue
		}
		if escape == 1 {
			return false
		}
		switch b[0] {
		case 27:
			escape = 1
		case '1', '2':
			// Claude's numbered menu accepts the digit without Enter.
			fmt.Fprint(output, "\x1b[2J\x1b[H")
			return b[0] == '1'
		case '\r', '\n':
			fmt.Fprint(output, "\x1b[2J\x1b[H")
			return choice == '1'
		case 3:
			return false
		}
	}
}
