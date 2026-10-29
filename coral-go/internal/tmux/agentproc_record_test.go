package tmux

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// "Record as agent" (#391): the Operator names the one foreground program of the pane; what was shown (pid and start time) must still be exactly that program.
func TestCandidateOfIsTheSingleForegroundProgramOrTheReasonThereIsNone(t *testing.T) {
	c, why := candidateOf(table("  600     1 Ss+  "+t0+" -zsh"), 600)
	assert.Equal(t, Candidate{}, c)
	assert.Contains(t, why, "nothing is in the foreground")

	_, why = candidateOf(table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" claude", "  701   600 S+   "+t1+" codex"), 600)
	assert.Contains(t, why, "several programs")

	_, why = candidateOf(table(append([]string{"  600     1 Ss   " + t0 + " -zsh", "  700   600 S+   " + t1 + " claude"}, deepShells(nestedShellDepth+3)...)...), 600)
	assert.Contains(t, why, "too deep")

	c, why = candidateOf(table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" node"), 600)
	assert.Empty(t, why)
	assert.Equal(t, Candidate{AgentProc: AgentProc{PID: 700, Start: t1}, Program: "node"}, c)
}

func TestRecordCandidateRecordsOnlyWhatWasShown(t *testing.T) {
	const session = "claude-rec"
	t.Cleanup(func() { ForgetAgentProc(session); agentRecs.Lock(); delete(agentRecs.m, session); agentRecs.Unlock() })
	forget := func() { agentRecs.Lock(); delete(agentRecs.m, session); agentRecs.Unlock() }
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" node")

	_, err := recordCandidate(pane, 600, session, AgentProc{PID: 701, Start: t1})
	assert.ErrorIs(t, err, ErrCandidateChanged, "another pid than the one shown")
	_, err = recordCandidate(pane, 600, session, AgentProc{PID: 700, Start: t2})
	assert.ErrorIs(t, err, ErrCandidateChanged, "a recycled pid: another start time")
	_, err = recordCandidate(pane, 600, session, AgentProc{})
	assert.ErrorIs(t, err, ErrCandidateChanged, "nothing shown")
	_, ok := AdoptedAgentProc(session)
	assert.False(t, ok, "none of the refused requests recorded anything")

	two := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" node", "  701   600 S+   "+t1+" bash-tool")
	_, err = recordCandidate(two, 600, session, AgentProc{PID: 700, Start: t1})
	assert.ErrorIs(t, err, ErrNoCandidate, "two foreground programs: nothing is guessed")

	got, err := recordCandidate(pane, 600, session, AgentProc{PID: 700, Start: t1})
	assert.NoError(t, err)
	assert.Equal(t, "node", got.Program)
	rec, ok := AdoptedAgentProc(session)
	assert.True(t, ok)
	assert.Equal(t, AgentProc{PID: 700, Start: t1}, rec)
	assert.True(t, noticeVerdict(pane, 600, session, nil).OK, "notices go now")

	// A nested shell's program is not the one recorded: the record names the pane's foreground program only.
	forget()
	nested := table("  600     1 Ss   "+t0+" -zsh", "  710   600 S    "+t2+" bash", "  711   710 S+   "+t2+" sleep")
	got, err = recordCandidate(nested, 600, session, AgentProc{PID: 711, Start: t2})
	assert.NoError(t, err, "the Operator may name the program in a nested shell: it is the single foreground program")
	assert.Equal(t, "sleep", got.Program)
}

func TestProgramBase(t *testing.T) {
	assert.Equal(t, "node", ProgramBase("/usr/local/bin/node"))
	assert.Equal(t, "claude.exe", ProgramBase(`C:\Users\x\claude.exe`))
	assert.Equal(t, "claude", ProgramBase("claude"))
}
