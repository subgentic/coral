package tmux

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/terminalinput"
)

// Process tables in the shape ps -o pid=,ppid=,stat=,lstart=,comm= shows (#389). 600 is the pane's shell. The start times differ per process so a recycled pid can be told.
const (
	t0 = "Wed Oct 29 13:46:00 2026"
	t1 = "Wed Oct 29 13:46:05 2026"
	t2 = "Wed Oct 29 13:47:30 2026"
)

func table(lines ...string) *procTable {
	tb := parseProcTable(strings.Join(lines, "\n") + "\n")
	tb.at = time.Now()
	return tb
}

func TestParseProcTableReadsTheStartTime(t *testing.T) {
	tb := parseProcTable("  600     1 Ss   " + t0 + " -zsh\n  601   600 S+   " + t1 + " /Applications/Some App.app/Contents/MacOS/Some App\n  602   600 S+   old format\n")
	assert.Equal(t, procEntry{ppid: 1, stat: "Ss", comm: "-zsh", start: t0}, tb.byPID[600])
	assert.Equal(t, "/Applications/Some App.app/Contents/MacOS/Some App", tb.byPID[601].comm)
	assert.Equal(t, t1, tb.byPID[601].start)
	assert.Equal(t, procEntry{ppid: 600, stat: "S+", comm: "old format"}, tb.byPID[602], "a table without lstart parses as before")
}

func TestProgramsBelowListsTheTopForegroundPrograms(t *testing.T) {
	// zsh -> bash (waiting) -> sleep (fg); zsh -> node (bg); node's own child is not listed (the tools of a program are its own).
	tb := table(
		"  600     1 Ss   "+t0+" -zsh",
		"  601   600 S    "+t0+" bash",
		"  602   601 S+   "+t1+" sleep",
		"  603   600 S    "+t0+" node",
		"  604   602 S+   "+t1+" child-of-sleep",
	)
	progs, deep := programsBelow(tb, 600)
	assert.Equal(t, []int{602}, progs)
	assert.False(t, deep)
}

// The condition tests of the typing rule: each is named for the condition it checks, and dropping the condition from decideNotice fails the one named for it.
func TestDecideNoticeOneCasePerCondition(t *testing.T) {
	agent := AgentProc{PID: 700, Start: t1}
	pane := func(extra ...string) *procTable {
		return table(append([]string{"  600     1 Ss   " + t0 + " -zsh"}, extra...)...)
	}
	for _, tc := range []struct {
		name   string
		tb     *procTable
		reason string // "" = allowed
	}{
		{"the agent is the foreground program: allowed", pane("  700   600 S+   " + t1 + " claude"), ""},
		{"condition: the agent's own tool in the foreground group is the agent's", pane("  700   600 S+   "+t1+" claude", "  701   700 S+   "+t2+" git"), ""},
		{"condition: alive (the process is gone)", pane(), ReasonGone},
		{"condition: same start time (a recycled pid)", pane("  700   600 S+   " + t2 + " sleep"), ReasonGone},
		{"condition: in the foreground (the agent is stopped or in the background)", pane("  700   600 T    " + t1 + " claude"), ReasonBackground},
		{"condition: the only foreground program (a nested bash with sleep)", pane("  700   600 S    "+t1+" claude", "  710   600 S    "+t2+" bash", "  711   710 S+   "+t2+" sleep"), ReasonForeground},
		{"condition: the only foreground program (a hand-started CLI in a nested shell)", pane("  700   600 S    "+t1+" claude", "  710   600 S    "+t2+" bash", "  711   710 S+   "+t2+" claude"), ReasonForeground},
		{"condition: not behind too deep a tree", pane(append([]string{"  700   600 S+   " + t1 + " claude"}, deepShells(nestedShellDepth+3)...)...), ReasonForeground},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := decideNotice(tc.tb, 600, agent)
			assert.Equal(t, tc.reason == "", v.OK)
			assert.Equal(t, tc.reason, v.Reason)
		})
	}
}

func deepShells(n int) []string {
	var out []string
	parent := 600
	for i := 1; i <= n; i++ {
		out = append(out, fmt.Sprintf("  %d   %d S    %s bash", 600+i, parent, t0))
		parent = 600 + i
	}
	return out
}

func TestAdoptCandidateIsOnlyASingleForegroundProgram(t *testing.T) {
	pane := func(extra ...string) *procTable {
		return table(append([]string{"  600     1 Ss   " + t0 + " -zsh"}, extra...)...)
	}
	_, ok := adoptCandidate(pane(), 600)
	assert.False(t, ok, "none: nothing is adopted")
	_, ok = adoptCandidate(pane("  700   600 S+   "+t1+" claude", "  701   600 S+   "+t1+" codex"), 600)
	assert.False(t, ok, "two candidates: nothing is adopted")
	_, ok = adoptCandidate(pane("  700   600 S    "+t1+" claude"), 600)
	assert.False(t, ok, "a background program is not a candidate")
	_, ok = adoptCandidate(pane(append([]string{"  700   600 S+   " + t1 + " claude"}, deepShells(nestedShellDepth+3)...)...), 600)
	assert.False(t, ok, "a tree too deep to walk to the end adopts nothing, whatever single program was seen")
	p, ok := adoptCandidate(pane("  700   600 S+   "+t1+" claude"), 600)
	assert.True(t, ok)
	assert.Equal(t, AgentProc{PID: 700, Start: t1}, p)
	p, ok = adoptCandidate(pane("  710   600 S    "+t0+" bash", "  711   710 S+   "+t1+" node"), 600)
	assert.True(t, ok, "through a wrapper shell")
	assert.Equal(t, 711, p.PID)
}

