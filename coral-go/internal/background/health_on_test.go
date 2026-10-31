package background

import "github.com/subgentic/coral/internal/board"

// healthOn is the default health settings with the check on: a team's check is off until it is turned on (#4962).
func healthOn() board.HealthSettings {
	h := board.DefaultHealthSettings()
	h.On = true
	h.HeartbeatMin = 5 // the older tests expect a check each time they look: a heartbeat as short as the interval says it every time (the quiet behaviour is in board_health_quiet_test.go, #11431)
	return h
}
