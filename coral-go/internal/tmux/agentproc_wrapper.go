package tmux

import (
	"path/filepath"
	"strings"
	"sync"
)

// A wrapper script that is the resolved CLI (#408). A CLI that is a `#!/bin/sh` script runs as a SHELL by name (macOS ps shows `sh`, Linux the script's name): the walk below the pane's
// shell goes through shells, so a wrapper that stays alive and starts nothing of its own (it blocks in a builtin) showed no foreground program at all, and nothing was ever recorded. The one
// narrow rule: a foreground shell whose script argument is EXACTLY the resolved CLI file is the agent itself, not a shell to walk through. A shell running any other script, a shell with a
// flag before the script, or a shell with no script (a person's bash, an interactive one) stays what it was: a nested shell.

// programArgs and programCwd are the readers of a process's arguments and working directory (a test replaces them).
var (
	programArgs = ProgramArgs
	programCwd  = ProgramCwd
	// programImage is the program's executable file ("" when it cannot be read).
	programImage = ProgramImage
)

// wrapperIsCLI is the check for a shell pid: its argument vector is [shell, script, ...] with no flag before the script, and the script (made absolute with the process's own working
// directory when it is relative, as `./stub.sh` is) is the same file as cli by realpath. nil when cli is unknown, which recognises nothing. The arguments are compared and dropped. On
// macOS ps joins the arguments with blanks, so a script path with a blank in it is split and is never matched (the person records it with the button).
func wrapperIsCLI(cli string) func(pid int) bool {
	if cli == "" {
		return nil
	}
	want, err := filepath.EvalSymlinks(cli)
	if err != nil {
		return nil
	}
	want = filepath.Clean(want)
	return func(pid int) bool {
		args := programArgs(pid)
		if len(args) < 2 || !IsShellCommand(args[0]) {
			return false
		}
		if img := programImage(pid); img != "" && !IsShellCommand(img) {
			return false // the argument vector says shell, the executable does not (argv[0] can be rewritten): not the wrapper
		}
		script := args[1]
		if script == "" || strings.HasPrefix(script, "-") {
			return false
		}
		if !filepath.IsAbs(script) {
			cwd := programCwd(pid)
			if cwd == "" {
				return false
			}
			script = filepath.Join(cwd, script)
		}
		got, err := filepath.EvalSymlinks(script)
		return err == nil && filepath.Clean(got) == want
	}
}

func firstAgent(agent []func(pid int) bool) func(pid int) bool {
	if len(agent) == 0 {
		return nil
	}
	return agent[0]
}

// launchCLIs is the resolved CLI path each session's last launch line was built for (kept in memory; the adoption watch reads it).
var launchCLIs = struct {
	sync.Mutex
	m map[string]string
}{m: map[string]string{}}

// cliStore keeps the same note with the session in the database, so it survives a Coral restart (set once at start-up; nil in the tests that do not need it).
var cliStore struct {
	sync.Mutex
	save func(session, cli string)
	load func(session string) string
}

// SetLaunchCLIStore sets how the note is kept (save; "" removes it) and read back (load; "" when there is none).
func SetLaunchCLIStore(save func(session, cli string), load func(session string) string) {
	cliStore.Lock()
	defer cliStore.Unlock()
	cliStore.save, cliStore.load = save, load
}

// NoteLaunchCLI keeps the CLI path a session was just launched with, or recorded as the agent with, in memory and in the database ("" forgets it).
func NoteLaunchCLI(session, cli string) {
	launchCLIs.Lock()
	if cli == "" {
		delete(launchCLIs.m, session)
	} else {
		launchCLIs.m[session] = cli
	}
	launchCLIs.Unlock()
	cliStore.Lock()
	save := cliStore.save
	cliStore.Unlock()
	if save != nil {
		save(session, cli)
	}
}

// launchCLIOf is the session's CLI path: from memory, else from the database (after a Coral restart), and then kept in memory. "" when neither has it (a session from before this was kept):
// a recorded shell is then not the agent, and its notices wait for a record.
func launchCLIOf(session string) string {
	launchCLIs.Lock()
	cli := launchCLIs.m[session]
	launchCLIs.Unlock()
	if cli != "" {
		return cli
	}
	cliStore.Lock()
	load := cliStore.load
	cliStore.Unlock()
	if load == nil {
		return ""
	}
	if cli = load(session); cli != "" {
		launchCLIs.Lock()
		launchCLIs.m[session] = cli
		launchCLIs.Unlock()
	}
	return cli
}
