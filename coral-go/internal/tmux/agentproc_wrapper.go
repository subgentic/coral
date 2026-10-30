package tmux

import (
	"path/filepath"
	"strings"
	"sync"
	"time"
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

// evalSymlinks resolves a path (a test replaces it with one that blocks; no production code assigns it). On a network mount that has stopped answering it can wait for minutes, so
// wrapperIsCLI never calls it directly.
var evalSymlinks = filepath.EvalSymlinks

// resolveTimeout bounds one resolution: the notice check runs it once per candidate shell, and a notice must not wait on a mount. A resolution that does not finish in time is "not recognised"
// (the fail-safe answer: notices wait for a record). 2 s is the bound the macOS cwd read (lsof) has too. (A test shortens it; no production code assigns it.)
var resolveTimeout = 2 * time.Second

// resolveRetryDelay is how long a path whose resolution timed out is not tried again: its answer is "not recognised" at once, without a goroutine, until the delay is over or the stuck
// call answers.
var resolveRetryDelay = 30 * time.Second

// maxStuckResolves bounds the script-path resolutions in flight. A call that is stuck cannot be cancelled, so it keeps its goroutine until the mount answers; once this many are stuck, a
// new one is refused at once ("not recognised") instead of adding another. The resolved CLI never competes for these slots (see cliResolved).
const maxStuckResolves = 4

// resolveCall is one resolution in flight; everyone who asks for the same path while it runs waits for it, none starts another.
type resolveCall struct {
	done   chan struct{}
	path   string // set before done is closed
	err    error
	capped bool // counted against maxStuckResolves
}

var resolves = struct {
	sync.Mutex
	inFlight map[string]*resolveCall
	gaveUp   map[string]time.Time // a path whose resolution timed out -> when it may be tried again
}{inFlight: map[string]*resolveCall{}, gaveUp: map[string]time.Time{}}

// resolvesInFlight is the number of resolutions running now (tests).
func resolvesInFlight() int {
	resolves.Lock()
	defer resolves.Unlock()
	return len(resolves.inFlight)
}

// resolveWithin is evalSymlinks(path) bounded by resolveTimeout; ok is false when it failed, timed out, was tried and timed out less than resolveRetryDelay ago, or (capped) too many
// others are still stuck. Two asks for one path share one call. capped is false for the resolved CLI, which must not be refused because script paths are stuck.
func resolveWithin(path string, capped bool) (resolved string, ok bool) {
	resolves.Lock()
	if until, waiting := resolves.gaveUp[path]; waiting { // before joining a call that is still stuck: a caller that timed out must not make every later one wait the bound again
		if time.Now().Before(until) {
			resolves.Unlock()
			return "", false // timed out a moment ago: not tried again yet
		}
		delete(resolves.gaveUp, path)
	}
	call := resolves.inFlight[path]
	if call == nil {
		if capped {
			n := 0
			for _, c := range resolves.inFlight {
				if c.capped {
					n++
				}
			}
			if n >= maxStuckResolves {
				resolves.Unlock()
				return "", false
			}
		}
		call = &resolveCall{done: make(chan struct{}), capped: capped}
		resolves.inFlight[path] = call
		go func() {
			p, err := evalSymlinks(path)
			resolves.Lock()
			delete(resolves.inFlight, path)
			delete(resolves.gaveUp, path) // it answered
			resolves.Unlock()
			call.path, call.err = p, err
			close(call.done)
		}()
	}
	resolves.Unlock()
	timer := time.NewTimer(resolveTimeout)
	defer timer.Stop()
	select {
	case <-call.done:
		return call.path, call.err == nil
	case <-timer.C:
		resolves.Lock()
		if resolves.inFlight[path] == call { // still stuck
			resolves.gaveUp[path] = time.Now().Add(resolveRetryDelay)
		}
		resolves.Unlock()
		return "", false
	}
}

// cliResolved keeps the resolved form of each CLI path that was noted (NoteLaunchCLI, Record as agent), so the CLI is resolved once when the row is written and not at every notice
// check; it is resolved again only when a row with that path is written again.
var cliResolved = struct {
	sync.Mutex
	m map[string]string
}{m: map[string]string{}}

// resolveCLI is the resolved form of cli (symlinks followed), from the cache when it has it; ok is false when it cannot be resolved in time (nothing is cached then).
func resolveCLI(cli string, fresh bool) (string, bool) {
	if !fresh {
		cliResolved.Lock()
		got, have := cliResolved.m[cli]
		cliResolved.Unlock()
		if have {
			return got, true
		}
	}
	got, ok := resolveWithin(cli, false)
	if ok {
		cliResolved.Lock()
		cliResolved.m[cli] = got
		cliResolved.Unlock()
	}
	return got, ok
}

// wrapperIsCLI is the check for a shell pid: its argument vector is [shell, script, ...] with no flag before the script, and the script (made absolute with the process's own working
// directory when it is relative, as `./stub.sh` is) is the same file as cli by realpath. nil when cli is unknown, which recognises nothing. The arguments are compared and dropped. On
// macOS ps joins the arguments with blanks, so a script path with a blank in it is split and is never matched (the person records it with the button).
func wrapperIsCLI(cli string) func(pid int) bool {
	if cli == "" {
		return nil
	}
	want, ok := resolveCLI(cli, false)
	if !ok {
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
		got, ok := resolveWithin(script, true)
		return ok && filepath.Clean(got) == want
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
	if cli != "" {
		resolveCLI(cli, true) // the row is written: resolved now, once, so no notice check has to
	}
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

// WrapperCheckFor is wrapperIsCLI for the CLI path noted for the session (from memory or the database): the test the exited-agent gate and the notice check share. nil when none is known.
func WrapperCheckFor(session string) func(pid int) bool { return wrapperIsCLI(launchCLIOf(session)) }
