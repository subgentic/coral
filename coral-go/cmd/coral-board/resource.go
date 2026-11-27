package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/pkg/resourcequeue"
)

const resourceUsageText = `Usage: coral-board resource <subcommand> [args]

Resources with slots that agents claim (the resource queue, #13613): "mac-heavy" has one slot; claim it before a heavy run, release it after. A claim is a lease (renew it on a long run); it ends by itself when
you release it, when it runs out, or when you are no longer on a board. While you wait you have a place in line, ranked by the task you are working on (critical, high, medium, low), then first come first served;
the Orchestrator can move you.
The queue is cooperation, not isolation: it tells the team who is using a machine; it does not stop a command that skips it. A claim --wait that is stopped (or a place made by a claim you never ask about again) is skipped after about 30 seconds and dropped after 10 minutes: run the same claim again to keep your place.

  resource list [--json]                          Every resource: slots, who holds them, the line in order
  resource status <name> [--json]                 One resource, and your place
  resource info <name> [--json]                   What it is for: its description (what it runs, how to reach it, its rules) and the machine's stats now
  resource claim <name> [--wait] [--timeout 30m] [--note "why"] [--run -- <command>]
                                                  A slot now (exit 0), or a place in line: with --wait the command waits until the slot is yours
  resource release <name>                         Give the slot back, or leave the line
  resource renew <name>                           A full lease from now
  resource define <name> (--slots N | --pool a,b) [--machine M] [--here | --remote] [--lease 30m] [--allow a,b] [--match "go test ./..."]... [--facts os=linux]... [--weight N] [--needs go>=1.26]... --description "what it runs, how to reach it, its rules"
                                                  The Operator or an Orchestrator: make or change a resource
  resource setup <box>... [--pool NAME] [--dry-run]
                                                  The Operator or an Orchestrator: read each computer over ssh (or "here"), run a tiny check test on it, and define its resource with slots, facts and a description (run it again to update)
  resource remove <name>                          The Operator or an Orchestrator
  resource move <entry-id> first|up|down          The Operator or an Orchestrator: reorder the line
  resource kick <entry-id>                        The Operator or an Orchestrator: drop a holder or a waiting entry`

// resourcePoll is how often a waiting claim looks again; a test shortens it.
var resourcePoll = 3 * time.Second

func resourceFail(what string, err error, status int, data []byte) {
	fmt.Fprintln(os.Stderr, what+": "+clierr.Describe(err, status, data))
	exitFn(1)
}

func resourceCall(method, path string, body any) ([]byte, int, error) {
	return apiCallRawAt("/api", method, "/resources"+path, body, 30*time.Second)
}

func cmdResource() {
	args := os.Args[2:]
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, resourceUsageText)
		exitFn(1)
		return
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "list":
		resourceList(rest)
	case "status":
		resourceStatus(rest)
	case "info":
		resourceInfo(rest)
	case "claim":
		resourceClaim(rest)
	case "release", "renew":
		resourceSimple(sub, rest)
	case "define":
		resourceDefine(rest)
	case "setup":
		resourceSetup(rest)
	case "remove":
		resourceRemove(rest)
	case "move":
		resourceMove(rest)
	case "kick":
		resourceKick(rest)
	default:
		fmt.Fprintln(os.Stderr, "Unknown resource command: "+sub)
		fmt.Fprintln(os.Stderr, resourceUsageText)
		exitFn(1)
	}
}

func resourceName(rest []string, what string) string {
	if len(rest) < 1 || strings.HasPrefix(rest[0], "-") {
		fmt.Fprintln(os.Stderr, "Usage: coral-board resource "+what+" <name>")
		exitFn(1)
	}
	return url.PathEscape(rest[0])
}

type resEntry struct {
	ID       int64  `json:"id"`
	Agent    string `json:"agent"`
	Task     int    `json:"task"`
	Note     string `json:"note"`
	Granted  string `json:"granted_at"`
	Lease    string `json:"lease_until"`
	Place    int    `json:"place"`
	Priority int    `json:"priority"`
	Member   string `json:"member"`   // a pool's hold: the member it was granted
	Machine  string `json:"machine"`  // and where that is
	IdleMin  *int   `json:"idle_min"` // nothing has run under the claim for this many minutes (#14079)
}

