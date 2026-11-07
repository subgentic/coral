package background

import "github.com/subgentic/coral/internal/board"

// healthOn is the default health settings with the check on (the default since #14091; #4962 had it off) and a heartbeat as short as the interval, for the tests that expect a check each time.
func healthOn() board.HealthSettings {
	h := board.DefaultHealthSettings()
	h.On = true
	h.HeartbeatMin = 5 // the older tests expect a check each time they look: a heartbeat as short as the interval says it every time (the quiet behaviour is in board_health_quiet_test.go, #11431)
	return h
}
