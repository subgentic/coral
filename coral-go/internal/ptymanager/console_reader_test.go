package ptymanager

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/tmux"
)

// A program the agent starts that reads the terminal (its standard input is the console) would take keys meant for the agent: no automated key while one is there. Classified by the
// standard input handle; anything that cannot be read counts as a reader; a known helper only when its handle is the console, its name is listed and its parent is the agent itself.
func TestAProgramTheAgentStartedThatReadsTheTerminalStopsAutomatedKeys(t *testing.T) {
	agent := winProc{pid: 300, start: 30}
	agentPane := func() *fakeProcs { return pane().add(root, 300, 30, kindProgram) }
	for _, tc := range []struct {
		name   string
		f      *fakeProcs
		reason string // "" = allowed
	}{
		{"a stranger with the console as its input (a shell the agent started)", agentPane().add(300, 400, 40, kindVerifiedShell).withStdin(400, stdinConsole), tmux.ReasonChildReads},
		{"a child whose input is a pipe (a tool run, an MCP server)", agentPane().add(300, 400, 40, kindProgram).withStdin(400, stdinNotConsole), ""},
		{"a child whose input cannot be read", agentPane().add(300, 400, 40, kindProgram).withStdin(400, stdinUnreadable), tmux.ReasonChildReads},
		{"a grandchild reader under a pipe-input child", agentPane().add(300, 400, 40, kindVerifiedShell).withStdin(400, stdinNotConsole).add(400, 500, 50, kindProgram).withStdin(500, stdinConsole), tmux.ReasonChildReads},
		{"the console host is not a reader", agentPane().add(300, 400, 40, kindConsoleHost).withStdin(400, stdinConsole), ""},
		{"a reused pid (created before its parent) is not the agent's", agentPane().add(300, 400, 5, kindProgram).withStdin(400, stdinConsole), ""},
		{"no child at all", agentPane(), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := decideWinNotice(tc.f, root, agent)
			assert.Equal(t, tc.reason == "", v.OK)
			assert.Equal(t, tc.reason, v.Reason)
		})
	}
}

func TestAKnownHelperIsLetThroughOnlyAsTheAgentsOwnChildReadingTheConsole(t *testing.T) {
	consoleHelpers["helperx"] = true
	t.Cleanup(func() { delete(consoleHelpers, "helperx") })
	agent := winProc{pid: 300, start: 30}
	named := func(f *fakeProcs, pid int) *fakeProcs {
		p := f.procs[pid]
		p.name = "helperx"
		f.procs[pid] = p
		return f
	}
	direct := named(pane().add(root, 300, 30, kindProgram).add(300, 400, 40, kindProgram).withStdin(400, stdinConsole), 400)
	assert.True(t, decideWinNotice(direct, root, agent).OK, "the listed helper, the agent's own child, its input the console")
	deeper := named(pane().add(root, 300, 30, kindProgram).add(300, 400, 40, kindVerifiedShell).add(400, 500, 50, kindProgram).withStdin(500, stdinConsole), 500)
	assert.Equal(t, tmux.ReasonChildReads, decideWinNotice(deeper, root, agent).Reason, "the same name one level down is not the agent's own helper")
	unreadable := named(pane().add(root, 300, 30, kindProgram).add(300, 400, 40, kindProgram).withStdin(400, stdinUnreadable), 400)
	assert.Equal(t, tmux.ReasonChildReads, decideWinNotice(unreadable, root, agent).Reason, "a name is not enough when the handle cannot be read")
}

func TestAWalkBelowTheAgentThatHitsItsBoundCountsAsAReader(t *testing.T) {
	f := pane().add(root, 300, 30, kindProgram)
	parent := 300
	for i := 0; i < maxWinWalkDepth+2; i++ {
		pid := 1000 + i
		f.add(parent, pid, int64(40+i), kindVerifiedShell).withStdin(pid, stdinNotConsole)
		parent = pid
	}
	assert.Equal(t, tmux.ReasonChildReads, decideWinNotice(f, root, winProc{pid: 300, start: 30}).Reason)
}

