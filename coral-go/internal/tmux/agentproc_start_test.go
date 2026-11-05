package tmux

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// ps's lstart on Linux is the boot time plus the process's start ticks, and the boot time it uses can move by a second between two reads under load (#13409): the same
// process then reads as another, and notices stop with "the agent's process has ended". The same process read a second apart is the same process; a recycled pid starts later.
func TestAProcessWhoseStartTimeMovesBySecondsUnderLoadIsStillTheSameProcess(t *testing.T) {
	agent := AgentProc{PID: 700, Start: "Wed Oct 29 13:46:00 2026"}
	pane := func(start string) *procTable {
		return table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+start+" claude")
	}
	for _, start := range []string{"Wed Oct 29 13:46:01 2026", "Wed Oct 29 13:45:59 2026", "Wed Oct 29 13:46:02 2026"} {
		v := decideNotice(pane(start), 600, agent)
		assert.True(t, v.OK, "start read as %s", start)
	}
	for _, start := range []string{"Wed Oct 29 13:46:03 2026", "Wed Oct 29 13:46:05 2026", "Wed Oct 29 13:47:30 2026", "Thu Oct 30 13:46:00 2026", "", "garbage"} {
		v := decideNotice(pane(start), 600, agent)
		assert.Equal(t, ReasonGone, v.Reason, "start read as %q is another process", start)
	}
}

func TestSameStartTimes(t *testing.T) {
	assert.True(t, sameStart("Wed Oct 29 13:46:00 2026", "Wed Oct 29 13:46:00 2026"))
	assert.True(t, sameStart("Wed Oct 29 13:46:00 2026", "Wed Oct 29 13:46:01 2026"))
	assert.True(t, sameStart("Wed Oct 29 23:59:59 2026", "Thu Oct 30  0:00:00 2026"), "across midnight")
	assert.True(t, sameStart("Wed Oct  7 13:46:00 2026", "Wed Oct  7 13:46:01 2026"), "a one-digit day is padded with a space")
	assert.False(t, sameStart("Wed Oct 29 13:46:00 2026", "Wed Oct 29 13:46:03 2026"))
	assert.True(t, sameStart("", ""), "a table without start times compares as it always did")
	assert.True(t, sameStart("x", "x"), "identical text is the same")
	assert.False(t, sameStart("", "Wed Oct 29 13:46:00 2026"))
	assert.False(t, sameStart("x", "y"), "unparsable and different")
}

// The shown candidate and the table read a moment later may differ by a second for the same process (#13409): the record is still made.
func TestRecordCandidateAcceptsTheSameProcessReadASecondApart(t *testing.T) {
	const session = "claude-rec-13409"
	t.Cleanup(func() { ForgetAgentProc(session); agentRecs.Lock(); delete(agentRecs.m, session); agentRecs.Unlock() })
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   Wed Oct 29 13:46:06 2026 node")
	_, err := recordCandidate(pane, 600, session, AgentProc{PID: 700, Start: t1}, true, true)
	assert.NoError(t, err)
}
