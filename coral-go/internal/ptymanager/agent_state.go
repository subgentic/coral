package ptymanager

import "time"

// An agent's turn state from its hook events, for the one reader left: a person's chat message is held while the agent's own signals say
// it waits on a box that asks the person (#6610, internal/server/routes/human_send_hold.go). Automated input does not read it (#7727).

// TurnState is an agent's turn state from its hook events.
type TurnState int

const (
	StateUnknown TurnState = iota
	StateStarting
	StateIdle
	StateInTurn
	StateBlocked
	StateGone
)

func (s TurnState) String() string {
	switch s {
	case StateStarting:
		return "starting"
	case StateIdle:
		return "idle"
	case StateInTurn:
		return "in_turn"
	case StateBlocked:
		return "blocked"
	case StateGone:
		return "gone"
	}
	return "unknown"
}

// AgentState is what the server knows about a session from its signals.
type AgentState struct {
	State TurnState
	// Kind is why it is Blocked: permission, question, plan or elicitation.
	Kind string
	// Since is when it entered State; LastEvent is the session's latest event.
	Since, LastEvent time.Time
	// LastStop is the latest end of a turn (Stop, Interrupt or a transcript record),
	// for the PTY rule (no person typed since).
	LastStop time.Time
	// ToolPending: a tool call started and hasn't finished (agy and pi, which have no
	// prompt signal: a prompt can only be open in that window).
	ToolPending bool
	CLIVersion  string
}
