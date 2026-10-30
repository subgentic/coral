package tmux

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/terminalinput"
)

// shellWait bounds how long a pane may take to show a command as the foreground job or the shell as idle again.
// Starting the command and ps/pgrep each take a moment; 5 s was too tight for a machine under load (it failed in a
// 188 s full run), and a pass returns as soon as the state is seen, so a long bound costs nothing.
const shellWait = 20 * time.Second

func TestIsShellCommand(t *testing.T) {
	for _, c := range []string{"zsh", "-zsh", "bash", "sh", "/bin/zsh", "fish", "dash", "pwsh", "pwsh.exe", "cmd.exe", "ZSH", " bash "} {
		assert.True(t, IsShellCommand(c), c)
	}
	for _, c := range []string{"node", "claude", "codex", "gemini", "python3", "sleep", "vim", "", "zshrc", "bash-language-server"} {
		assert.False(t, IsShellCommand(c), c)
	}
}

// #3219: the agent CLI is typed into the pane's shell at launch. While it (or a
// wrapper script running it) runs, the shell has a child and is not idle; once it
// exits, the shell is idle at its prompt.
func TestAgentShellIdleFollowsTheCLI(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	const sid = "3a9e1c52-7b4d-4f0e-9c6a-2d8b1e5f4a70"
	name := "claude-" + sid
	createTestSession(t, c, name, t.TempDir())
	idle := func() bool {
		v, _, err := c.AgentShellIdle(ctx, name, "claude", sid)
		return err == nil && v
	}
	busy := func() bool {
		v, _, err := c.AgentShellIdle(ctx, name, "claude", sid)
		return err == nil && !v
	}

	require.Eventually(t, idle, shellWait, 25*time.Millisecond, "a fresh pane is at an idle shell prompt")

	// A long-running command stands in for the agent CLI.
	require.NoError(t, c.SendKeysToTarget(ctx, terminalinput.Unclassified, name+".0", "sleep 30"))
	require.Eventually(t, busy, shellWait, 25*time.Millisecond, "a running CLI keeps the shell busy")
	require.NoError(t, c.SendRawKeys(ctx, terminalinput.Unclassified, name, []string{"C-c"}, "claude", sid))
	require.Eventually(t, idle, shellWait, 25*time.Millisecond, "idle again once it exits")

	// A CLI started through a shell wrapper script shows 'sh' in the foreground: a shell the pane is in. Under the three-answer rule (#387) that is not the agent: nothing is typed as a
	// notice, and it is named as the nested shell. #389's recorded process is what tells a real wrapper around the CLI from a person's shell.
	require.NoError(t, c.SendKeysToTarget(ctx, terminalinput.Unclassified, name+".0", "sh -c 'sleep 30; true'"))
	require.Eventually(t, func() bool {
		sh, err := c.NestedShell(ctx, name, "claude", sid)
		return err == nil && sh != "" && idle()
	}, shellWait, 25*time.Millisecond, "a wrapper shell is nested: not the agent")
	require.NoError(t, c.SendRawKeys(ctx, terminalinput.Unclassified, name, []string{"C-c"}, "claude", sid))
	require.Eventually(t, idle, shellWait, 25*time.Millisecond)
}

func TestAgentShellIdleOfAGoneTerminal(t *testing.T) {
	c := newTestClient(t)
	_, _, err := c.AgentShellIdle(context.Background(), "claude-0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9", "claude", "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9")
	assert.True(t, errors.Is(err, ErrTerminalGone), "err = %v", err)
}

