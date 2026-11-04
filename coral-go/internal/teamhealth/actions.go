package teamhealth

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// The orchestrator's check as an ACTION LIST (#11729, coral-hub's operator's rules): "Orchestrator, act on these (oldest first):", one line
// each saying WHO, WHAT, FOR HOW LONG and the verb; a section for what only the Operator can do; the counts last. Every line is a rule Coral
// can compute from what it already has (no judgment calls), with its threshold in the health settings; a line is never cut, and a long list
// shows the top in full and ends with "and N more: coral-board status". Fields hold member names (through Name), numbers and fixed phrases.

// Rules are the thresholds of the action list; a zero field is its default.
type Rules struct {
	StuckWait   time.Duration // a wait this long on someone who has not mentioned the waiter since (default 10 min)
	Overloaded  int           // more open tasks than this on one agent ... (default 5)
	Sleeping    int           // ... while at least this many agents sleep (default 1)
	StaleReview time.Duration // a task in review this long (default 24 h)
	Mention     time.Duration // the window of the mentions-not-reaching rule (default 30 min); the roster builder reads it
}

// DefaultRules are coral-hub's proposed defaults.
func DefaultRules() Rules {
	return Rules{StuckWait: 10 * time.Minute, Overloaded: 5, Sleeping: 1, StaleReview: 24 * time.Hour, Mention: 30 * time.Minute}
}

func (r Rules) withDefaults() Rules {
	d := DefaultRules()
	if r.StuckWait <= 0 {
		r.StuckWait = d.StuckWait
	}
	if r.Overloaded <= 0 {
		r.Overloaded = d.Overloaded
	}
	if r.Sleeping <= 0 {
		r.Sleeping = d.Sleeping
	}
	if r.StaleReview <= 0 {
		r.StaleReview = d.StaleReview
	}
	if r.Mention <= 0 {
		r.Mention = d.Mention
	}
	return r
}

// ReviewAge is a task waiting in review: its number, who holds the review, and for how long.
type ReviewAge struct {
	Task int64
	With string // a member name, through Name
	Age  time.Duration
}

type action struct {
	onYou  bool
	pinned bool          // an agent stopped at a dialog or prompt: someone is waiting on a person, so it is said right after what waits on the recipient (#11431)
	age    time.Duration // 0: not known; those come after the aged ones, in rank order
	rank   int
	text   string
}

// Actionable reports whether a wait is a line of the list: one on the recipient (you), one the awaited party has mentioned the waiter about without it waking (Stale), or a long one on a member who has
// not mentioned the waiter since (and a wait on a task needs the task open). A wait that is being served, or is young, is not.
func (w WaitEntry) Actionable(you bool, rules Rules) bool {
	return you || w.Stale || (w.TargetSilent && w.Age > rules.withDefaults().StuckWait)
}

// statusHint is where the rest of a long list is.
const statusHint = "coral-board status"

func minutes(d time.Duration) string { return age(d) }

// actions are the lines for the orchestrator, in the order they are said: what waits on the recipient first, then the oldest.
func (in CheckInput) actions(items []Item) []action {
	r := in.Roster
	rules := in.Rules.withDefaults()
	var out []action
	for _, g := range r.Waits {
		for _, w := range g.Waiters {
			if !w.Actionable(g.You, rules) {
				continue
			}
			switch {
			case g.You:
				l := fmt.Sprintf("%s has waited %s on YOU", w.Name, minutes(w.Age))
				if w.Reply > 0 {
					l += fmt.Sprintf(" (their last message is #%d)", w.Reply)
				}
				if w.Reason != "" {
					l += ", for " + w.Reason
				}
				out = append(out, action{onYou: true, age: w.Age, text: l + ". Answer them."})
			case w.Stale:
				out = append(out, action{age: w.Age, text: fmt.Sprintf("%s has waited %s although %s has posted a message mentioning them since: check %s.", w.Name, minutes(w.Age), g.On, w.Name)})
			default:
				l := fmt.Sprintf("%s has waited %s on %s; %s has not mentioned them since", w.Name, minutes(w.Age), g.On, g.On)
				if strings.HasPrefix(w.Reason, "task #") {
					l += " and the task is not done"
				}
				if w.Reason != "" {
					l += " (for " + w.Reason + ")"
				}
				out = append(out, action{age: w.Age, text: l + ". Ask " + g.On + " what is holding it, or check " + g.On + "."})
			}
		}
	}
	for _, it := range items {
		l := fmt.Sprintf("%s: %s.", it.Agent, it.Problem)
		if it.Evidence != "" {
			l += " " + it.Evidence + "."
		}
		if it.Said != "" {
			l += " Last said, " + it.Said
		}
		if it.Suggest != "" {
			l += " Suggest: " + it.Suggest + "."
		}
		if it.Back {
			l += " (back: changed since it was acknowledged)"
		}
		if it.Key != "" {
			l += " [ack " + ItemID(it.Key) + "]"
		}
		out = append(out, action{age: it.Age, rank: it.Rank, pinned: it.Rank == 0, text: l})
	}
	for _, b := range r.Blocked {
		if b.Model != "" {
			out = append(out, action{rank: 5, text: b.Name + " is blocked: Codex refuses its model " + b.Model + " (its login cannot use it), so every turn ends with no work: change the agent's model or log Codex in again; messages wait unread until then."})
			continue
		}
		l := b.Name + " is blocked by a usage limit"
		if b.Resets > 0 {
			l += " (resets in " + Age(b.Resets) + ")"
		}
		out = append(out, action{rank: 5, text: l + ": nothing to nudge until it resets or its plan changes."})
	}
	if r.Counts[StateAsleep] >= rules.Sleeping {
		names := make([]string, 0, len(r.Open))
		for n, c := range r.Open {
			if c > rules.Overloaded {
				names = append(names, n)
			}
		}
		sort.Strings(names)
		for _, n := range names {
			out = append(out, action{rank: 4, text: fmt.Sprintf("%s holds %s while %s. Reassign some, or wake a sleeper.", n, plural(r.Open[n], "open task", "open tasks"), plural(r.Counts[StateAsleep], "agent sleeps", "agents sleep"))})
		}
	}
	for _, rv := range r.Reviews {
		if rv.Age > rules.StaleReview {
			out = append(out, action{age: rv.Age, text: fmt.Sprintf("Task #%d has been in review with %s for %s. Ask %s, or give the review to someone else.", rv.Task, rv.With, age(rv.Age), rv.With)})
		}
	}
	for _, ni := range r.NameIssues {
		if ni.Edge {
			out = append(out, action{rank: 4, text: ni.Name + ": its name starts or ends with punctuation, so mentions may not reach it. Check its name."})
			continue
		}
		out = append(out, action{age: ni.Age, text: fmt.Sprintf("%s: no mention has reached it in %s while %s a part of its name. Check its name (rename it, or tell the senders the full name).", ni.Name, age(ni.Window), plural(ni.Posts, "post addresses", "posts address"))})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.onYou != b.onYou {
			return a.onYou
		}
		if a.pinned != b.pinned {
			return a.pinned
		}
		if (a.age > 0) != (b.age > 0) {
			return a.age > 0
		}
		if a.age != b.age {
			return a.age > b.age
		}
		return a.rank < b.rank
	})
	return out
}

