package tmux

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #408: a wrapper script that IS the resolved CLI. The shape of the coral-go-team's stand-in on macOS: ONE long-lived `/bin/sh ./oldstub.sh`, no children and no exec while it runs (read
// and printf are builtins). ps shows it as a shell, so the walk went through it, found no program, and the agent was never recorded: "no single foreground program stayed".

func withArgs(t *testing.T, args map[int][]string, cwd map[int]string) {
	t.Helper()
	oldA, oldC := programArgs, programCwd
	programArgs = func(pid int) []string { return args[pid] }
	programCwd = func(pid int) string { return cwd[pid] }
	t.Cleanup(func() { programArgs, programCwd = oldA, oldC })
}

func wrapperFixture(t *testing.T) (dir, cli string) {
	t.Helper()
	dir = t.TempDir()
	cli = filepath.Join(dir, "oldstub.sh")
	require.NoError(t, os.WriteFile(cli, []byte("#!/bin/sh\nread x\n"), 0o755))
	return dir, cli
}

func TestAWrapperThatStaysAliveWithNoChildrenIsTheAgent(t *testing.T) {
	dir, cli := wrapperFixture(t)
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" /bin/sh")

	// before: a shell by name with nothing under it shows no program, so nothing is recorded (the bug)
	_, ok := adoptCandidate(pane, 600)
	assert.False(t, ok, "without the rule a shell with no children shows no program")
	_, ok = adoptCandidate(pane, 600, wrapperIsCLI(cli))
	assert.False(t, ok, "no arguments readable: not matched")

	// the shape with an absolute script
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	got, ok := adoptCandidate(pane, 600, wrapperIsCLI(cli))
	require.True(t, ok)
	assert.Equal(t, AgentProc{PID: 700, Start: t1}, got)

	// the exact macOS shape: `/bin/sh ./oldstub.sh`, relative to the process's own directory
	withArgs(t, map[int][]string{700: {"/bin/sh", "./oldstub.sh"}}, map[int]string{700: dir})
	got, ok = adoptCandidate(pane, 600, wrapperIsCLI(cli))
	require.True(t, ok, "a relative script is made absolute with the process's directory")
	assert.Equal(t, 700, got.PID)

	// the same relative script when the directory cannot be read: not matched
	withArgs(t, map[int][]string{700: {"/bin/sh", "./oldstub.sh"}}, nil)
	_, ok = adoptCandidate(pane, 600, wrapperIsCLI(cli))
	assert.False(t, ok, "no directory, no proof")
}

func TestOnlyAShellRunningExactlyTheResolvedCLIIsTheAgent(t *testing.T) {
	dir, cli := wrapperFixture(t)
	other := filepath.Join(dir, "other.sh")
	require.NoError(t, os.WriteFile(other, []byte("#!/bin/sh\n"), 0o755))
	link := filepath.Join(dir, "link.sh")
	if err := os.Symlink(cli, link); err != nil {
		t.Log("no symlinks here:", err)
		link = cli
	}
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" sh")
	for name, tc := range map[string]struct {
		args  []string
		agent bool
	}{
		"the CLI file":                      {[]string{"sh", cli}, true},
		"the CLI file through a link":       {[]string{"sh", link}, true},
		"the CLI file with arguments":       {[]string{"sh", cli, "--resume", "x"}, true},
		"bash running the CLI file":         {[]string{"bash", cli}, true},
		"another script":                    {[]string{"sh", other}, false},
		"a flag before the script":          {[]string{"sh", "-x", cli}, false},
		"-c with the CLI path in a command": {[]string{"sh", "-c", cli}, false},
		"no script (an interactive shell)":  {[]string{"bash"}, false},
		"a program that is not a shell":     {[]string{"node", cli}, false},
		"an empty script argument":          {[]string{"sh", ""}, false},
		"a relative script with no cwd":     {[]string{"sh", "oldstub.sh"}, false},
		"a script that does not exist":      {[]string{"sh", filepath.Join(dir, "missing.sh")}, false},
	} {
		withArgs(t, map[int][]string{700: tc.args}, nil)
		_, ok := adoptCandidate(pane, 600, wrapperIsCLI(cli))
		assert.Equal(t, tc.agent, ok, name)
	}
	assert.Nil(t, wrapperIsCLI(""), "no resolved CLI recognises nothing")
	assert.Nil(t, wrapperIsCLI(filepath.Join(dir, "missing.sh")), "an unresolvable CLI recognises nothing")
}

