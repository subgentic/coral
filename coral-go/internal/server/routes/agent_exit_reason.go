package routes

import (
	"context"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/secrets"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/redact"
)

// Why an agent stopped, in a few words (#15062). A turn that ended in an API error has its fixed label (exitLabel). Any other stop used to read just "exited", so an Operator seeing "Hermes Agent Investigation:
// exited" twice could not tell why. The reason now comes from what Coral knows, in this order: why it could not start (start_failure), the last error-looking line of the agent's terminal (the CLI's own words,
// redacted, one line, short), the reason Coral put it to sleep. A restart that happens again right after each start is said once.

const (
	exitReasonMax     = 90              // bytes of the CLI's own line kept
	exitReasonTimeout = 3 * time.Second // reading the terminal never holds the notice
	exitRapidWindow   = 6 * time.Minute // an exit this soon after the last start is "right after it starts" (the burst window comes first)
	exitSeenMax       = 1000            // sessions whose last notice is remembered
	exitScreenLines   = 25              // the bottom of the terminal that is looked at
)

// exitErrorLine matches the words of a CLI's last complaint: an error, a failure, a signal, a missing command.
var exitErrorLine = regexp.MustCompile(`(?i)\b(error|errors|failed|failure|fatal|panic|killed|terminated|aborted|segmentation fault|not found|permission denied|exit(ed)? (status|code)|signal \d+|out of memory)\b`)

// lastErrorLine is the newest error-looking line in the bottom of a terminal screen: control characters dropped, whitespace folded, redacted before it is cut, "" when there is none or the redactor is unavailable.
func lastErrorLine(screen string) string {
	lines := strings.Split(screen, "\n")
	if len(lines) > exitScreenLines {
		lines = lines[len(lines)-exitScreenLines:]
	}
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.Join(strings.Fields(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) && r != '\t' {
				return -1
			}
			return r
		}, lines[i])), " ")
		if line == "" || !exitErrorLine.MatchString(line) {
			continue
		}
		out, err := secrets.Redactor().Text([]byte(line))
		if err != nil {
			return ""
		}
		s := string(out)
		return strings.Clone(strings.TrimSpace(s[:redact.Cut(s, exitReasonMax)]))
	}
	return ""
}

// exitReason is the few words that say why a stopped agent stopped (see above). It never returns "".
func (h *SessionsHandler) exitReason(ctx context.Context, ls store.LiveSession) string {
	switch ptr.Value(ls.StartFailure) {
	case store.StartFailureCLIMissing:
		return "its CLI was not found"
	case store.StartFailureCLIPath:
		return "the CLI path in Settings can't be run"
	case store.StartFailureHermesGateway:
		return "Hermes refused to start its gateway"
	case store.StartFailureHermesSetup:
		return "Hermes's first-use setup failed"
	}
	if sr, ok := h.terminal.(ptymanager.ScreenReader); ok {
		rctx, cancel := context.WithTimeout(ctx, exitReasonTimeout)
		screen, err := sr.AgentScreen(rctx, naming.SessionName(ls.AgentType, ls.SessionID), ls.AgentType, ls.SessionID)
		cancel()
		if err == nil {
			if line := lastErrorLine(screen); line != "" {
				return "its last line was \"" + line + "\""
			}
		}
	}
	if ptr.Value(ls.SleepReason) == store.SleepReasonTerminalGone {
		return "its terminal was lost"
	}
	return "its CLI ended and left its terminal at a shell, with no error shown"
}

// exitSeen is what the last notice for a session said, so the same stop is not said again.
type exitSeen struct {
	launched string // the start (launched_at, else created_at) the notice was about
	label    string
	rapid    bool
}

func launchedOf(ls store.LiveSession) string {
	if s := ptr.Value(ls.LaunchedAt); s != "" {
		return s
	}
	return ls.CreatedAt
}

// exitPhrase is the label for a stopped agent whose turn did not fail, and whether the notice is a repeat to leave out: the same stop of the same start (something woke the agent without starting its CLI) is
// said once, and an agent that stops again right after each start is said once as "exits right after it starts".
func (h *SessionsHandler) exitPhrase(ls store.LiveSession, reason string, now time.Time) (label string, repeat bool) {
	launched := launchedOf(ls)
	label = "exited, " + reason
	rapid := false
	if t, err := time.Parse(store.ISOFormat, launched); err == nil && now.Sub(t) <= exitRapidWindow+exitBurstWindow {
		rapid = true
		label = "exits right after it starts: " + reason
	}
	h.exits.mu.Lock()
	defer h.exits.mu.Unlock()
	if h.exits.seen == nil || len(h.exits.seen) >= exitSeenMax {
		h.exits.seen = map[string]exitSeen{}
	}
	prev, ok := h.exits.seen[ls.SessionID]
	h.exits.seen[ls.SessionID] = exitSeen{launched: launched, label: label, rapid: rapid}
	if ok && prev.label == label && (prev.launched == launched || rapid) {
		return label, true
	}
	return label, false
}