type resView struct {
	Name     string   `json:"name"`
	Slots    int      `json:"slots"`
	Machine  string   `json:"machine"`
	Where    string   `json:"where"` // here or remote; empty says nothing (#14354)
	MaxLease int      `json:"max_lease_seconds"`
	Members  []string `json:"members"`
	// Description and Stats are the resource's how-to and its machine now (#17560).
	Description string            `json:"description"`
	Facts       map[string]string `json:"facts"`
	Weight      int               `json:"weight"`
	Needs       []string          `json:"needs"`
	Stats       *resStats         `json:"stats"`
	Holders     []resEntry        `json:"holders"`
	Queue       []resEntry        `json:"queue"`
}

type resStats struct {
	State       string  `json:"state"`
	LoadPerCore float64 `json:"load_per_core"`
	CPUCount    int     `json:"cpu_count"`
	MemAvailMB  int64   `json:"mem_available_mb"`
	DiskFreeGB  float64 `json:"disk_free_gb"`
}

func (s resStats) words() string {
	switch s.State {
	case "ok":
		return fmt.Sprintf("up; load %.2f per core on %d cores; %d MB memory free; %.0f GB disk free", s.LoadPerCore, s.CPUCount, s.MemAvailMB, s.DiskFreeGB)
	case "unreachable":
		return "unreachable (ssh failed or timed out)"
	case "checking":
		return "checking"
	}
	return "stats not available for this machine"
}

// howTo prints a resource's description (its first maxLines lines) and its machine's stats, each line indented, for a claim, a place in line and info.
func howTo(v resView, maxLines int) {
	if v.Description == "" {
		fmt.Println("  (no description yet: ask the Orchestrator to add one with resource define --description)")
	} else {
		lines := strings.Split(v.Description, "\n")
		for i, l := range lines {
			if i == maxLines {
				fmt.Println("  ... more: coral-board resource info " + plainText(v.Name))
				break
			}
			fmt.Println("  " + plainText(l))
		}
	}
	if v.Stats != nil {
		fmt.Println("  machine now: " + v.Stats.words())
	}
}