// operatorLines is the "Needs the Operator" section: the asks waiting on the person, oldest first, each whole. Only what Coral can tell is waiting on the Operator is here (an open ask); a
// parked task's reason is the agent's own words and says nothing computable about who it waits for.
func (in CheckInput) operatorLines() []string {
	qs := append([]Question(nil), in.Questions...)
	sort.SliceStable(qs, func(i, j int) bool { return qs[i].Since.Before(qs[j].Since) })
	out := make([]string, 0, len(qs))
	for _, q := range qs {
		out = append(out, fmt.Sprintf("%s, %s ago: %s", q.Asker, age(in.Now.Sub(q.Since)), q.Text))
	}
	return out
}

// composeActionList is the roster check as the action list.
func composeActionList(in CheckInput) []string {
	r := in.Roster
	items := append([]Item(nil), in.Items...)
	sort.SliceStable(items, func(i, j int) bool { return items[i].Rank < items[j].Rank })
	acts := in.actions(items)
	op := in.operatorLines()
	stamp := fmt.Sprintf("[Coral health check] %s", in.Now.UTC().Format("15:04Z"))
	var tail []string
	if g := goalsLine(in.Goals); g != "" {
		tail = append(tail, g)
	}
	progressed := in.Progress.Completed+in.Progress.Reviewed+in.Progress.Posts > 0
	since := in.Progress.Since.Format("15:04")
	if progressed {
		tail = append(tail, fmt.Sprintf("Since %s: %s%s.", since, progressPhrase(in.Progress), parkedNote(in)))
	} else {
		tail = append(tail, fmt.Sprintf("No progress since the last check (%s)%s.", since, parkedNote(in)))
	}
	tail = append(tail, "Counts: "+r.headerCounts())
	hint := in.peekLine(items) // a pointer, not a fact: the first thing left out when the check would not fit
	if len(acts) == 0 && len(op) == 0 {
		ls := []string{stamp + " · " + nothingNeedsYou(in)}
		if hint != "" {
			ls = append(ls, hint)
		}
		return append(ls, tail...)
	}
	build := func(na, no int, withHint bool) []string {
		var ls []string
		if len(acts) > 0 {
			ls = append(ls, stamp+" · Orchestrator, act on these (oldest first):")
			for i := 0; i < na; i++ {
				ls = append(ls, fmt.Sprintf("%d) %s", i+1, acts[i].text))
			}
			if na < len(acts) {
				ls = append(ls, fmt.Sprintf("and %d more: %s", len(acts)-na, statusHint))
			}
		} else {
			ls = append(ls, stamp)
		}
		if withHint && hint != "" {
			ls = append(ls, hint)
		}
		if len(op) > 0 {
			ls = append(ls, "Needs the Operator (tell them in one batch):")
			for i := 0; i < no; i++ {
				ls = append(ls, op[i])
			}
			if no < len(op) {
				ls = append(ls, fmt.Sprintf("and %d more: %s", len(op)-no, statusHint))
			}
		}
		return append(ls, tail...)
	}
	// Within the cap, whole lines only: the operator's lines are trimmed after the actions' are, and counted.
	for na := len(acts); na >= 0; na-- {
		for no := len(op); no >= 0; no-- {
			for _, withHint := range []bool{true, false} {
				if ls := build(na, no, withHint); len(strings.Join(ls, " • ")) <= MaxCheck {
					return ls
				}
			}
		}
	}
	return []string{strings.ToValidUTF8(stamp[:min(len(stamp), MaxCheck)], "")}
}
