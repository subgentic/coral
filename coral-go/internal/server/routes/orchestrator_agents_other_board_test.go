package routes

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A member subscribed on this board whose live session is seated on ANOTHER board is not this board's agent: the seat can neither wake nor sleep it.
func TestTheSeatCannotReachAMemberWhoseSessionIsSeatedOnAnotherBoard(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	r.seat("Stray", "Developer", orchBoard, "claude", true, 6) // asleep, subscribed here
	r.seat("StrayAwake", "Developer", orchBoard, "claude", false, 7)
	r.setBoard(r.sid["Stray"], "other-board") // its live row is on another board now
	r.setBoard(r.sid["StrayAwake"], "other-board")
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	code, out := r.agentPost("Orchestrator", "wake", "Stray", "")
	assert.Equal(t, http.StatusNotFound, code, "%v", out)
	assert.True(t, r.asleep("Stray"), "nothing was woken")
	code, out = r.agentPost("Orchestrator", "sleep", "StrayAwake", "")
	assert.Equal(t, http.StatusNotFound, code, "%v", out)
	assert.False(t, r.asleep("StrayAwake"), "nothing was put to sleep")
}
