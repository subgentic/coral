package teamhealth

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// RosterItems are the lines the roster itself raises (a usage limit, a model refused, an overloaded member while others sleep, a review gone stale, a name mentions may not reach) as items with an ack id (#21702,
// coral-hub's audit): before, they carried none, could not be acknowledged and came back at every check. The text is the line as it was; the state is what changes the news (a count, never an age), so an
// acknowledged one stays off until it changes.
func RosterItems(r *Roster, rules Rules) []Item {
	if r == nil {
		return nil
	}
	rules = rules.withDefaults()
	var out []Item
	for _, l := range usageLimitHealthItems(r.Blocked) {
		out = append(out, l)
	}
	for _, b := range r.Blocked {
		if b.Vendor != "" && !b.ModelRefused {
			continue
		}
		if b.ModelRefused {
			model := "its model"
			if b.Model != "" {
				model = "its model " + b.Model
			}
			out = append(out, Item{Rank: 5, Key: "blocked|model|" + b.Name, State: "shown", Text: b.Name + " is blocked: Codex refuses " + model + " (its login cannot use it), so every turn ends with no work: change the agent's model or log Codex in again; messages wait unread until then."})
			continue
		}
		l := b.Name + " is blocked by a usage limit"
		if b.Resets > 0 {
			l += " (resets in " + Age(b.Resets) + ")"
		}
		out = append(out, Item{Rank: 5, Key: "blocked|limit|" + b.Name, State: "shown", Text: l + ": nothing to nudge until it resets or its plan changes."})
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
			out = append(out, Item{Rank: 4, Key: "overload|" + n, State: fmt.Sprintf("%d|%d", r.Open[n], r.Counts[StateAsleep]),
				Text: fmt.Sprintf("%s holds %s while %s. Reassign some, or wake a sleeper.", n, plural(r.Open[n], "open task", "open tasks"), plural(r.Counts[StateAsleep], "agent sleeps", "agents sleep"))})
		}
	}
	for _, rv := range r.Reviews {
		if rv.Age > rules.StaleReview {
			out = append(out, Item{Age: rv.Age, Key: fmt.Sprintf("stalereview|%d|%s", rv.Task, rv.With), State: "shown",
				Text: fmt.Sprintf("Task #%d has been in review with %s for %s. Ask %s, or give the review to someone else.", rv.Task, rv.With, age(rv.Age), rv.With)})
		}
	}
	for _, w := range r.WaitedOnYou {
		l := fmt.Sprintf("%s's #%d has waited %s on you", w.Owner, w.Task, age(w.Age))
		if w.Reason != "" {
			l += ": " + w.Reason
		}
		out = append(out, Item{OnYou: true, Age: w.Age, Key: fmt.Sprintf("waitedonyou|%s|%d", w.Owner, w.Task), State: w.Reason, Text: l + ". Answer them, or tell them what to do instead."})
	}
	for _, st := range r.Stalled {
		out = append(out, Item{Age: st.Silent, Key: fmt.Sprintf("stalled|%s|%d", st.Agent, st.Task), State: "shown", Text: fmt.Sprintf("%s's #%d is in progress with no activity and no wait-on for %s: stalled, not working. Ask %s what is holding it; if it waits on someone, it should say so with coral-board task wait-on.", st.Agent, st.Task, age(st.Silent), st.Agent)})
	}
	for _, ni := range r.NameIssues {
		if ni.Edge {
			out = append(out, Item{Rank: 4, Key: "name|edge|" + ni.Name, State: "shown", Text: ni.Name + ": its name starts or ends with punctuation, so mentions may not reach it. Check its name."})
			continue
		}
		out = append(out, Item{Age: ni.Age, Key: "name|mention|" + ni.Name, State: fmt.Sprint(ni.Posts),
			Text: fmt.Sprintf("%s: no mention has reached it in %s while %s a part of its name. Check its name (rename it, or tell the senders the full name).", ni.Name, age(ni.Window), plural(ni.Posts, "post addresses", "posts address"))})
	}
	return out
}

// rosterItems are the roster's items for the list: the ones the caller gave (the monitor leaves out the acknowledged), or, when it gave none, all of them.
func (in CheckInput) rosterItems() []Item {
	if in.RosterItemsSet {
		return in.RosterItems
	}
	return RosterItems(in.Roster, in.Rules)
}

// usageLimitHealthItems: one item per vendor and known reset time; unknown times are never guessed.
func usageLimitHealthItems(entries []BlockedEntry) []Item {
	type group struct {
		vendor string
		at     time.Time
		names  []string
	}
	groups := map[string]*group{}
	for _, b := range entries {
		if b.ModelRefused || b.Vendor == "" {
			continue
		}
		vendor := map[string]string{"claude": "Claude", "codex": "Codex", "agy": "Antigravity", "antigravity": "Antigravity", "gemini": "Antigravity"}[b.Vendor]
		if vendor == "" {
			vendor = "Agent"
		}
		key := vendor + ":" + b.ResetAt.UTC().Format(time.RFC3339)
		g := groups[key]
		if g == nil {
			g = &group{vendor: vendor, at: b.ResetAt}
			groups[key] = g
		}
		g.names = append(g.names, b.Name)
	}
	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out []Item
	for _, k := range keys {
		g := groups[k]
		sort.Strings(g.names)
		noun, verb := "agent", "is"
		if len(g.names) != 1 {
			noun, verb = "agents", "are"
		}
		when := ", reset time unknown"
		if !g.at.IsZero() {
			when = " until " + g.at.Format("Jan 2 15:04 MST")
		}
		out = append(out, Item{Rank: 5, Key: "usage|" + k, State: fmt.Sprint(g.names),
			Text: fmt.Sprintf("%d %s %s %s stopped by a usage limit%s: %s. Nothing to nudge until it resets.", len(g.names), g.vendor, noun, verb, when, strings.Join(g.names, ", "))})
	}
	return out
}

// usageLimitHealthLines are those items' lines, for the tests that pin them.
func usageLimitHealthLines(entries []BlockedEntry) []string {
	var out []string
	for _, it := range usageLimitHealthItems(entries) {
		out = append(out, it.Text)
	}
	return out
}