// After a Coral restart the exact process kept in the tmux session is re-checked (#389): same pid, same start time, alive, below the pane's shell. Nothing is adopted from an image or an
// environment: the launch line exports CORAL_SESSION_NAME into the pane's shell, so a hand-started program carries it too.
func TestNoticeVerdictAfterARestartRechecksTheKeptProcess(t *testing.T) {
	const session = "claude-restart"
	t.Cleanup(func() { ForgetAgentProc(session); agentRecs.Lock(); delete(agentRecs.m, session); agentRecs.Unlock() })
	kept := func(p AgentProc) func() (AgentProc, bool) { return func() (AgentProc, bool) { return p, true } }
	none := func() (AgentProc, bool) { return AgentProc{}, false }
	forget := func() { agentRecs.Lock(); delete(agentRecs.m, session); agentRecs.Unlock() }

	running := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" claude")
	forget()
	v := noticeVerdict(running, 600, session, kept(AgentProc{PID: 700, Start: t1}))
	assert.True(t, v.OK, "the kept process is alive with the same start time and is the foreground program: re-adopted")
	got, ok := AdoptedAgentProc(session)
	assert.True(t, ok)
	assert.Equal(t, AgentProc{PID: 700, Start: t1}, got)

	forget()
	v = noticeVerdict(running, 600, session, kept(AgentProc{PID: 700, Start: t2}))
	assert.False(t, v.OK, "a recycled pid (another start time) is not the kept process")
	assert.Equal(t, ReasonGone, v.Reason)
	_, ok = AdoptedAgentProc(session)
	assert.False(t, ok, "nothing is adopted from it")

	forget()
	v = noticeVerdict(running, 600, session, none)
	assert.False(t, v.OK, "nothing kept (a hand-started program, whatever its name or environment): not adopted")
	assert.Equal(t, ReasonNotRecorded, v.Reason)
	_, ok = AdoptedAgentProc(session)
	assert.False(t, ok)

	forget()
	handStarted := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S    "+t1+" claude", "  710   600 S    "+t2+" bash", "  711   710 S+   "+t2+" node")
	v = noticeVerdict(handStarted, 600, session, kept(AgentProc{PID: 700, Start: t1}))
	assert.False(t, v.OK, "the kept agent is alive but a program in a nested shell is in the foreground: not typed")
	assert.Equal(t, ReasonForeground, v.Reason)

	forget()
	gone := table("  600     1 Ss+  " + t0 + " -zsh")
	assert.Equal(t, ReasonGone, noticeVerdict(gone, 600, session, kept(AgentProc{PID: 700, Start: t1})).Reason, "the kept process has ended")
}

func TestNoticeVerdictFollowsTheRecord(t *testing.T) {
	const session = "claude-v"
	t.Cleanup(func() { ForgetAgentProc(session); agentRecs.Lock(); delete(agentRecs.m, session); agentRecs.Unlock() })
	none := func() (AgentProc, bool) { return AgentProc{}, false }
	running := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" claude")

	v := noticeVerdict(running, 600, session, none)
	assert.False(t, v.OK)
	assert.Equal(t, ReasonNotRecorded, v.Reason, "nothing recorded and nothing kept: not typed")

	agentRecs.Lock()
	agentRecs.m[session] = &agentRec{adopting: true}
	agentRecs.Unlock()
	v = noticeVerdict(running, 600, session, none)
	assert.True(t, v.Wait, "the launch is moments old: wait")
	assert.Equal(t, ReasonAdopting, v.Reason)

	agentRecs.Lock()
	agentRecs.m[session] = &agentRec{proc: AgentProc{PID: 700, Start: t1}, adopted: true}
	agentRecs.Unlock()
	assert.True(t, noticeVerdict(running, 600, session, none).OK, "the recorded process is the foreground program")

	nested := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S    "+t1+" claude", "  710   600 S    "+t2+" bash", "  711   710 S+   "+t2+" sleep")
	assert.Equal(t, ReasonForeground, noticeVerdict(nested, 600, session, none).Reason, "a program in a nested shell keeps notices off")

	gone := table("  600     1 Ss+  " + t0 + " -zsh")
	assert.Equal(t, ReasonGone, noticeVerdict(gone, 600, session, none).Reason)

	// The CLI was replaced by a new process: not recorded again; paused, visibly, until a Wake.
	replaced := table("  600     1 Ss   "+t0+" -zsh", "  800   600 S+   "+t2+" claude")
	assert.Equal(t, ReasonGone, noticeVerdict(replaced, 600, session, none).Reason)
}

