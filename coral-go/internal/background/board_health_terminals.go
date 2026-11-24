package background

import (
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// A person's terminal opened in a team (New terminal, #266) is on the team's roster but is not an agent (#21170): it is nobody's to be idle, to wait, to be given the next task or to be peeked at, and it is not counted.
// What marks it is its session: a terminal's session name starts with its type, "terminal-" (naming.SessionName), and a live one says so in its AgentInfo. Both are checked, so a terminal that is not running any more is left out too.

// isTerminalMember says a subscriber is a person's terminal, not an agent.
func isTerminalMember(sub board.Subscriber, bySession map[string]AgentInfo) bool {
	if a, ok := bySession[sub.SessionName]; ok && a.AgentType == "terminal" {
		return true
	}
	return strings.HasPrefix(sub.SessionName, "terminal-")
}

// withoutTerminals is the members that are agents. bySession may be nil.
func withoutTerminals(subs []board.Subscriber, bySession map[string]AgentInfo) []board.Subscriber {
	kept := subs[:0:0]
	for _, s := range subs {
		if !isTerminalMember(s, bySession) {
			kept = append(kept, s)
		}
	}
	return kept
}