// resourceInfo is resource info <name>: one command that says what the resource is for and how it is doing.
func resourceInfo(rest []string) {
	name := resourceName(rest, "info")
	data, status, err := resourceCall("GET", "/"+name, nil)
	if err != nil || status != http.StatusOK {
		resourceFail("Could not read the resource", err, status, data)
		return
	}
	if len(rest) > 1 && rest[1] == "--json" {
		fmt.Println(string(data))
		return
	}
	var v resView
	if json.Unmarshal(data, &v) != nil {
		fmt.Println(string(data))
		return
	}
	where := ""
	if v.Machine != "" {
		where = " on " + v.Machine
	}
	fmt.Printf("%s%s: %d slot(s)\n", plainText(v.Name), plainText(where), v.Slots)
	if len(v.Facts) > 0 || v.Weight > 0 || len(v.Needs) > 0 {
		keys := make([]string, 0, len(v.Facts))
		for k := range v.Facts {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var parts []string
		for _, k := range keys {
			parts = append(parts, k+"="+v.Facts[k])
		}
		line := "  facts: " + strings.Join(parts, " ")
		if v.Weight > 0 {
			line += fmt.Sprintf("  weight: %d", v.Weight)
		}
		if len(v.Needs) > 0 {
			line += "  needs: " + strings.Join(v.Needs, " ")
		}
		fmt.Println(plainText(line))
	}
	howTo(v, 6)
}

// claimHowTo prints the how-to after a claim is granted or given a place (a few lines, so it does not flood the output); a failed read prints nothing.
func claimHowTo(name string) {
	data, status, err := resourceCall("GET", "/"+name, nil)
	if err != nil || status != http.StatusOK {
		return
	}
	var v resView
	if json.Unmarshal(data, &v) == nil {
		howTo(v, 3)
	}
}

func printResource(v resView, me string) {
	where := ""
	if v.Machine != "" {
		where = " on " + v.Machine
	}
	if v.Where != "" {
		where += " (" + v.Where + ")" // a run through it happens here or remotely (#14354)
	}
	if len(v.Members) > 0 {
		where = " (pool of " + strings.Join(v.Members, ", ") + ")"
	}
	fmt.Printf("%s: %d of %d slot(s) held%s\n", plainText(v.Name), len(v.Holders), v.Slots, plainText(where))
	for _, h := range v.Holders {
		on := ""
		if h.Machine != "" {
			on = " on " + h.Machine
		} else if h.Member != "" {
			on = " on " + h.Member
		}
		fmt.Printf("  holds   #%d %s%s%s%s%s\n", h.ID, plainText(h.Agent), plainText(on), taskWords(h), idleWords(h.IdleMin), leaseWords(h.Lease))
	}
	for _, q := range v.Queue {
		mine := ""
		if strings.EqualFold(q.Agent, me) {
			mine = "  <- you"
		}
		fmt.Printf("  %2d.     #%d %s%s%s\n", q.Place, q.ID, plainText(q.Agent), taskWords(q), mine)
	}
}

func taskWords(e resEntry) string {
	s := ""
	if e.Task > 0 {
		s += fmt.Sprintf(" (task #%d)", e.Task)
	}
	if e.Note != "" {
		s += ": " + plainText(e.Note)
	}
	return s
}

func idleWords(m *int) string {
	if m == nil {
		return ""
	}
	return fmt.Sprintf(" [idle for %d min: nothing running; the slot goes back after 3]", *m)
}

func leaseWords(lease string) string {
	t, err := time.Parse(time.RFC3339, lease)
	if err != nil {
		return ""
	}
	switch d := time.Until(t); {
	case d <= 0:
		return " [lease over: it ends at the next look]"
	case d < time.Minute:
		return fmt.Sprintf(" [lease %ds left]", int(d.Seconds()))
	default:
		return fmt.Sprintf(" [lease %s left]", d.Round(time.Minute))
	}
}

func resourceList(rest []string) {
	asJSON := len(rest) == 1 && rest[0] == "--json"
	if len(rest) > 0 && !asJSON {
		fmt.Fprintln(os.Stderr, resourceUsageText)
		exitFn(1)
	}
	data, status, err := resourceCall("GET", "", nil)
	if err != nil || status != http.StatusOK {
		resourceFail("Could not list the resources", err, status, data)
		return
	}
	if asJSON {
		fmt.Println(string(data))
		return
	}
	var out struct {
		Resources []resView `json:"resources"`
	}
	if json.Unmarshal(data, &out) != nil || len(out.Resources) == 0 {
		fmt.Println("No resources are defined. The Orchestrator defines them: coral-board resource define <name> --slots N")
		return
	}
	me := resolveSubscriberID()
	for _, v := range out.Resources {
		printResource(v, me)
		howTo(v, 2)
	}
}

func resourceStatus(rest []string) {
	name := resourceName(rest, "status")
	data, status, err := resourceCall("GET", "/"+name, nil)
	if err != nil || status != http.StatusOK {
		resourceFail("Could not read the resource", err, status, data)
		return
	}
	if len(rest) > 1 && rest[1] == "--json" {
		fmt.Println(string(data))
		return
	}
	var v resView
	if json.Unmarshal(data, &v) != nil {
		fmt.Println(string(data))
		return
	}
	printResource(v, resolveSubscriberID())
	howTo(v, 3)
}

func resourceClaim(rest []string) {
	name := resourceName(rest, "claim")
	fs := flag.NewFlagSet("resource-claim", flag.ContinueOnError)
	wait := fs.Bool("wait", false, "wait in line until the slot is yours")
	timeout := fs.Duration("timeout", 0, "give up waiting after this long (0: wait as long as it takes)")
	note := fs.String("note", "", "why, for the others to read")
	run := fs.Bool("run", false, "after the grant, run the command that follows -- where the resource says (here, or sent to its machine over ssh as heavy run does), keep the slot while it runs and give it back when it ends (#18488)")
	clihelp.ParseFlags(fs, rest[1:], func() string { return resourceUsageText })
	cmdArgs := fs.Args()
	if *run && len(cmdArgs) == 0 {
		fmt.Fprintln(os.Stderr, "resource claim --run needs a command: coral-board resource claim "+rest[0]+" --wait --run -- <command>")
		exitFn(1)
		return
	}
	me := resolveSubscriberID()
	body := map[string]any{"subscriber_id": me, "note": flagText(*note, "note"), "parent_pid": os.Getppid()} // the shell that runs this command: a job in the background keeps the slot while it runs
	runID := ""
	if *run {
		runID = newRunID() // this run's own: a second run of the same agent on the resource shares the slot, and this one's end gives back only its share (#21790)
		body["run_id"] = runID
	}
	data, status, err := resourceCall("POST", "/"+name+"/claim", body)
	if err != nil || (status != http.StatusOK && status != http.StatusAccepted) {
		resourceFail("Could not claim "+rest[0], err, status, data)
		return
	}
	var res struct {
		Granted bool `json:"granted"`
		Place   int  `json:"place"`
		Entry   struct {
			ID         int64  `json:"id"`
			Member     string `json:"member"`
			Machine    string `json:"machine"`
			Where      string `json:"where"`
			LeaseUntil string `json:"lease_until"`
		} `json:"entry"`
	}
	_ = json.Unmarshal(data, &res)
	if res.Granted {
		fmt.Printf("You hold a slot of %s%s. As an agent, it goes back when THIS command (tool call) ends: claim and run the work in the same command. Release early with: coral-board resource release %s\n", rest[0], onWords(res.Entry.Machine, res.Entry.Member), rest[0])
		claimHowTo(name)
		if *run {
			runUnderClaim(name, me, runID, cmdArgs, res.Entry.LeaseUntil, res.Entry.Where, res.Entry.Machine)
		}
		return
	}
	fmt.Printf("%s is busy: you are number %d in line.\n", rest[0], res.Place)
	claimHowTo(name)
	if !*wait {
		fmt.Println("Run the claim again with --wait to wait for your turn, or coral-board resource status " + rest[0] + " to look.")
		exitFn(3)
		return
	}
	var until time.Time
	if *timeout > 0 {
		until = time.Now().Add(*timeout)
	}
	last := res.Place
	if res.Entry.ID > 0 {
		body["poll_entry"] = res.Entry.ID // the place this wait queued: if it is released or kicked, the wait ends instead of queueing again (#20345)
	}
	for {
		time.Sleep(resourcePoll) // sleep-ok: the poll between looks at the line while waiting for a turn
		data, status, err = resourceCall("POST", "/"+name+"/claim", body)
		if status == http.StatusGone {
			fmt.Fprintln(os.Stderr, "Your place in line for "+plainText(rest[0])+" was cancelled (released or removed): nothing was claimed and the command was not run.")
			exitFn(4)
			return
		}
		if err != nil || (status != http.StatusOK && status != http.StatusAccepted) {
			resourceFail("Lost the place in line for "+rest[0], err, status, data)
			return
		}
		res.Granted, res.Place = false, 0
		_ = json.Unmarshal(data, &res)
		if res.Granted {
			fmt.Printf("Your turn: you hold a slot of %s%s. As an agent, it goes back when THIS command (tool call) ends: claim and run the work in the same command. Release early with: coral-board resource release %s\n", rest[0], onWords(res.Entry.Machine, res.Entry.Member), rest[0])
			claimHowTo(name)
			if *run {
				runUnderClaim(name, me, runID, cmdArgs, res.Entry.LeaseUntil, res.Entry.Where, res.Entry.Machine)
			}
			return
		}
		if res.Place != last {
			fmt.Printf("You are number %d in line.\n", res.Place)
			last = res.Place
		}
		if !until.IsZero() && time.Now().After(until) {
			_, _, _ = resourceCall("POST", "/"+name+"/release", map[string]any{"subscriber_id": me, "keep_place": true}) // the place is kept for a few minutes (#13706); a slot that comes to it waits two minutes for the agent, then passes on
			fmt.Fprintln(os.Stderr, "Gave up waiting for "+rest[0]+". Your place in line is kept for 10 minutes: run the same claim again to go on waiting from it.")
			exitFn(4)
			return
		}
	}
}

// runUnderClaim runs the command of `resource claim --run -- <command>` here, after the slot is granted, and ties the slot to the run itself (#18488): it renews the lease while the command runs (a run longer than the
// lease keeps its slot), stops the command if the slot is lost (kicked, or the lease ran out), and gives the slot back when the command ends, whatever started this process: the shell that launched it ending, a
// background script or a tool call finishing does not matter, because this process is the one the claim follows. The exit code is the command's own (1 when the slot was lost).
func runUnderClaim(name, me, runID string, args []string, leaseUntil, where, machine string) {
	command := heavyCommand(args)
	if where == "" { // the claim's answer said nothing of where: the resource's own definition does (an older server, #14262)
		var rv struct {
			Machine string `json:"machine"`
			Where   string `json:"where"`
		}
		if data, status, err := resourceCall("GET", "/"+name, nil); err == nil && status == http.StatusOK && json.Unmarshal(data, &rv) == nil {
			where = rv.Where
			if machine == "" {
				machine = rv.Machine
			}
		}
	}
	remote := where == resourcequeue.WhereRemote // a resource defined remote sends the run there, as heavy run does (#20221); one that says here, or nothing, runs here as before
	if remote && heavyMacOnly.MatchString(command) {
		_, _, _ = resourceCall("POST", "/"+name+"/release", map[string]any{"subscriber_id": me, "run_id": runID})
		fmt.Printf("%s is on another machine (%s) and this command is for this machine only (it names ~/.coral or port 8420): nothing was run and the slot is given back. Run it here, with a resource of this machine.\n", plainText(name), plainText(machine))
		exitFn(2)
		return
	}
	if remote {
		fmt.Printf("%s: running on %s (over ssh)\n", plainText(name), plainText(machine))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	lost := make(chan struct{})
	var lease time.Duration
	if t, err := time.Parse(time.RFC3339Nano, leaseUntil); err == nil {
		lease = time.Until(t)
	}
	go func() {
		defer safego.Recover("resource/renew")
		tick := time.NewTicker(heavyRenewEvery(lease))
		defer tick.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-tick.C:
				if _, status, err := resourceCall("POST", "/"+name+"/renew", map[string]any{"subscriber_id": me}); err == nil && status == http.StatusConflict {
					close(lost)
					cancelRun()
					return
				}
			}
		}
	}()
	var code int
	if remote {
		code = heavyRunRemote(runCtx, command, 0, machine)
	} else {
		code = heavyRunLocal(runCtx, command)
	}
	wasLost := false
	select {
	case <-lost:
		wasLost = true
		fmt.Printf("this run lost its slot of %s (kicked, or its lease ran out): it was stopped so it does not run beside the next agent's\n", plainText(name))
	default:
	}
	code = heavyFinalCode(code, wasLost)
	_, _, _ = resourceCall("POST", "/"+name+"/release", map[string]any{"subscriber_id": me, "run_id": runID})
	fmt.Printf("%s given back (exit %d)\n", plainText(name), code)
	if code != 0 {
		exitFn(code)
	}
}

