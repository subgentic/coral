package ptymanager

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/tmux"
)

type readoptTerm struct {
	SessionTerminal
	ok, wait, known bool
	why             string
	readopted       int
}

func (r *readoptTerm) AgentNoticeTarget(context.Context, string, string, string) (bool, bool, string, bool) {
	return r.ok, r.wait, r.why, r.known
}
func (r *readoptTerm) ReadoptAgent(context.Context, string, string, string) { r.readopted++ }

// #11936: a Hermes pane's first foreground program is the one-minute preparation of its home, which Coral recorded as the agent; when it ended the record was "gone" and notices stayed paused though Hermes
// was running. Once the agent says it is ready, a record that is gone or was never made is made again, from what the pane runs now. A good record, one being made and a terminal that cannot tell are left alone.
func TestReadoptLostAgentOnlyForARecordThatIsGoneOrMissing(t *testing.T) {
	for _, tc := range []struct {
		name string
		term readoptTerm
		want int
	}{
		{"the recorded process ended", readoptTerm{known: true, why: tmux.ReasonGone}, 1},
		{"nothing was recorded", readoptTerm{known: true, why: tmux.ReasonNotRecorded}, 1},
		{"a good record", readoptTerm{known: true, ok: true}, 0},
		{"being recorded now", readoptTerm{known: true, wait: true, why: tmux.ReasonAdopting}, 0},
		{"the agent is not in the foreground: a person's program", readoptTerm{known: true, why: tmux.ReasonForeground}, 0},
		{"the terminal cannot tell", readoptTerm{known: false, why: tmux.ReasonGone}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			term := tc.term
			ReadoptLostAgent(context.Background(), &term, "hermes-x", "hermes", "sid")
			assert.Equal(t, tc.want, term.readopted)
		})
	}
	assert.NotPanics(t, func() { ReadoptLostAgent(context.Background(), nil, "n", "hermes", "s") })
	assert.NotPanics(t, func() { ReadoptLostAgent(context.Background(), &struct{ SessionTerminal }{}, "n", "hermes", "s") }, "a terminal with neither method")
}
