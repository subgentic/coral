package main

// termsNeededNote is what a person is told when Coral was started with no terminal (nothing that could ask) and the Terms have not been accepted on this computer. The Start menu entry
// starts the app, which shows the Terms in its own window; a terminal runs `coral` and asks.
const (
	termsNeededNoteTitle = "Coral"
	termsNeededNote      = "Coral needs the Terms accepted before it can start.\n\nOpen Coral from the Start menu, or run coral in a terminal, to read and accept them."
)

// showTermsNeeded is the note's way of showing (a test replaces it: a message box must never open under a test).
var showTermsNeeded = showTermsNeededNote

// termsDeclinedExit is the exit code of a start that ended at the Terms: 0 when somebody declined them in a terminal (as before), and on Windows 1 when nobody could be asked (no
// terminal), after telling the person through note (a message box, where they can see it). Elsewhere it stays 0 whatever the reason: a supervisor that restarts a failed program (systemd
// Restart=on-failure, a launchd keep-alive) would otherwise restart Coral over and over while the Terms stay unaccepted, and there is no message box to show.
func termsDeclinedExit(goos string, noTerminal bool, note func()) int {
	if !noTerminal || goos != "windows" {
		return 0
	}
	note()
	return 1
}
