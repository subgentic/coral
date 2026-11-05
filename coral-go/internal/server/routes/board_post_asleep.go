package routes

import (
	"context"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// A post that @mentions an agent that will not read it now says so to the sender (#13189): only an agent put to sleep for being idle wakes on a delivery, so a message to one that is asleep (by the Operator, or
// because Coral stopped), whose terminal is gone, whose CLI exited or that is archived waits, and the sender used to be told nothing.

// Rest states of a member, from its live session.
const (
	restAsleep       = "asleep"
	restTerminalGone = "terminal_gone"
	restEnded        = "ended"
	restArchived     = "archived"
)

// SetMemberRestLookup tells the board how to find why a member's agent will not read a message now (SetMemberRestLookup's fn returns one of the rest states, or "" when it will: awake, asleep for being idle, or not known).
func (h *BoardHandler) SetMemberRestLookup(fn func(ctx context.Context, project, member string) string) {
	h.memberRest = fn
}

// MemberRestLookup is that lookup over the board and the sessions database: the member's subscription names its session, and that live row says whether it is archived, asleep (and why) or gone.
func MemberRestLookup(bs *board.Store, ss *store.SessionStore) func(ctx context.Context, project, member string) string {
	return func(ctx context.Context, project, member string) string {
		sub, err := bs.GetProjectSubscription(ctx, project, member)
		if err != nil || sub == nil {
			return ""
		}
		sid := naming.SessionIDFromName(sub.SessionName)
		if sid == "" {
			return ""
		}
		ls, err := ss.GetLiveSession(ctx, sid)
		if err != nil || ls == nil {
			return ""
		}
		switch {
		case ls.IsArchived != 0:
			return restArchived
		case ls.IsSleeping != 0:
			switch sleepReason(*ls) {
			case store.SleepReasonIdle:
				return "" // a delivery wakes it
			case store.SleepReasonTerminalGone:
				return restTerminalGone
			case store.SleepReasonAgentExited:
				return restEnded
			}
			return restAsleep
		}
		return ""
	}
}

// restSentence is what the sender is told about one recipient.
func restSentence(name, state string, mayWake bool) string {
	var s string
	switch state {
	case restTerminalGone:
		s = name + "'s terminal is gone; the message waits until it is restarted."
	case restEnded:
		s = name + " has ended (its CLI exited); the message waits until it is restarted."
	case restArchived:
		s = name + " is archived; the message waits until it is unarchived and woken."
	default:
		s = name + " is asleep; the message waits until it wakes."
		if mayWake {
			if safeCommandName.MatchString(name) { // written into a command only when every shell reads it the same: sh and PowerShell agree on single quotes round letters, digits, spaces, dots, hyphens and underscores (#13285)
				s += " The Operator's wake grant is on, so you may wake it: coral-board wake " + shellQuote(name) + "."
			} else {
				s += " The Operator's wake grant is on, so you may wake it with coral-board wake and its name." // a name with anything else is not put into a command at all
			}
		}
	}
	return s
}

// postRestNotes lists the recipients of a post that will not read it now, with the sentence for each. notified is who the post reaches by its text; "all" and the Operator are not agents with a session.
func (h *BoardHandler) postRestNotes(ctx context.Context, project, poster string, notified []string) []map[string]any {
	if h.memberRest == nil {
		return nil
	}
	var out []map[string]any
	mayWake := false
	checked := false
	for _, name := range notified {
		if strings.EqualFold(name, "all") || board.IsOperatorName(name) || board.SameIdentity(name, poster) {
			continue
		}
		state := h.memberRest(ctx, project, name)
		if state == "" {
			continue
		}
		if !checked && state == restAsleep { // an Orchestrator with the Operator's wake grant may wake the agent itself
			checked = true
			if sub, err := h.bs.GetProjectSubscription(ctx, project, poster); err == nil && isOrchestratorSubscriber(sub, poster) {
				if g, err := h.bs.GetOrchGrant(ctx, project); err == nil && g.Enabled {
					mayWake = true
				}
			}
		}
		out = append(out, map[string]any{"name": name, "state": state, "note": restSentence(name, state, mayWake && state == restAsleep)})
	}
	return out
}

// safeCommandName is a member name that is the same word in sh, bash, zsh and PowerShell once it is in single quotes: letters, digits, spaces, dots, hyphens and underscores. Any other name (a quote, $, a backtick,
// a semicolon, a slash) is never written into the suggested command.
var safeCommandName = regexp.MustCompile(`^[\p{L}\p{N} ._-]+$`)

// shellQuote is name as one word of a POSIX shell: in single quotes, a single quote in it written '\”. A member name may hold $, a backtick or a double quote inside it (only its ends are checked), and a
// sentence that suggests a command must not make a copy of it run anything (#13285). Go's own quoting is not a shell's.
func shellQuote(name string) string {
	return "'" + strings.ReplaceAll(name, "'", `'\''`) + "'"
}
