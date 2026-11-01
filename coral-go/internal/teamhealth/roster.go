package teamhealth

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// The roster part of the check (#4583): what each agent is really doing, who waits on whom, and who sleeps with tagged messages
// unread. The old check said "All 10 agents progressing; 55 posts" while eight agents sat in coral-board wait on the Orchestrator
// or on Security and one slept with tagged messages unread: post volume says nothing about whether anyone is progressing.
// Every field holds member names (through Name), numbers and fixed phrases; agent text never appears here.

// Agent states, from what Coral can see (its terminal, its waits, its session record).
const (
	StateWorking = "working" // in a turn
	StateWaiting = "waiting" // parked in coral-board wait
	StatePrompt  = "prompt"  // stopped at a prompt that needs input
	StateBlocked = "blocked" // stopped by a usage limit (its quota is used up): nothing to do until it resets (#5229)
	StateIdle    = "idle"    // awake, in no turn and in no wait
	StateAsleep  = "asleep"  // its session is asleep
	StateOffline = "offline" // it has a session but nothing is running
	StateUnknown = "unknown" // awake, but Coral has no signal of its state (no hook events)
)

// WaitEntry is one agent in a wait group.
type WaitEntry struct {
	Name string        // a member name, through Name
	Age  time.Duration // how long it has waited
	// Stale: the awaited party has posted a message mentioning the waiter since the wait began, yet the waiter has not woken.
	Stale bool
	// TargetSilent: the awaited member has posted nothing at all since the wait began (a wait on something that is not a member is never silent: nothing can be computed). A wait whose
	// target has posted is being served and is not listed (#11729).
	TargetSilent bool
	Reply        int64  // the waiter's last message number, so the orchestrator can answer it (0: none)
	Reason       string // what it waits for, a fixed phrase or the task number (#11729), through Name or ShownText
}

// WaitGroup is the agents waiting on one party.
type WaitGroup struct {
	On      string // who they wait on (a member name, "the Operator", "any update", "a commit"...), through Name
	You     bool   // the party is the check's recipient
	Waiters []WaitEntry
}

// BlockedEntry is an agent stopped by a usage limit; Resets is how long until it resets, 0 when the CLI did not say.
type BlockedEntry struct {
	Name   string
	Resets time.Duration
}

// AsleepUnread is a sleeping agent with messages tagged to it that it has not read.
type AsleepUnread struct {
	Name  string
	Count int
	Since time.Time // the oldest of them
}

// Roster is everything the check says about the agents.
type Roster struct {
	legacy    bool   // the check before the action list (#11729), kept for the tests that pin it
	Recipient string // the recipient's own name, shown as "YOU (<name>)"
	Counts    map[string]int
	Claimable int // pending tasks nobody holds, that can be claimed
	Waits     []WaitGroup
	Blocked   []BlockedEntry
	Asleep    []AsleepUnread
	// Open is each agent's open (not parked) tasks, and Reviews the tasks waiting in review: the overloaded and stale-review rules (#11729).
	Open    map[string]int
	Reviews []ReviewAge
	// NameIssues: members mentions may not reach (#11729 rule 4).
	NameIssues []NameIssue
}

// NameIssue is a member that mentions may not reach: its name starts or ends with punctuation (Edge), or no mention has reached it for Window while Posts posts @-addressed a part of its name; Age
// is how long ago the oldest of those posts was (0 for an Edge issue).
type NameIssue struct {
	Name   string // a member name, through Name
	Edge   bool
	Posts  int
	Window time.Duration
	Age    time.Duration
}

// Awake is how many agents are awake (every state but asleep and offline).
func (r *Roster) Awake() int {
	return r.Counts[StateWorking] + r.Counts[StateWaiting] + r.Counts[StatePrompt] + r.Counts[StateBlocked] + r.Counts[StateIdle] + r.Counts[StateUnknown]
}

// AllWorking: every awake agent is in a turn (and there is at least one): the only case the check says nobody is stuck.
func (r *Roster) AllWorking() bool {
	return r.Awake() > 0 && r.Counts[StateWorking] == r.Awake()
}

// NeedsAttention: something in the roster is for the reader: a wait, a prompt, an idle agent or a sleeper with tags unread.
func (r *Roster) NeedsAttention() bool {
	return len(r.Waits) > 0 || len(r.Asleep) > 0 || r.Counts[StatePrompt] > 0 || r.Counts[StateBlocked] > 0 || r.Counts[StateIdle] > 0 || r.Counts[StateUnknown] > 0
}

// maxWaiters is how many agents one wait group lists before counting the rest.
const maxWaiters = 8

func (r *Roster) headerCounts() string {
	parts := []string{
		fmt.Sprintf("%d working", r.Counts[StateWorking]),
		fmt.Sprintf("%d waiting", r.Counts[StateWaiting]),
	}
	if n := r.Counts[StatePrompt]; n > 0 {
		parts = append(parts, fmt.Sprintf("%d need input", n))
	}
	if n := r.Counts[StateBlocked]; n > 0 {
		parts = append(parts, fmt.Sprintf("%d BLOCKED by a usage limit", n))
	}
	if n := r.Counts[StateIdle]; n > 0 {
		parts = append(parts, fmt.Sprintf("%d idle", n))
	}
	if n := r.Counts[StateUnknown]; n > 0 {
		parts = append(parts, fmt.Sprintf("%d of unknown state", n))
	}
	parts = append(parts, fmt.Sprintf("%d asleep", r.Counts[StateAsleep]))
	if n := r.Counts[StateOffline]; n > 0 {
		parts = append(parts, fmt.Sprintf("%d offline", n))
	}
	parts = append(parts, plural(r.Claimable, "claimable task", "claimable tasks"))
	return strings.Join(parts, " · ")
}

