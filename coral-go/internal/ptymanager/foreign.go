package ptymanager

import (
	"errors"
	"sync/atomic"
)

// A FOREIGN Coral is one that cannot show that sessions.db is its own data folder's (internal/dataowner, task #429): a copy of a live database. It types nothing by itself: the gate below is
// checked by every automated sender (DeliverAutomated, AutoAcceptSend) and by the dialog switches' own keys, so a Coral started on a copy cannot reach the REAL agents' panes on a shared tmux
// server, or answer, close or nudge anything. A person's own input from the dashboard and an explicit Wake are not automated and are not held.

// ErrForeign is why an automated send was refused. Its words are fixed.
var ErrForeign = errors.New("this Coral does not own this data folder")

var foreign atomic.Bool

// SetForeign records, once at startup before anything acts on the agents, whether this Coral is FOREIGN.
func SetForeign(v bool) { foreign.Store(v) }

// Foreign reports whether this Coral is FOREIGN.
func Foreign() bool { return foreign.Load() }

// RefuseIfForeign is the check every automated sender makes first: ErrForeign for a FOREIGN Coral, nil otherwise.
func RefuseIfForeign() error {
	if foreign.Load() {
		return ErrForeign
	}
	return nil
}
