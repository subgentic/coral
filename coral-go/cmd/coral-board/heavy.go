package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/heavy"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/pkg/resourcequeue"
)

const heavyUsageText = `Usage: coral-board heavy run [--pool heavy] [--timeout 90m] -- <command...>

Runs a heavy command on whichever machine the pool gives you (this one or a remote machine of the pool); you never name the machine.
It claims the pool (waiting in line if it is busy), runs the command there, streams its output, returns its exit
code and gives the slot back. On this machine the command runs here. On a remote machine your worktree (git's file list, minus
secret-looking names and links that leave it) is sent and the command runs in a fresh private folder there with a
small allowlisted environment; the folder is deleted afterwards. One argument is a shell line; several are quoted.
Commands for this machine only (those that name ~/.coral or port 8420) are refused on a remote machine: claim a resource of this machine and run them yourself.
A resource that does not say where it runs (here or remote) is refused: the Operator or an Orchestrator defines it with coral-board resource define <name> ... --here or --remote.`

var heavyWord = regexp.MustCompile(`^[A-Za-z0-9_./:=@%+,-]+$`)

// heavyCommand is the shell line to run: one argument is a shell line as it is; several are joined, each quoted when it needs it.
func heavyCommand(args []string) string {
	if len(args) == 1 {
		return args[0]
	}
	parts := make([]string, len(args))
	for i, a := range args {
		if heavyWord.MatchString(a) {
			parts[i] = a
		} else {
			parts[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
	}
	return strings.Join(parts, " ")
}

// heavyMacOnly: a command that names the person's Coral folder or its port is for this machine (a guard against mistakes, not a boundary: the boundary is the restricted account).
var heavyMacOnly = regexp.MustCompile(`(^|[ /~="'])\.coral(/|\b)|\b8420\b`)

func cmdHeavy() {
	args := os.Args[2:]
	if len(args) == 0 || args[0] != "run" {
		fmt.Fprintln(os.Stderr, heavyUsageText)
		exitFn(1)
		return
	}
	if why := heavyUnsupportedHere(); why != "" {
		fmt.Fprintln(os.Stderr, "[heavy] "+why)
		exitFn(1)
		return
	}
	fs := flag.NewFlagSet("heavy-run", flag.ContinueOnError)
	pool := fs.String("pool", "heavy", "the pool to claim")
	timeout := fs.Duration("timeout", 90*time.Minute, "stop the command after this long (at most 2h)")
	clihelp.ParseFlags(fs, args[1:], func() string { return heavyUsageText })
	rest := fs.Args()
	if len(rest) == 0 {
		fmt.Fprintln(os.Stderr, heavyUsageText)
		exitFn(1)
		return
	}
	command := heavyCommand(rest)
	me := resolveSubscriberID()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	release := func() {
		_, _, _ = resourceCall("POST", "/"+*pool+"/release", map[string]any{"subscriber_id": me})
	}
	var res struct {
		Granted bool `json:"granted"`
		Place   int  `json:"place"`
		Entry   struct {
			Member     string `json:"member"`
			Machine    string `json:"machine"`
			Where      string `json:"where"`
			LeaseUntil string `json:"lease_until"`
		} `json:"entry"`
	}
	last := -1
	for {
		data, status, err := resourceCall("POST", "/"+*pool+"/claim", map[string]any{"subscriber_id": me, "note": "heavy run", "parent_pid": os.Getppid()})
		if err != nil || (status != http.StatusOK && status != http.StatusAccepted) {
			resourceFail("Could not claim "+*pool, err, status, data)
			return
		}
		res.Granted, res.Place = false, 0
		_ = json.Unmarshal(data, &res)
		if res.Granted {
			break
		}
		if res.Place != last {
			fmt.Printf("[heavy] %s is busy: you are number %d in line.\n", *pool, res.Place)
			last = res.Place
		}
		select {
		case <-ctx.Done():
			release() // leave the line
			exitFn(130)
			return
		case <-time.After(resourcePoll):
		}
	}
	// Where the slot is, from the claim's own answer; a plain slot resource (not a pool member) says no machine there on an older server, so the resource is asked what machine it is (#14262)
	machine := res.Entry.Machine
	if machine == "" && res.Entry.Member == "" {
		var rv struct {
			Machine string `json:"machine"`
			Where   string `json:"where"` // here or remote, from the same definition (#14354)
		}
		if data, status, err := resourceCall("GET", "/"+*pool, nil); err == nil && status == http.StatusOK && json.Unmarshal(data, &rv) == nil {
			machine = rv.Machine
			if res.Entry.Where == "" {
				res.Entry.Where = rv.Where // the claim's answer said nothing of where: the resource's own definition does
			}
		}
	}
	where := machine
	if where == "" {
		where = res.Entry.Member
	}
	// Where the run happens is what the granted resource's definition says (#14354), never a name in this code: remote goes through the Operator's ssh alias for the machine, here runs in this folder, and a resource
	// that says neither is refused, so a run is never silently done on the wrong machine (epoch-go once ran on the Mac). #14262 kept: a run is never done on this Mac under a claim for another machine either
	// (a run for the mini printed "running on " with no destination and ran here), so a destination that is not known runs nothing, with its own message.
	if res.Entry.Where != resourcequeue.WhereHere && res.Entry.Where != resourcequeue.WhereRemote {
		release()
		if strings.TrimSpace(where) == "" {
			fmt.Printf("[heavy] %s: could not tell which machine this slot is on, so nothing was run (a heavy run never falls back to this Mac). Define the resource with a machine and where it runs (coral-board resource define %s ... --machine <name> --here or --remote) or ask the Orchestrator.\n", plainText(*pool), plainText(*pool))
			exitFn(1)
		} else {
			fmt.Printf("[heavy] the pool gave you %s, but its resource does not say where it runs, so nothing was run. Ask the Operator or an Orchestrator to define it: coral-board resource define <name> ... --here (runs on this machine) or --remote (runs on another one).\n", plainText(where))
			exitFn(2)
		}
		return
	}
	remote := res.Entry.Where == resourcequeue.WhereRemote
	if remote && heavyMacOnly.MatchString(command) {
		release()
		fmt.Printf("[heavy] the pool gave you %s, and this command is for this machine only (it names ~/.coral or port 8420): claim a resource of this machine and run it yourself.\n", plainText(where))
		exitFn(2)
		return
	}
	how := "on this Mac"
	if remote {
		how = "over ssh"
	}
	fmt.Printf("[heavy] %s: running on %s (%s)\n", *pool, plainText(where), how)
	// the slot is a lease: a run longer than it renews it while it runs (or the next agent is given the machine under it), and a run that has lost the slot is stopped
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	lost := make(chan struct{})
	var lease time.Duration
	if t, err := time.Parse(time.RFC3339Nano, res.Entry.LeaseUntil); err == nil {
		lease = time.Until(t)
	}
	go func() {
		defer safego.Recover("heavy/renew")
		tick := time.NewTicker(heavyRenewEvery(lease))
		defer tick.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-tick.C:
				if _, status, err := resourceCall("POST", "/"+*pool+"/renew", map[string]any{"subscriber_id": me}); err == nil && status == http.StatusConflict {
					close(lost) // not ours any more: kicked, or the lease ran out
					cancelRun()
					return
				}
			}
		}
	}()
	var code int
	if remote {
		code = heavyRunRemote(runCtx, command, *timeout, where)
	} else {
		code = heavyRunLocal(runCtx, command)
	}
	wasLost := false
	select {
	case <-lost:
		wasLost = true
		fmt.Printf("[heavy] this run lost its slot of %s (kicked, or its lease ran out): it was stopped so it does not run beside the next agent's\n", *pool)
	default:
	}
	code = heavyFinalCode(code, wasLost)
	release()
	fmt.Printf("[heavy] %s given back (exit %d)\n", *pool, code)
	if code != 0 {
		exitFn(code)
	}
}