// shortAge is a wait's age as the roster says it ("19m", "1h05m").
func shortAge(d time.Duration) string {
	m := int(d.Minutes())
	if m < 0 {
		m = 0
	}
	if m < 60 {
		return fmt.Sprintf("%dm", m)
	}
	return fmt.Sprintf("%dh%02dm", m/60, m%60)
}

// ComposeLines writes the check as the action list (actions.go): a header line, the lines for the orchestrator, what is for the Operator, the counts last. Compose is the same text on one
// line, which is how it is typed: a newline would be an Enter in the agent's terminal.
func ComposeLines(in CheckInput) []string {
	if in.Roster == nil {
		return []string{Compose(in)}
	}
	return composeActionList(in)
}

// peekLine is the line that tells the orchestrator how to see why an agent is idle, waiting or stuck: its terminal, with coral-board peek. It names
// the first such agent (a ranked item's, else the longest waiter's) in the example, and is empty when the recipient is not the orchestrator, when no
// awake agent is idle, waiting, at a prompt or stuck, or when everyone is working. A sleeper alone has no terminal to read.
func (in CheckInput) peekLine(items []Item) string {
	r := in.Roster
	if !in.PeekHint || r == nil {
		return ""
	}
	name := ""
	for _, it := range items {
		if it.Agent != "" && it.Agent != "Board" { // "Board" is a queue problem, not an agent
			name = it.Agent
			break
		}
	}
	if name == "" && len(r.Waits) > 0 {
		groups := append([]WaitGroup(nil), r.Waits...)
		sort.SliceStable(groups, func(i, j int) bool {
			a, b := groups[i], groups[j]
			if a.You != b.You {
				return a.You
			}
			if len(a.Waiters) != len(b.Waiters) {
				return len(a.Waiters) > len(b.Waiters)
			}
			return a.On < b.On
		})
		for _, g := range groups {
			best := ""
			var age time.Duration = -1
			for _, w := range g.Waiters {
				if w.Age > age || (w.Age == age && w.Name < best) {
					best, age = w.Name, w.Age
				}
			}
			if best != "" {
				name = best
				break
			}
		}
	}
	stuck := name != "" || r.Counts[StatePrompt] > 0 || r.Counts[StateIdle] > 0 || r.Counts[StateUnknown] > 0
	if !stuck {
		return ""
	}
	if name == "" {
		name = "<agent>"
	}
	name = strings.NewReplacer(`"`, "", `\`, "").Replace(name) // the example is a command: no quote or backslash from a member's name
	return fmt.Sprintf(`To see why, read their terminal: coral-board peek "%s" --lines 30.`, name)
}

// roster check: Compose's one-line form.
// nothingNeedsYou is the roster check's all-clear: not "Nothing needs you" while a goal needs the operator (#11412).
func nothingNeedsYou(in CheckInput) string {
	if in.goalsRemind() {
		return "No agent needs you."
	}
	return "Nothing needs you."
}

func composeRoster(in CheckInput) string {
	return strings.Join(ComposeLines(in), " • ")
}

// formatList writes the lines as the check reads when shown: the header, then one "- " line each (what Compose types is the same
// text on one line).
func formatList(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	out := lines[0]
	for _, l := range lines[1:] {
		out += "\n- " + l
	}
	return out
}

// Facts is what in the roster is for the reader, one line each, that changes when something new needs them and not when the clock moved or an agent went from one turn to the next: who waits on whom (and whether
// the wait is stale), who is blocked, who is asleep with unread tags, and how many agents are idle, offline or unknown. Agents working or waiting are not facts (they come and go every turn), nor is one at a prompt: it is a fact once it has been there the team's N minutes (an item). A
// check goes out again when it holds a fact the last one did not (#11431).
func (r *Roster) Facts() []string {
	if r == nil {
		return nil
	}
	var out []string
	for _, k := range []string{StateIdle, StateOffline, StateUnknown} {
		for i := 1; i <= r.Counts[k]; i++ { // one fact for each agent in the state, so a count that falls only loses facts (not news) and one that rises gains one (news)
			out = append(out, fmt.Sprintf("c:%s#%d", k, i))
		}
	}
	for i := 1; i <= r.Claimable; i++ {
		out = append(out, fmt.Sprintf("claimable#%d", i))
	}
	for _, g := range r.Waits {
		names := make([]string, 0, len(g.Waiters))
		for _, w := range g.Waiters {
			names = append(names, fmt.Sprintf("%s/%t", w.Name, w.Stale))
		}
		sort.Strings(names)
		out = append(out, fmt.Sprintf("w:%s/%t:%s", g.On, g.You, strings.Join(names, ",")))
	}
	for _, b := range r.Blocked {
		out = append(out, "b:"+b.Name)
	}
	for _, ni := range r.NameIssues {
		out = append(out, fmt.Sprintf("n:%s/%t/%d", ni.Name, ni.Edge, ni.Posts)) // a new one is news; its age ticking is not (#11729)
	}
	for _, a := range r.Asleep {
		out = append(out, fmt.Sprintf("s:%s=%d", a.Name, a.Count))
	}
	sort.Strings(out)
	return out
}