// Text is refused altogether where the terminal could run it: its own shell is cmd, the agent started a cmd anywhere below it, or a program below the agent reads the terminal. cmd runs a
// program from the current folder before PATH, so a line's first word, whatever it is, can run a file the repository holds.
func TestTextIsRefusedWhereTheTerminalCouldRunIt(t *testing.T) {
	agent := winProc{pid: 300, start: 30}
	named := func(f *fakeProcs, pid int, name string) *fakeProcs {
		p := f.procs[pid]
		p.name = name
		f.procs[pid] = p
		return f
	}
	for _, tc := range []struct {
		name     string
		f        *fakeProcs
		recorded bool
		why      string // "" = text may go
	}{
		{"the agent alone", pane().add(root, 300, 30, kindProgram), true, ""},
		{"a pipe-input tool below the agent", pane().add(root, 300, 30, kindProgram).add(300, 400, 40, kindProgram).withStdin(400, stdinNotConsole), true, ""},
		{"the terminal's own shell is cmd", named(pane(), root, "cmd").add(root, 300, 30, kindProgram), true, reasonCmdShell},
		{"the terminal's own shell is cmd, before the agent is recorded", named(pane(), root, "cmd"), false, reasonCmdShell},
		{"a cmd below the agent with a pipe as its input (an npx or .cmd shim running an MCP server)", named(pane().add(root, 300, 30, kindProgram).add(300, 400, 40, kindVerifiedShell).withStdin(400, stdinNotConsole), 400, "cmd"), true, ""},
		{"a cmd below the agent with the console as its input", named(pane().add(root, 300, 30, kindProgram).add(300, 400, 40, kindVerifiedShell).withStdin(400, stdinConsole), 400, "cmd"), true, tmux.ReasonChildReads},
		{"a console-input cmd two levels below the agent", named(pane().add(root, 300, 30, kindProgram).add(300, 400, 40, kindProgram).add(400, 500, 50, kindVerifiedShell).withStdin(500, stdinConsole), 500, "cmd"), true, tmux.ReasonChildReads},
		{"a console reader below the agent", pane().add(root, 300, 30, kindProgram).add(300, 400, 40, kindVerifiedShell).withStdin(400, stdinConsole), true, tmux.ReasonChildReads},
		{"before the agent is recorded, a PowerShell terminal", pane(), false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			refused, why := decideWinText(tc.f, root, agent, tc.recorded)
			assert.Equal(t, tc.why != "", refused)
			assert.Equal(t, tc.why, why)
		})
	}
	unreadable := pane()
	unreadable.procs[root] = winProc{pid: root, start: 10, known: false}
	refused, why := decideWinText(unreadable, root, agent, false)
	assert.True(t, refused, "a terminal whose shell cannot be read")
	assert.Equal(t, reasonUnreadable, why)
}

// textTerm is a terminal that says whether text is refused, and records what is typed.
type textTerm struct {
	refused bool
	typed   []string
}

func (t *textTerm) AgentTextRefused(context.Context, string, string, string) (bool, string) {
	return t.refused, "test"
}

func TestTheGateTypesNoTextWhereTheTerminalRefusesIt(t *testing.T) {
	for _, refused := range []bool{true, false} {
		term := &textTerm{refused: refused}
		in := AutomatedInput{Term: term, Name: "claude-0425-text", SessionID: "0425", Text: "You have a message", What: "test notice",
			Send: func(context.Context) error { term.typed = append(term.typed, "You have a message"); return nil }}
		got, err := DeliverAutomated(context.Background(), in)
		require.NoError(t, err)
		if refused {
			assert.Equal(t, Skipped, got)
			assert.Empty(t, term.typed, "nothing typed")
		} else {
			assert.Equal(t, Sent, got)
			assert.Len(t, term.typed, 1)
		}
		in.force = true // a person's own Send now is refused the same
		got, _ = DeliverAutomated(context.Background(), in)
		assert.Equal(t, refused, got == Skipped)
	}
}

// QA's #6908: a program that ended between the snapshot and its probe (a hook the agent ran) reads nothing: it is not a reader, and what runs below it is still walked.
func TestAProgramThatEndedBeforeItsProbeIsNotAReader(t *testing.T) {
	agent := winProc{pid: 300, start: 30}
	gone := pane().add(root, 300, 30, kindProgram).add(300, 400, 40, kindProgram).withStdin(400, stdinGone)
	assert.True(t, decideWinNotice(gone, root, agent).OK)
	refused, _ := decideWinText(gone, root, agent, true)
	assert.False(t, refused)
	below := pane().add(root, 300, 30, kindProgram).add(300, 400, 40, kindProgram).withStdin(400, stdinGone).add(400, 500, 50, kindProgram).withStdin(500, stdinConsole)
	assert.Equal(t, tmux.ReasonChildReads, decideWinNotice(below, root, agent).Reason, "a reader below an ended one is still found")
}