// heavyFinalCode is the exit code of a run: the command's own, except that a run which lost its slot never reports success (it ran, or ended, without the machine being its own).
func heavyFinalCode(code int, lostSlot bool) int {
	if lostSlot && code == 0 {
		return 1
	}
	return code
}

// heavyTestTransport lets a test put a stub where ssh would be (a package variable no agent can set); nil in use.
var heavyTestTransport heavy.Transport

// heavyRenewFloor is the shortest renew interval; a test shortens it.
var heavyRenewFloor = 5 * time.Second

// heavyRenewEvery is how often a run renews its slot: a third of the lease it was given, within 5 seconds and 5 minutes (60 seconds when the lease is not known).
func heavyRenewEvery(lease time.Duration) time.Duration {
	if lease <= 0 {
		return 60 * time.Second
	}
	d := lease / 3
	if d < heavyRenewFloor {
		d = heavyRenewFloor
	}
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	return d
}

// heavyRunLocal runs the command here, in this folder, with this environment: the pool gave this machine.
func heavyRunLocal(ctx context.Context, command string) int {
	c := exec.CommandContext(ctx, "sh", "-c", command)
	heavyOwnGroup(c) // its own process group, killed whole when the run is stopped: the shell dying alone would leave the command running
	c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		fmt.Fprintln(os.Stderr, "[heavy] could not run the command: "+err.Error())
		return 1
	}
	return 0
}

// heavyRunRemote sends this worktree to the machine the pool grant names (where) and runs the command there (internal/heavy), streaming its output and returning its exit code. The ssh alias is heavy.AliasFor(where).
func heavyRunRemote(ctx context.Context, command string, timeout time.Duration, where string) int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[heavy] "+err.Error())
		return 1
	}
	topOut, err := gitutil.Command(ctx, "", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[heavy] a remote machine runs a copy of a git worktree: run this from inside one (or claim a resource of this machine)")
		return 1
	}
	top := strings.TrimSpace(string(topOut))
	if real, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = real
	}
	if real, err := filepath.EvalSymlinks(top); err == nil {
		top = real
	}
	sub, err := filepath.Rel(top, cwd)
	if err != nil || strings.HasPrefix(sub, "..") {
		sub = ""
	}
	env := map[string]string{}
	for _, n := range heavy.EnvAllowed {
		if v := os.Getenv(n); v != "" {
			env[n] = v
		}
	}
	tr, ok := heavyTransportOverride()
	if heavyTestTransport != nil {
		tr, ok = heavyTestTransport, true
	}
	if !ok {
		var alias string
		if alias, err = heavy.AliasFor(where); err == nil {
			tr, err = heavy.SSHTransport(alias)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "[heavy] "+err.Error())
			return 1
		}
	}
	secs := int(timeout.Seconds())
	if secs < 1 || secs > heavy.DefaultSeconds {
		secs = heavy.DefaultSeconds
	}
	code, err := heavy.Run(ctx, heavy.RunOptions{Worktree: top, Subdir: filepath.ToSlash(sub), Command: command, Agent: resolveSubscriberID(), MaxSeconds: secs, Env: env,
		Out: os.Stdout, Err: os.Stderr, Transport: tr})
	if err != nil {
		fmt.Fprintln(os.Stderr, "[heavy] "+err.Error())
		return 1
	}
	return code
}