// On a real tmux pane: the launch line's process is recorded, notices are allowed while it is the foreground program, and not once something else is.
func TestAdoptAgentAfterLaunchOnARealPane(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	const sid = "7e9a1c43-5d6f-4182-8c3d-1f4a5b6c7d82"
	name := "claude-" + sid
	createTestSession(t, c, name, t.TempDir())
	t.Cleanup(func() { ForgetAgentProc(name) })
	verdict := func() NoticeVerdict {
		v, err := c.AgentNoticeVerdict(ctx, name, "claude", sid)
		require.NoError(t, err)
		return v
	}
	require.Eventually(t, func() bool {
		v, err := c.AgentNoticeVerdict(ctx, name, "claude", sid)
		return err == nil && v.Reason == ReasonNotRecorded
	}, shellWait, 25*time.Millisecond)

	// The "agent": a foreground program that stays (sleep stands in for the CLI), typed as a launch line is.
	require.NoError(t, c.SendKeysToTarget(ctx, terminalinput.Unclassified, name+".0", "CORAL_SESSION_NAME="+name+" sleep 120"))
	c.AdoptAgentAfterLaunch(name, name+".0")
	require.Eventually(t, func() bool { _, ok := AdoptedAgentProc(name); return ok }, shellWait, 50*time.Millisecond, "the agent's process was never recorded")
	assert.True(t, verdict().OK, "the recorded process is the foreground program")

	// The record is kept in the tmux session, which outlives a Coral restart: with nothing in memory, that exact process is re-checked and taken up again.
	require.Eventually(t, func() bool { _, ok := c.loadAgentProc(ctx, name, "claude", sid); return ok }, shellWait, 25*time.Millisecond, "the record was never kept in the tmux session")
	ForgetAgentProc(name) // what a restart does to Coral's memory
	_, inMemory := AdoptedAgentProc(name)
	assert.False(t, inMemory)
	assert.True(t, verdict().OK, "after a restart the kept process is re-checked and taken up")

	// It ends: the shell is back at its prompt; a program a person starts then is not the agent.
	require.NoError(t, c.SendRawKeys(ctx, terminalinput.Unclassified, name, []string{"C-c"}, "claude", sid))
	require.Eventually(t, func() bool { return verdict().Reason == ReasonGone }, shellWait, 25*time.Millisecond)
	require.NoError(t, c.SendKeysToTarget(ctx, terminalinput.Unclassified, name+".0", "bash --norc --noprofile"))
	pid, err := c.DisplayMessage(ctx, name+".0", "#{pane_pid}")
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		out, _ := exec.Command("pgrep", "-P", strings.TrimSpace(pid), "bash").Output()
		return strings.TrimSpace(string(out)) != ""
	}, shellWait, 25*time.Millisecond)
	require.NoError(t, c.SendKeysToTarget(ctx, terminalinput.Unclassified, name+".0", "sleep 120"))
	require.Eventually(t, func() bool { v := verdict(); return !v.OK && v.Reason != "" }, shellWait, 25*time.Millisecond)
	assert.NotEqual(t, ReasonAdopting, verdict().Reason)
}

// #137855: the launch call returns before the launch line is typed (and so before the watch begins), and a task created right after it asks for the verdict first: that is "not recorded YET", a wait,
// never a refusal, for launchGrace; after that, or once the watch has begun and found nothing, it is refused as before. Nothing is typed on this verdict.
func TestANoticeForASessionJustCreatedForALaunchWaitsUntilItsGraceEnds(t *testing.T) {
	const session = "claude-launching"
	t.Cleanup(func() { ForgetAgentProc(session); agentRecs.Lock(); delete(agentRecs.m, session); agentRecs.Unlock() })
	none := func() (AgentProc, bool) { return AgentProc{}, false }
	running := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" claude")
	old := launchGrace
	defer func() { launchGrace = old }()

	assert.Equal(t, ReasonNotRecorded, noticeVerdict(running, 600, session, none).Reason, "a session nobody launched is not waited for")

	NoteLaunching(session)
	v := noticeVerdict(running, 600, session, none)
	assert.True(t, v.Wait, "created a moment ago, the line not typed yet: wait")
	assert.False(t, v.OK, "and nothing is typed")
	assert.Equal(t, ReasonAdopting, v.Reason)

	launchGrace = time.Millisecond
	time.Sleep(5 * time.Millisecond)
	v = noticeVerdict(running, 600, session, none)
	assert.False(t, v.Wait, "a launch whose line never came is not waited for for ever")
	assert.Equal(t, ReasonNotRecorded, v.Reason)

	launchGrace = old
	NoteLaunching(session)
	assert.True(t, noticeVerdict(running, 600, session, none).Wait)
	ForgetAgentProc(session)
	assert.False(t, noticeVerdict(running, 600, session, none).Wait, "a session forgotten (killed, relaunched) is not waited for")

	agentRecs.Lock()
	agentRecs.m[session] = &agentRec{proc: AgentProc{PID: 700, Start: t1}, adopted: true, launchAt: time.Now()}
	agentRecs.Unlock()
	assert.True(t, noticeVerdict(running, 600, session, none).OK, "an adopted process decides, whatever launchAt says")
}