// #3268: a background job left in the shell after the agent CLI exits ('sleep &') is
// a child of the shell, but nothing is running in the foreground: the shell is still
// at its prompt, so the agent has exited and nothing may be typed into it.
func TestAgentShellIdleIgnoresBackgroundJobs(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	const sid = "5c7e9a21-3b4d-4f60-8a1b-9d2e3f4a5b60"
	name := "claude-" + sid
	createTestSession(t, c, name, t.TempDir())
	state := func() (bool, bool) {
		v, _, err := c.AgentShellIdle(ctx, name, "claude", sid)
		return v, err == nil
	}
	require.Eventually(t, func() bool { v, ok := state(); return ok && v }, shellWait, 25*time.Millisecond)

	// A job in the background: the shell is back at its prompt.
	require.NoError(t, c.SendKeysToTarget(ctx, terminalinput.Unclassified, name+".0", "sleep 60 &"))
	// The job exists: a sleep under the pane's shell. The pane's pid alone is there from the
	// start, so it said nothing about the job (#3788).
	pid, err := c.DisplayMessage(ctx, name+".0", "#{pane_pid}")
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		out, _ := exec.Command("pgrep", "-P", strings.TrimSpace(pid), "sleep").Output()
		return strings.TrimSpace(string(out)) != ""
	}, shellWait, 25*time.Millisecond, "the background sleep never started")
	time.Sleep(500 * time.Millisecond) // sleep-ok: a negative proof; the shell must still read as idle after the job has had time to be wrongly counted
	idle, ok := state()
	require.True(t, ok)
	assert.True(t, idle, "a background job is not the agent: the shell is idle")

	// A foreground command on top of the background job is still busy.
	require.NoError(t, c.SendKeysToTarget(ctx, terminalinput.Unclassified, name+".0", "sleep 30"))
	require.Eventually(t, func() bool { v, ok := state(); return ok && !v }, shellWait, 25*time.Millisecond, "a foreground command keeps the shell busy")
	require.NoError(t, c.SendRawKeys(ctx, terminalinput.Unclassified, name, []string{"C-c"}, "claude", sid))
	require.Eventually(t, func() bool { v, ok := state(); return ok && v }, shellWait, 25*time.Millisecond)
}

// #3728: the process table is read with one ps run; the command is the rest of the line, spaces
// included (a macOS command is a path).
func TestParseProcTable(t *testing.T) {
	out := "    1     0 Ss   /sbin/launchd\n" +
		"  500     1 S    /Applications/Some App.app/Contents/MacOS/Some App\n" +
		"  600   500 Ss   -zsh\n" +
		"  601   600 S+   claude\n" +
		"  602   600 S    sleep\n" +
		"garbage line\n"
	tb := parseProcTable(out)
	assert.Equal(t, "/Applications/Some App.app/Contents/MacOS/Some App", tb.byPID[500].comm)
	assert.Equal(t, procEntry{ppid: 600, stat: "S+", comm: "claude"}, tb.byPID[601])
	assert.ElementsMatch(t, []int{601, 602}, tb.children[600])
	assert.Len(t, tb.byPID, 5)
}

// #3728: the checks of many agents made together share one ps run.
func TestShellIdleSharesOneProcessSnapshot(t *testing.T) {
	skipWithoutUnixTmux(t)
	procTableMu.Lock()
	procTableLast = nil
	procTableMu.Unlock()
	before := procTableRuns.Load()
	for i := 0; i < 20; i++ {
		_, _, err := ShellIdle(os.Getpid())
		require.NoError(t, err)
	}
	assert.Equal(t, int64(1), procTableRuns.Load()-before, "one ps run for twenty checks")
	_, _, err := ShellIdle(1 << 30)
	assert.ErrorContains(t, err, "no such process")
}

// #5171, #5170: a shell started since the shared process snapshot (a restart's new terminal) is looked up again, not reported as unknown (which
// counted as a running agent and let automated text be typed into a bare shell).
func TestShellIdleLooksAgainForAShellThatStartedAfterTheSnapshot(t *testing.T) {
	skipWithoutUnixTmux(t)
	procTableMu.Lock()
	procTableLast = &procTable{byPID: map[int]procEntry{}, children: map[int][]int{}, at: time.Now().Add(-500 * time.Millisecond)}
	procTableMu.Unlock()
	_, _, err := ShellIdle(os.Getpid())
	require.NoError(t, err, "the process is real: a snapshot without it is stale")
	_, _, err = ShellIdle(1 << 30)
	assert.ErrorContains(t, err, "no such process", "a pid that does not exist still does not")
}