func resourceSimple(what string, rest []string) {
	name := resourceName(rest, what)
	data, status, err := resourceCall("POST", "/"+name+"/"+what, map[string]any{"subscriber_id": resolveSubscriberID()})
	if err != nil || status != http.StatusOK {
		resourceFail("Could not "+what+" "+rest[0], err, status, data)
		return
	}
	if what == "release" {
		var out struct {
			LeftLine bool `json:"left_line"`
		}
		_ = json.Unmarshal(data, &out)
		if out.LeftLine {
			fmt.Println("Left the line for " + rest[0] + ": your queued claim was cancelled, and a claim --wait still waiting for it stops without running its command.")
			return
		}
		fmt.Println("Released " + rest[0] + ".")
	} else {
		fmt.Println("Lease on " + rest[0] + " renewed.")
	}
}

func resourceDefine(rest []string) {
	name := resourceName(rest, "define")
	fs := flag.NewFlagSet("resource-define", flag.ContinueOnError)
	slots := fs.Int("slots", 0, "how many may hold it at once")
	machine := fs.String("machine", "", "where it is, for people to read")
	here := fs.Bool("here", false, "a run through it happens on the machine this Coral is on (coral-board heavy run)")
	remote := fs.Bool("remote", false, "a run through it happens on another machine, through the ssh alias coral-heavy-<machine> (coral-board heavy run)")
	lease := fs.Duration("lease", 0, "how long a claim lasts unless renewed (default 30m)")
	pool := fs.String("pool", "", "a pool: comma-separated resources whose slots it hands out, the least used box that meets --needs first (no --slots)")
	allow := fs.String("allow", "", "comma-separated agents that may claim it (default: everyone)")
	desc := fs.String("description", "", "what it runs, how to reach it (such as ssh epoch) and its rules: a few lines of plain text; required for a new resource")
	weight := fs.Int("weight", 0, "its share when a pool spreads work: the cores lent to tests (default 1)")
	var facts, needs listFlag
	fs.Var(&facts, "facts", `what the box can run, name=value (repeat for more): os=linux, go=1.26, cores=16`)
	fs.Var(&needs, "needs", `on a pool: what a command it claims needs of the box that runs it (repeat): os=linux, go>=1.26, os!=windows`)
	var match listFlag
	fs.Var(&match, "match", `a shell command that claims it by itself, such as "go test ./..." (repeat for more; the hook, off without one)`)
	clihelp.ParseFlags(fs, rest[1:], func() string { return resourceUsageText })
	if *here && *remote {
		fmt.Fprintln(os.Stderr, "--here or --remote, not both")
		exitFn(1)
		return
	}
	if *pool != "" && *slots != 0 {
		fmt.Fprintln(os.Stderr, "A pool has no slots of its own: --pool a,b or --slots N, not both")
		exitFn(1)
		return
	}
	if *pool == "" && *slots < 1 {
		fmt.Fprintln(os.Stderr, "--slots N (1 or more) is required (or --pool a,b)")
		exitFn(1)
		return
	}
	body := map[string]any{"slots": *slots, "machine": *machine, "max_lease_seconds": int(lease.Seconds())}
	if *here {
		body["where"] = "here"
	} else if *remote {
		body["where"] = "remote"
	}
	if *pool != "" {
		body["members"] = strings.Split(*pool, ",")
	}
	if *allow != "" {
		body["allowed"] = strings.Split(*allow, ",")
	}
	if len(match) > 0 {
		body["match"] = []string(match)
	}
	if *desc != "" {
		body["description"] = *desc
	}
	if *weight != 0 {
		body["weight"] = *weight
	}
	if len(facts) > 0 {
		fm := map[string]string{}
		for _, f := range facts {
			k, v, ok := strings.Cut(f, "=")
			if !ok || k == "" || v == "" {
				fmt.Fprintf(os.Stderr, "--facts wants name=value, not %q\n", f)
				exitFn(1)
				return
			}
			fm[k] = v
		}
		body["facts"] = fm
	}
	if len(needs) > 0 {
		body["needs"] = []string(needs)
	}
	data, status, err := resourceCall("PUT", "/"+name, body)
	if err != nil || status != http.StatusOK {
		resourceFail("Could not define "+rest[0], err, status, data)
		return
	}
	if *pool != "" {
		fmt.Printf("Defined %s, a pool of %s.\n", rest[0], strings.ReplaceAll(*pool, ",", ", "))
		return
	}
	fmt.Printf("Defined %s with %d slot(s).\n", rest[0], *slots)
}

