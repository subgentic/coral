package ptymanager

import (
	"context"
	"regexp"
)

// What stops an auto-sleep on the agent's screen (#12111, Security): killing the terminal loses what is in it.
const (
	SleepStopDialog     = "a prompt or menu is open"                            // answering it is a person's; sleeping would hide it
	SleepStopBackground = "a background shell or monitor is still running"      // the footer says so: sleeping would kill it
	SleepStopDraft      = "a draft in the box, or a screen that cannot be read" // a person's typed text is lost with the terminal; an unreadable screen counts as a draft
)

// ScreenStopsSleep reads the agent's screen once, as a delivery does (the same look: DeliverAutomated's), and says why it must not be put to sleep, or "" when the screen is an
// empty input box. A terminal with no screen to read, a screen that cannot be read or is blank, and the leftover of Coral's own text all count as a draft: nothing is known to be safe to lose.
func ScreenStopsSleep(ctx context.Context, term any, name, agentType, sessionID string) string {
	if _, ok := term.(ScreenReader); !ok {
		return SleepStopDraft
	}
	if r, ok := term.(ScreenReader); ok {
		if screen, err := r.AgentScreen(ctx, name, agentType, sessionID); err == nil && backgroundRunning.MatchString(screen) {
			return SleepStopBackground
		}
	}
	v := AutomatedInput{Term: term, Name: name, AgentType: agentType, SessionID: sessionID}.look(ctx)
	switch {
	case v.skip == SkipPrompt:
		return SleepStopDialog
	case v.skip != "" || v.leftover:
		return SleepStopDraft
	}
	return ""
}

// backgroundRunning: the footer words of a CLI with something running in the background after its turn ended ("1 shell still running", "· 1 shell ·", "1 monitor still running").
var backgroundRunning = regexp.MustCompile(`(?i)still running|\b\d+ (?:shells?|monitors?|background (?:tasks?|commands?))\b`)

// PanePIDer is implemented by the session terminals that can name the process an agent's terminal started, the root of its process tree (#12111): auto-sleep reads the tree's use of
// the CPU from it and treats a terminal that cannot as one it may not put to sleep.
type PanePIDer interface {
	PanePID(ctx context.Context, name, agentType, sessionID string) (int, error)
}