// A pid that is not there (a pane that is gone) makes one fresh process-table read a second, not one per check.
func TestShellIdleFreshLookIsLimitedPerPidPerSecond(t *testing.T) {
	skipWithoutUnixTmux(t)
	const gone = 1<<30 + 12345
	freshLookMu.Lock()
	delete(freshLooks, gone)
	freshLookMu.Unlock()
	before := procTableRuns.Load()
	for i := 0; i < 5; i++ {
		procTableMu.Lock()
		procTableLast = &procTable{byPID: map[int]procEntry{}, children: map[int][]int{}, at: time.Now().Add(-500 * time.Millisecond)} // stale each time
		procTableMu.Unlock()
		_, _, err := ShellIdle(gone)
		require.ErrorContains(t, err, "no such process")
	}
	assert.Equal(t, int64(1), procTableRuns.Load()-before, "one fresh ps run for five checks of a pid that is not there")
}

// #387/#388 (Security's three answers): ShellRunning is a foreground non-shell program that is a direct child of the pane's shell, the agent; ShellBare is a prompt with nothing in it;
// ShellNested is any shell below the pane's shell that the terminal is in, whatever runs in it: not the agent, so nothing is typed as a notice and no launch line either. The tables have the
// shape ps shows with job control: the innermost interactive shell at its prompt is in the foreground ('+'), a shell that waits for a command, or runs one, is not (the command is).
func TestShellStateThreeAnswers(t *testing.T) {
	prev := procTableLast
	t.Cleanup(func() { procTableMu.Lock(); procTableLast = prev; procTableMu.Unlock() })
	// chain: the pane's shell 600, then n shells each started in the previous one; the innermost has the foreground only when it is at its prompt (below == "").
	chain := func(n int, below string) string {
		out := "  600     1 Ss+  -zsh\n"
		if n > 0 || below != "" {
			out = "  600     1 Ss   -zsh\n"
		}
		for i := 1; i <= n; i++ {
			stat := "S"
			if i == n && below == "" {
				stat = "S+"
			}
			out += fmt.Sprintf("  %d   %d %-4s bash\n", 600+i, 600+i-1, stat)
		}
		if below != "" {
			out += fmt.Sprintf("  700   %d %s\n", 600+n, below)
		}
		return out
	}
	for _, tc := range []struct {
		name  string
		ps    string
		state ShellState
	}{
		{"the pane's shell alone", chain(0, ""), ShellBare},
		{"a bash a person started, at its prompt", chain(1, ""), ShellNested},
		{"a bash in a bash in a bash, at the prompt", chain(3, ""), ShellNested},
		{"the agent CLI is a direct foreground child", "  600     1 Ss   -zsh\n  601   600 S+   claude\n", ShellRunning},
		{"sleep running in a nested bash (the bash has no +, the sleep has): not the agent", chain(1, "S+   sleep"), ShellNested},
		{"a program two shells deep: not the agent", chain(2, "S+   node"), ShellNested},
		{"a CLI started by a wrapper script (bash with +, then node): nested, as Security noted, #389 closes it", "  600     1 Ss   -zsh\n  601   600 S+   bash\n  602   601 S+   node\n", ShellNested},
		{"a background job of a nested bash at its prompt", chain(1, "") + "  700   601 S    sleep\n", ShellNested},
		{"a background job under the pane's shell, nested bash at its prompt", chain(1, "") + "  700   600 S    sleep\n", ShellNested},
		{"a stopped program in the foreground of a nested bash", chain(1, "T+   vim"), ShellNested},
		{"the agent running its own bash tool is still the agent", "  600     1 Ss   -zsh\n  601   600 S+   claude\n  602   601 S+   bash\n  603   602 S+   sleep\n", ShellRunning},
		{"a direct foreground program wins over a nested shell beside it", "  600     1 Ss   -zsh\n  601   600 S+   claude\n  602   600 S    bash\n", ShellRunning},
		{"a nested bash without + and nothing below it (a background shell)", "  600     1 Ss+  -zsh\n  601   600 S    bash\n", ShellBare},
		{"a background job of the pane's shell alone", "  600     1 Ss+  -zsh\n  601   600 S    sleep\n", ShellBare},
		{"too many shells deep to walk: nested", chain(nestedShellDepth+3, "S+   sleep"), ShellNested},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tb := parseProcTable(tc.ps)
			tb.at = time.Now()
			procTableMu.Lock()
			procTableLast = tb
			procTableMu.Unlock()
			state, nested := classifyShell(tb, 600)
			assert.Equal(t, tc.state, state)
			assert.Equal(t, tc.state == ShellNested, nested != "", "the nested shell is named when there is one")
			idle, shell, err := ShellIdle(600)
			require.NoError(t, err)
			assert.Equal(t, tc.state != ShellRunning, idle, "ShellIdle: only the agent running is not idle")
			assert.Equal(t, "-zsh", shell)
			name, err := NestedShellOf(600)
			require.NoError(t, err)
			assert.Equal(t, nested, name)
		})
	}
	// A loop in the table (never real) ends the walk instead of hanging it.
	loop := parseProcTable("  600     1 Ss   -zsh\n  601   600 S    bash\n")
	loop.children[601] = append(loop.children[601], 600)
	assert.NotPanics(t, func() { classifyShell(loop, 600) })
	// The terminal's process is the agent itself (exec'd, not a shell): not idle, with or without children.
	tb := parseProcTable("  600     1 Ss+  claude\n")
	tb.at = time.Now()
	procTableMu.Lock()
	procTableLast = tb
	procTableMu.Unlock()
	idle, _, err := ShellIdle(600)
	require.NoError(t, err)
	assert.False(t, idle)
}