func resourceRemove(rest []string) {
	name := resourceName(rest, "remove")
	data, status, err := resourceCall("DELETE", "/"+name, nil)
	if err != nil || status != http.StatusOK {
		resourceFail("Could not remove "+rest[0], err, status, data)
		return
	}
	fmt.Println("Removed " + rest[0] + ".")
}

func resourceEntryID(rest []string, usage string) int64 {
	if len(rest) < 1 {
		fmt.Fprintln(os.Stderr, "Usage: coral-board resource "+usage)
		exitFn(1)
	}
	id, err := strconv.ParseInt(rest[0], 10, 64)
	if err != nil || id < 1 {
		fmt.Fprintln(os.Stderr, "Not an entry id: "+rest[0])
		exitFn(1)
	}
	return id
}

func resourceMove(rest []string) {
	id := resourceEntryID(rest, "move <entry-id> first|up|down")
	if len(rest) != 2 || (rest[1] != "first" && rest[1] != "up" && rest[1] != "down") {
		fmt.Fprintln(os.Stderr, "Usage: coral-board resource move <entry-id> first|up|down")
		exitFn(1)
		return
	}
	data, status, err := resourceCall("POST", fmt.Sprintf("/entries/%d/move", id), map[string]any{"how": rest[1]})
	if err != nil || status != http.StatusOK {
		resourceFail("Could not move the entry", err, status, data)
		return
	}
	fmt.Printf("Moved entry #%d %s.\n", id, rest[1])
}

func resourceKick(rest []string) {
	id := resourceEntryID(rest, "kick <entry-id>")
	data, status, err := resourceCall("DELETE", fmt.Sprintf("/entries/%d", id), nil)
	if err != nil || status != http.StatusOK {
		resourceFail("Could not drop the entry", err, status, data)
		return
	}
	fmt.Printf("Dropped entry #%d.\n", id)
}

// onWords says where a pool's grant is: " on Studio" (the machine, else the member), "" for a resource that is not a pool.
func onWords(machine, member string) string {
	switch {
	case machine != "":
		return " on " + plainText(machine)
	case member != "":
		return " on " + plainText(member)
	}
	return ""
}

// newRunID is one `claim --run`'s own id (#21790): random, so no two runs share it.
func newRunID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("run-%d-%d", os.Getpid(), time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}
