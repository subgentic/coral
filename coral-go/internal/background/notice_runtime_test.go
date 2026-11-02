package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/ptymanager"
)

// Every runtime this package types through must answer the notice check, or the nudge, the scheduler's prompt and the other automated senders of this package type into a terminal whose
// foreground is not the agent (QA's #389 reruns: a board_notifier nudge was typed into a person's cat and a nested cmd while the routes' notices were withheld).
var (
	_ ptymanager.NoticeTargetChecker = (*TmuxRuntime)(nil)
	_ ptymanager.NoticeTargetChecker = (*PTYRuntime)(nil)
)

// noticeRuntime is a runtime whose agent has not exited but whose terminal's foreground is not the agent.
type noticeRuntime struct {
	*fgReconRuntime
	ok, wait bool
	why      string
}

func (n noticeRuntime) AgentNoticeTarget(context.Context, string, string, string) (bool, bool, string, bool) {
	return n.ok, n.wait, n.why, true
}

// A nudge goes through skipIfAgentExited: the agent has not exited, yet nothing is typed while the terminal is not running it.
func TestSkipIfAgentExitedAlsoWithholdsFromATerminalThatIsNotRunningTheAgent(t *testing.T) {
	_, rt, _ := newExitedFixture(t)
	const name = "claude-11111111-2222-3333-4444-555555555555"
	rt.set(name, "node") // the agent CLI is the foreground program: not exited
	ctx := context.Background()

	assert.False(t, skipIfAgentExited(ctx, rt, nil, name, "board nudge"), "no notice check on this runtime: as before")
	assert.True(t, skipIfAgentExited(ctx, noticeRuntime{fgReconRuntime: rt, why: "the terminal's foreground program is not the agent"}, nil, name, "board nudge"),
		"a terminal that is not running the agent gets no nudge")
	// A terminal that keeps saying "starting" is held until the hold limit (15 s by default) and then withheld; the hold ends the same way when the caller's context ends, so this case gives it 150 ms:
	// the same answer by the same path without sleeping the default. The limit itself is reached in ptymanager's TestANoticeForAnAgentJustLaunchedIsHeldUntilItsProcessIsRecorded.
	holdCtx, stop := context.WithTimeout(ctx, 150*time.Millisecond)
	defer stop()
	assert.True(t, skipIfAgentExited(holdCtx, noticeRuntime{fgReconRuntime: rt, wait: true, why: "starting"}, nil, name, "board nudge"), "while the agent's process is being recorded")
	assert.False(t, skipIfAgentExited(ctx, noticeRuntime{fgReconRuntime: rt, ok: true}, nil, name, "board nudge"), "the recorded agent is the foreground program: the nudge goes")
}
