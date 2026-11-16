package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #16958: a finished run keeps what its agent said last on its own record, so See result has something to show when the chat was not kept.
func TestAFinishedRunKeepsWhatItsAgentSaidLast(t *testing.T) {
	setTurnTimings(t, time.Hour, 0, -1)
	ctx, cancel := context.WithCancel(context.Background())
	e, rt, tr := turnEnv(t, "result-text")
	t.Cleanup(func() { cancel(); e.s.waitWatchers() })
	said := e.leftRun(t, time.Minute, "sid-said")
	silent := e.leftRun(t, time.Minute, "sid-silent")
	for _, sid := range []string{"sid-said", "sid-silent"} {
		rt.set("claude-"+sid, true)
		tr.set(sid, store.RunTurn{State: store.TurnDone, At: longAgo()})
	}
	e.s.SetResultReader(func(sessionID, _, _ string) string {
		if sessionID == "sid-said" {
			return "Summary: 3 files changed, tests pass."
		}
		return ""
	})
	e.s.reapStaleRuns(ctx)

	r := e.runOf(t, said)
	require.Equal(t, "completed", r.Status)
	require.NotNil(t, r.ResultText, "the run keeps its agent's last words")
	assert.Equal(t, "Summary: 3 files changed, tests pass.", *r.ResultText)
	assert.Nil(t, e.runOf(t, silent).ResultText, "a run whose agent said nothing keeps nothing")
}