// A wrapper that does NOT exec and starts the real CLI as a child: the wrapper is the program (as on Linux, where ps shows the script's name), and its children are its own tools.
func TestAWrapperThatStartsTheCLIAsAChildIsTheOneProgram(t *testing.T) {
	_, cli := wrapperFixture(t)
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" sh", "  701   700 S+   "+t1+" node", "  702   701 S+   "+t1+" git")
	progs, deep := programsBelow(pane, 600, wrapperIsCLI(cli))
	assert.Equal(t, []int{700}, progs)
	assert.False(t, deep)
	// A wrapper that EXECs is not a shell any more: the CLI is the process and the rule is not needed.
	execed := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" node")
	got, ok := adoptCandidate(execed, 600, wrapperIsCLI(cli))
	require.True(t, ok)
	assert.Equal(t, 700, got.PID)
}

// A person's nested shell stays a nested shell, with or without the rule, and a wrapper in the BACKGROUND is not a foreground program.
func TestTheRuleDoesNotTurnANestedShellIntoTheAgent(t *testing.T) {
	_, cli := wrapperFixture(t)
	withArgs(t, map[int][]string{710: {"bash"}, 700: {"/bin/sh", cli}}, nil)
	nested := table("  600     1 Ss   "+t0+" -zsh", "  710   600 S+   "+t1+" bash")
	_, ok := adoptCandidate(nested, 600, wrapperIsCLI(cli))
	assert.False(t, ok)
	c, why := candidateOf(nested, 600, wrapperIsCLI(cli))
	assert.Equal(t, Candidate{}, c)
	assert.Contains(t, why, "nothing is in the foreground")

	background := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S    "+t1+" sh")
	_, ok = adoptCandidate(background, 600, wrapperIsCLI(cli))
	assert.False(t, ok, "a wrapper that is not in the foreground")

	// the wrapper beside a program the person started: two programs, nothing adopted
	two := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" sh", "  720   600 S+   "+t1+" vim")
	_, ok = adoptCandidate(two, 600, wrapperIsCLI(cli))
	assert.False(t, ok)
}

// The notice check for a recorded wrapper: the same process (pid and start time) alone in the foreground is typed into; a second program, another start time or the wrapper gone is not.
func TestNoticesAreTypedIntoARecordedWrapperOnlyWhileItIsTheOneProgram(t *testing.T) {
	_, cli := wrapperFixture(t)
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	rec := AgentProc{PID: 700, Start: t1}
	recheck := wrapperIsCLI(cli)
	alone := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" sh")
	assert.True(t, decideNotice(alone, 600, rec, recheck).OK)

	assert.Equal(t, ReasonForeground, decideNotice(table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" sh", "  720   600 S+   "+t2+" vim"), 600, rec, recheck).Reason, "a second program")
	assert.Equal(t, ReasonGone, decideNotice(table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t2+" sh"), 600, rec, recheck).Reason, "a recycled pid: another start time")
	assert.Equal(t, ReasonGone, decideNotice(table("  600     1 Ss   "+t0+" -zsh"), 600, rec, recheck).Reason, "gone")
	assert.Equal(t, ReasonBackground, decideNotice(table("  600     1 Ss   "+t0+" -zsh", "  700   600 S    "+t1+" sh"), 600, rec, recheck).Reason, "stopped or in the background")
}