// #387 on a real tmux pane: a bash started at the prompt is a bare prompt; a program in it is busy; Ctrl-C and the program is gone, idle again.
func TestAgentShellIdleANestedBashIsABarePrompt(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	const sid = "6d8f0b32-4c5e-4071-9b2c-0e3f4a5b6c71"
	name := "claude-" + sid
	createTestSession(t, c, name, t.TempDir())
	state := func() (bool, bool) {
		v, _, err := c.AgentShellIdle(ctx, name, "claude", sid)
		return v, err == nil
	}
	require.Eventually(t, func() bool { v, ok := state(); return ok && v }, shellWait, 25*time.Millisecond)

	require.NoError(t, c.SendKeysToTarget(ctx, terminalinput.Unclassified, name+".0", "bash --norc --noprofile"))
	pid, err := c.DisplayMessage(ctx, name+".0", "#{pane_pid}")
	require.NoError(t, err)
	require.Eventually(t, func() bool { // the nested bash exists under the pane's shell
		out, _ := exec.Command("pgrep", "-P", strings.TrimSpace(pid), "bash").Output()
		return strings.TrimSpace(string(out)) != ""
	}, shellWait, 25*time.Millisecond, "the nested bash never started")
	time.Sleep(procTableTTL + 200*time.Millisecond) // sleep-ok: a negative proof; past the process table cache (procTableTTL), so the check reads a fresh table
	idle, ok := state()
	require.True(t, ok)
	assert.True(t, idle, "a bash a person started is a bare prompt, not the agent")

	nested, err := c.NestedShell(ctx, name, "claude", sid)
	require.NoError(t, err)
	assert.Equal(t, "bash", nested, "the nested shell is named (a launch line is refused with it)")

	// A program in the nested bash is not the agent either: still "not the agent" (nothing typed), and still named.
	require.NoError(t, c.SendKeysToTarget(ctx, terminalinput.Unclassified, name+".0", "sleep 30"))
	require.Eventually(t, func() bool {
		out, _ := exec.Command("pgrep", "-x", "sleep").Output()
		return strings.TrimSpace(string(out)) != ""
	}, shellWait, 25*time.Millisecond, "the sleep never started")
	time.Sleep(procTableTTL + 200*time.Millisecond) // sleep-ok: a negative proof; past the process table cache (procTableTTL), so the check reads a fresh table
	idle, ok = state()
	require.True(t, ok)
	assert.True(t, idle, "a program in a nested bash is not the agent: nothing is typed")
	nested, err = c.NestedShell(ctx, name, "claude", sid)
	require.NoError(t, err)
	assert.Equal(t, "bash", nested)
	require.NoError(t, c.SendRawKeys(ctx, terminalinput.Unclassified, name, []string{"C-c"}, "claude", sid))
}
