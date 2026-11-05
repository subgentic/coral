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
	"github.com/subgentic/coral/internal/heavy"
	"github.com/subgentic/coral/internal/safego"
)

const heavyUsageText = `Usage: coral-board heavy run [--pool heavy] [--timeout 90m] -- <command...>

Runs a heavy command on whichever machine the pool gives you (the Mac or the mini); you never name the machine.
It claims the pool (waiting in line if it is busy), runs the command there, streams its output, returns its exit
code and gives the slot back. On the Mac the command runs here. On the mini your worktree (git's file list, minus
secret-looking names and links that leave it) is sent and the command runs in a fresh private folder there with a
small allowlisted environment; the folder is deleted afterwards. One argument is a shell line; several are quoted.
Commands for the Mac only (those that name ~/.coral or port 8420) are refused on the mini: use coral-board resource claim mac-heavy.`

// heavyMiniAlias is the Operator's ssh Host alias for the restricted account on the mini: the only thing the code knows of the destination. Its address, user, key and pinned host key are in the Operator's own ssh config.
const heavyMiniAlias = "coral-heavy-mini"

// heavyOnMini says whether a pool grant is the mini (by the member's name or its machine).
func heavyOnMini(member, machine string) bool {
	return strings.EqualFold(member, "mini") || strings.EqualFold(machine, "mini")
}

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

// heavyMacOnly: a command that names the person's Coral folder or its port is for the Mac (a guard against mistakes, not a boundary: the boundary is the restricted account).
var heavyMacOnly = regexp.MustCompile(`(^|[ /~="'])\.coral(/|\b)|\b8420\b`)

func cmdHeavy() {
	args := os.Args[2:]
	if len(args) == 0 || args[0] != "run" {
		fmt.Fprintln(os.Stderr, heavyUsageText)
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
	where := res.Entry.Machine
	if where == "" {
		where = res.Entry.Member
	}
	mini := heavyOnMini(res.Entry.Member, res.Entry.Machine)
	if mini && heavyMacOnly.MatchString(command) {
		release()
		fmt.Printf("[heavy] the pool gave you %s, and this command is for the Mac only (it names ~/.coral or port 8420): run it with coral-board resource claim mac-heavy.\n", plainText(where))
		exitFn(2)
		return
	}
	fmt.Printf("[heavy] %s: running on %s\n", *pool, plainText(where))
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
	if mini {
		code = heavyRunRemote(runCtx, command, *timeout)
	} else {
		code = heavyRunLocal(runCtx, command)
	}
	select {
	case <-lost:
		fmt.Printf("[heavy] this run lost its slot of %s (kicked, or its lease ran out): it was stopped so it does not run beside the next agent's\n", *pool)
		if code == 0 {
			code = 1
		}
	default:
	}
	release()
	fmt.Printf("[heavy] %s given back (exit %d)\n", *pool, code)
	if code != 0 {
		exitFn(code)
	}
}

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

// heavyRunLocal runs the command here, in this folder, with this environment: the pool gave the Mac.
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

// heavyRunRemote sends this worktree to the mini and runs the command there (internal/heavy), streaming its output and returning its exit code.
func heavyRunRemote(ctx context.Context, command string, timeout time.Duration) int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[heavy] "+err.Error())
		return 1
	}
	topOut, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[heavy] the mini runs a copy of a git worktree: run this from inside one (or claim mac-heavy)")
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
	if !ok {
		tr, err = heavy.SSHTransport(heavyMiniAlias)
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