// A recorded process that is a shell is re-checked at EVERY notice: a wrapper that ends in `exec bash -i` keeps its pid and start time and is a person's shell from then on.
func TestARecordedWrapperThatBecomesAnInteractiveShellLosesTheAgent(t *testing.T) {
	_, cli := wrapperFixture(t)
	rec := AgentProc{PID: 700, Start: t1}
	recheck := wrapperIsCLI(cli)
	alone := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" bash")

	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	assert.True(t, decideNotice(alone, 600, rec, recheck).OK, "while it runs the CLI script")

	withArgs(t, map[int][]string{700: {"bash", "-i"}}, nil) // exec bash -i: same pid, same start time
	v := decideNotice(alone, 600, rec, recheck)
	assert.False(t, v.OK, "it is a person's shell now")
	assert.Equal(t, ReasonBackground, v.Reason)

	withArgs(t, map[int][]string{700: {"bash"}}, nil)
	assert.False(t, decideNotice(alone, 600, rec, recheck).OK, "bash with no script")

	// a person's program started in it: still not the agent
	withProgram := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" bash", "  701   700 S+   "+t2+" vim")
	assert.False(t, decideNotice(withProgram, 600, rec, recheck).OK)

	// no resolved CLI known (Coral restarted and lost the note): a recorded shell is not the agent; notices wait for a record
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	assert.False(t, decideNotice(alone, 600, rec).OK, "no recheck given")
	assert.False(t, decideNotice(alone, 600, rec, wrapperIsCLI("")).OK, "no CLI")

	// a recorded program that is not a shell is not re-checked this way
	node := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" node")
	assert.True(t, decideNotice(node, 600, rec).OK)
}

// Where the executable can be read it must be a shell too: the argument vector alone can be written by the program.
func TestAShellLookingArgumentVectorOnANonShellImageIsNotTheWrapper(t *testing.T) {
	_, cli := wrapperFixture(t)
	withArgs(t, map[int][]string{700: {"sh", cli}}, nil)
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" sh")
	old := programImage
	t.Cleanup(func() { programImage = old })

	programImage = func(int) string { return "/bin/sh" }
	_, ok := adoptCandidate(pane, 600, wrapperIsCLI(cli))
	assert.True(t, ok, "a shell image")
	programImage = func(int) string { return "" }
	_, ok = adoptCandidate(pane, 600, wrapperIsCLI(cli))
	assert.True(t, ok, "an image that cannot be read does not decide (the arguments do)")
	programImage = func(int) string { return "/usr/bin/node" }
	_, ok = adoptCandidate(pane, 600, wrapperIsCLI(cli))
	assert.False(t, ok, "a program that merely calls itself sh")
}

// The button and the bulk record see the wrapper too (they pass the resolved CLI), and record it without an acknowledgement.
func TestRecordAsAgentRecordsAWrapperThatIsTheCLI(t *testing.T) {
	const session = "claude-wrap"
	t.Cleanup(func() { ForgetAgentProc(session); agentRecs.Lock(); delete(agentRecs.m, session); agentRecs.Unlock() })
	_, cli := wrapperFixture(t)
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" sh")

	c, why := candidateOf(pane, 600)
	assert.Empty(t, c.PID, "without the CLI there is no program to offer")
	assert.NotEmpty(t, why)
	c, why = candidateOf(pane, 600, wrapperIsCLI(cli))
	assert.Empty(t, why)
	assert.Equal(t, 700, c.PID)
	assert.Empty(t, c.Under, "not under a nested shell")

	_, err := recordCandidate(pane, 600, session, AgentProc{PID: 700, Start: t1}, false, true, wrapperIsCLI(cli))
	require.NoError(t, err, "no acknowledgement is needed: it is the CLI itself")
	got, ok := AdoptedAgentProc(session)
	require.True(t, ok)
	assert.Equal(t, AgentProc{PID: 700, Start: t1}, got)
}

