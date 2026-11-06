package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clihelp"
)

const resourceUsageText = `Usage: coral-board resource <subcommand> [args]

Resources with slots that agents claim (the resource queue, #13613): "mac-heavy" has one slot; claim it before a heavy run, release it after. A claim is a lease (renew it on a long run); it ends by itself when
you release it, when it runs out, or when you are no longer on a board. While you wait you have a place in line, ranked by the task you are working on (critical, high, medium, low), then first come first served;
the Orchestrator can move you.

  resource list [--json]                          Every resource: slots, who holds them, the line in order
  resource status <name> [--json]                 One resource, and your place
  resource claim <name> [--wait] [--timeout 30m] [--note "why"]
                                                  A slot now (exit 0), or a place in line: with --wait the command waits until the slot is yours
  resource release <name>                         Give the slot back, or leave the line
  resource renew <name>                           A full lease from now
  resource define <name> (--slots N | --pool a,b) [--machine M] [--lease 30m] [--allow a,b] [--match "go test ./..."]...
                                                  The Operator or an Orchestrator: make or change a resource
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
	case "claim":
		resourceClaim(rest)
	case "release", "renew":
		resourceSimple(sub, rest)
	case "define":
		resourceDefine(rest)
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
	Member   string `json:"member"`  // a pool's hold: the member it was granted
	Machine  string `json:"machine"` // and where that is
}

type resView struct {
	Name     string     `json:"name"`
	Slots    int        `json:"slots"`
	Machine  string     `json:"machine"`
	MaxLease int        `json:"max_lease_seconds"`
	Members  []string   `json:"members"`
	Holders  []resEntry `json:"holders"`
	Queue    []resEntry `json:"queue"`
}

func printResource(v resView, me string) {
	where := ""
	if v.Machine != "" {
		where = " on " + v.Machine
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
		fmt.Printf("  holds   #%d %s%s%s%s\n", h.ID, plainText(h.Agent), plainText(on), taskWords(h), leaseWords(h.Lease))
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
}

func resourceClaim(rest []string) {
	name := resourceName(rest, "claim")
	fs := flag.NewFlagSet("resource-claim", flag.ContinueOnError)
	wait := fs.Bool("wait", false, "wait in line until the slot is yours")
	timeout := fs.Duration("timeout", 0, "give up waiting after this long (0: wait as long as it takes)")
	note := fs.String("note", "", "why, for the others to read")
	clihelp.ParseFlags(fs, rest[1:], func() string { return resourceUsageText })
	me := resolveSubscriberID()
	body := map[string]any{"subscriber_id": me, "note": flagText(*note, "note"), "parent_pid": os.Getppid()} // the shell that runs this command: a job in the background keeps the slot while it runs
	data, status, err := resourceCall("POST", "/"+name+"/claim", body)
	if err != nil || (status != http.StatusOK && status != http.StatusAccepted) {
		resourceFail("Could not claim "+rest[0], err, status, data)
		return
	}
	var res struct {
		Granted bool `json:"granted"`
		Place   int  `json:"place"`
		Entry   struct {
			Member  string `json:"member"`
			Machine string `json:"machine"`
		} `json:"entry"`
	}
	_ = json.Unmarshal(data, &res)
	if res.Granted {
		fmt.Printf("You hold a slot of %s%s. As an agent, it goes back when THIS command (tool call) ends: claim and run the work in the same command. Release early with: coral-board resource release %s\n", rest[0], onWords(res.Entry.Machine, res.Entry.Member), rest[0])
		return
	}
	fmt.Printf("%s is busy: you are number %d in line.\n", rest[0], res.Place)
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
	for {
		time.Sleep(resourcePoll) // sleep-ok: the poll between looks at the line while waiting for a turn
		data, status, err = resourceCall("POST", "/"+name+"/claim", body)
		if err != nil || (status != http.StatusOK && status != http.StatusAccepted) {
			resourceFail("Lost the place in line for "+rest[0], err, status, data)
			return
		}
		res.Granted, res.Place = false, 0
		_ = json.Unmarshal(data, &res)
		if res.Granted {
			fmt.Printf("Your turn: you hold a slot of %s%s. As an agent, it goes back when THIS command (tool call) ends: claim and run the work in the same command. Release early with: coral-board resource release %s\n", rest[0], onWords(res.Entry.Machine, res.Entry.Member), rest[0])
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

func resourceSimple(what string, rest []string) {
	name := resourceName(rest, what)
	data, status, err := resourceCall("POST", "/"+name+"/"+what, map[string]any{"subscriber_id": resolveSubscriberID()})
	if err != nil || status != http.StatusOK {
		resourceFail("Could not "+what+" "+rest[0], err, status, data)
		return
	}
	if what == "release" {
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
	lease := fs.Duration("lease", 0, "how long a claim lasts unless renewed (default 30m)")
	pool := fs.String("pool", "", "a pool: comma-separated resources whose slots it hands out, first free one in order (no --slots)")
	allow := fs.String("allow", "", "comma-separated agents that may claim it (default: everyone)")
	var match listFlag
	fs.Var(&match, "match", `a shell command that claims it by itself, such as "go test ./..." (repeat for more; the hook, off without one)`)
	clihelp.ParseFlags(fs, rest[1:], func() string { return resourceUsageText })
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
	if *pool != "" {
		body["members"] = strings.Split(*pool, ",")
	}
	if *allow != "" {
		body["allowed"] = strings.Split(*allow, ",")
	}
	if len(match) > 0 {
		body["match"] = []string(match)
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

// onWords says where a pool's grant is: " on Mac mini" (the machine, else the member), "" for a resource that is not a pool.
func onWords(machine, member string) string {
	switch {
	case machine != "":
		return " on " + plainText(machine)
	case member != "":
		return " on " + plainText(member)
	}
	return ""
}
