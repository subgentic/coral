package routes

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/tmux"
)

// holdingTerm is a terminal whose gate holds text for why until the time in until (unix nanoseconds), then lets it through.
type holdingTerm struct {
	*agentTerm
	why   string
	until atomic.Int64
}

func (h *holdingTerm) AgentNoticeTarget(context.Context, string, string, string) (bool, bool, string, bool) {
	if time.Now().UnixNano() < h.until.Load() {
		return false, false, h.why, true
	}
	return true, false, "", true
}

// Security's #6911: the notice that follows Coral's own key is asked again while the gate holds it for a passing reason (a program the agent started reads the terminal), and typed
// once that passes; a lasting reason is not asked again.
func TestANoticeHeldForAPassingReasonIsAskedAgainAndTyped(t *testing.T) {
	oldEvery, oldFor := noticeRetryEvery, noticeRetryFor
	noticeRetryEvery, noticeRetryFor = 50*time.Millisecond, 2*time.Second
	t.Cleanup(func() { noticeRetryEvery, noticeRetryFor = oldEvery, oldFor })

	r := newTimeoutRig(t, "claude", "permission", claudeScreen(t, "permission_menu"))
	r.show(r.idle)
	term := &holdingTerm{agentTerm: r.term, why: tmux.ReasonChildReads}
	term.until.Store(time.Now().Add(300 * time.Millisecond).UnixNano())
	d, err := deliverNoticeRetrying(context.Background(), term, r.name, "claude", r.sid, dialogTimeoutNotice, "dialog timeout notice")
	require.NoError(t, err)
	assert.Equal(t, ptymanager.Sent, d, "typed once the hook ended")
	typed, _ := r.term.counts()
	assert.Equal(t, []string{dialogTimeoutNotice}, typed, "once")

	lasting := &holdingTerm{agentTerm: r.term, why: "the terminal's own shell is cmd"}
	lasting.until.Store(time.Now().Add(time.Hour).UnixNano())
	start := time.Now()
	d, _ = deliverNoticeRetrying(context.Background(), lasting, r.name, "claude", r.sid, dialogTimeoutNotice, "dialog timeout notice")
	assert.NotEqual(t, ptymanager.Sent, d)
	assert.Less(t, time.Since(start), time.Second, "a lasting reason is not asked again")

	passing := &holdingTerm{agentTerm: r.term, why: tmux.ReasonChildReads}
	passing.until.Store(time.Now().Add(time.Hour).UnixNano())
	start = time.Now()
	d, _ = deliverNoticeRetrying(context.Background(), passing, r.name, "claude", r.sid, dialogTimeoutNotice, "dialog timeout notice")
	assert.NotEqual(t, ptymanager.Sent, d)
	assert.GreaterOrEqual(t, time.Since(start), 1500*time.Millisecond, "a passing reason is asked again until the time runs out")
	typed, _ = r.term.counts()
	assert.Len(t, typed, 1, "nothing typed while held")
}