// The WHOLE gate (#408, the coral-go-team's live macOS run): a notice passes two checks, "has the agent exited" (ShellIdle, which decides a foreground shell is a nested one) and the recorded
// process (decideNotice). The wrapper must pass BOTH; before this only the second knew it. The table is served to ShellIdle as the process table of the moment.
func serveTable(t *testing.T, tb *procTable) {
	t.Helper()
	procTableMu.Lock()
	old := procTableLast
	procTableLast = tb
	procTableMu.Unlock()
	t.Cleanup(func() { procTableMu.Lock(); procTableLast = old; procTableMu.Unlock() })
}

func gate(t *testing.T, tb *procTable, rec AgentProc, cli string) (exited, nested bool, notice NoticeVerdict) {
	t.Helper()
	serveTable(t, tb)
	agent := wrapperIsCLI(cli)
	idle, _, err := ShellIdle(600, agent)
	require.NoError(t, err)
	sh, err := NestedShellOf(600, agent)
	require.NoError(t, err)
	return idle, sh != "", decideNotice(tb, 600, rec, agent)
}

func TestTheWrapperPassesTheWholeGateAndAPersonsShellScriptDoesNot(t *testing.T) {
	dir, cli := wrapperFixture(t)
	other := filepath.Join(dir, "other-script.sh")
	require.NoError(t, os.WriteFile(other, []byte("#!/bin/sh\n"), 0o755))
	rec := AgentProc{PID: 700, Start: t1}
	pane := table("  600     1 Ss   "+t0+" -zsh", "  700   600 S+   "+t1+" /bin/sh")

	// the wrapper, absolute and relative (the live macOS shape): not exited, not nested, notice OK
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	exited, nested, notice := gate(t, pane, rec, cli)
	assert.False(t, exited, "the agent has not exited: the wrapper is the agent")
	assert.False(t, nested, "and it is not a nested shell")
	assert.True(t, notice.OK)
	withArgs(t, map[int][]string{700: {"/bin/sh", "./oldstub.sh"}}, map[int]string{700: dir})
	exited, nested, notice = gate(t, pane, rec, cli)
	assert.False(t, exited)
	assert.False(t, nested)
	assert.True(t, notice.OK)

	// a person's `sh other-script.sh` is a nested shell through the WHOLE gate: exited-looking (nothing is the agent), nested, no notice. No name test, no "has a script argument" test.
	withArgs(t, map[int][]string{700: {"sh", other}}, nil)
	exited, nested, notice = gate(t, pane, rec, cli)
	assert.True(t, exited, "not the agent: the pane reads as back at a shell")
	assert.True(t, nested, "a shell a person started")
	assert.False(t, notice.OK)

	// the same with no resolved CLI known: nothing is recognised, so nothing is the agent
	withArgs(t, map[int][]string{700: {"/bin/sh", cli}}, nil)
	exited, nested, notice = gate(t, pane, rec, "")
	assert.True(t, exited)
	assert.True(t, nested)
	assert.False(t, notice.OK)

	// an interactive bash, and the wrapper after `exec bash -i`
	for _, args := range [][]string{{"bash"}, {"bash", "-i"}, {"sh", "-c", cli}, {"sh", "-x", cli}} {
		withArgs(t, map[int][]string{700: args}, nil)
		exited, nested, notice = gate(t, pane, rec, cli)
		assert.True(t, exited, "%v", args)
		assert.True(t, nested, "%v", args)
		assert.False(t, notice.OK, "%v", args)
	}

	// a wrapper that has exited leaves the bare prompt: exited, not nested, nothing recorded alive
	bare := table("  600     1 Ss+  " + t0 + " -zsh")
	exited, nested, notice = gate(t, bare, rec, cli)
	assert.True(t, exited)
	assert.False(t, nested)
	assert.False(t, notice.OK)
}
