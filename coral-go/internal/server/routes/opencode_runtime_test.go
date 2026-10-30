package routes

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/opencode"
)

type fakeOpencode struct {
	state   opencode.State
	at      time.Time
	known   bool
	stopped []string
}

func (f *fakeOpencode) Ensure(context.Context, string) (*opencode.Server, error) {
	return nil, assert.AnError
}
func (f *fakeOpencode) AgentTurn(string) (opencode.State, time.Time, bool) {
	return f.state, f.at, f.known
}
func (f *fakeOpencode) Stop(key string) { f.stopped = append(f.stopped, key) }

func TestAnOpencodeAgentsTurnComesFromItsServersEventStream(t *testing.T) {
	now := time.Now()
	for _, tc := range []struct {
		state opencode.State
		want  string
	}{
		{opencode.StateWorking, "prompt_submit"},
		{opencode.StateIdle, "stop"},
		{opencode.StateFailed, "stop"},
		{opencode.StateNeedsInput, "permission_request"},
	} {
		h := &SessionsHandler{opencode: &fakeOpencode{state: tc.state, at: now, known: true}}
		in := &SessionStateInput{}
		h.applyTranscriptState(in, nil, at.Opencode, "name", "sid", "/w")
		require.Len(t, in.Events, 1, "%s", tc.state)
		assert.Equal(t, tc.want, in.Events[0].Type, "%s", tc.state)
	}
}

func TestAnOpencodeAgentWithNoServerOrNoStreamHasNoTurnAndLaunchesNothingWithoutOne(t *testing.T) {
	h := &SessionsHandler{}
	kind, _ := h.opencodeTurn("sid")
	assert.Empty(t, kind)
	h.opencode = &fakeOpencode{known: false}
	kind, _ = h.opencodeTurn("sid")
	assert.Empty(t, kind, "a stream that has named no session says nothing")

	h.opencode = nil
	_, err := h.launchCommand(context.Background(), agent.GetAgent(at.Opencode), agent.LaunchParams{SessionID: "sid"})
	assert.Error(t, err, "no server manager, no launch")
	h.opencode = &fakeOpencode{}
	_, err = h.launchCommand(context.Background(), agent.GetAgent(at.Opencode), agent.LaunchParams{SessionID: "sid"})
	assert.ErrorIs(t, err, assert.AnError, "a server that cannot start is the launch's error")
}
