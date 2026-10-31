package teamhealth

import (
	"fmt"
	"sort"
	"strings"
)

// The GOALS segment of the orchestrator's check (#11412). The operator asked that what needs them reaches their Needs you: the check lists every open goal in one entry, ready ones first, and says for the ones the
// operator has to look at what to do, until an open ask to the Operator names the goal or the goal is closed. Titles are the operator's and the orchestrator's own words, but they go through the sanitizer all the
// same (StoredText: invisibles dropped, redacted, one line, @ neutralised) and are cut at goalTitleMax.

const (
	// goalTitleMax and goalBlockedMax cut the words of a goal shown in the check.
	goalTitleMax   = 50
	goalBlockedMax = 60
	// GoalsMax is how many goals the segment names; the rest are counted.
	GoalsMax = 8
	// goalsBudget keeps the segment from crowding the rest of the check out of MaxCheck.
	goalsBudget = 2400
)

// Reminders a goal can carry.
const (
	RemindNone     = ""
	RemindClose    = "close" // every task is done: close it, or put an item for the operator's review in their inbox
	RemindOperator = "operator"
)

// GoalLine is one open goal, as the check shows it.
type GoalLine struct {
	ID          int64
	Title       string
	State       string // proposed, active or blocked
	BlockedOn   string
	Driver      string
	Done, Total int
	Remind      string // RemindNone, RemindClose or RemindOperator
}

func (g GoalLine) rank() int {
	switch g.Remind {
	case RemindClose:
		return 0
	case RemindOperator:
		return 1
	}
	return 2
}

// goalsRemind reports whether any goal carries a reminder: the check then does not say "Nothing needs you", since the operator is needed.
func (in CheckInput) goalsRemind() bool {
	for _, g := range in.Goals {
		if g.Remind != RemindNone {
			return true
		}
	}
	return false
}

// goalEntry is one goal on one line of text: `#92 "title" 2/5 blocked: reason (driver Name)` and, where the operator must act, what to do.
func goalEntry(g GoalLine) string {
	var b strings.Builder
	fmt.Fprintf(&b, "#%d", g.ID)
	if t := clean(StoredText(g.Title, nil), goalTitleMax); t != "" {
		fmt.Fprintf(&b, " %q", t)
	}
	fmt.Fprintf(&b, " %d/%d", g.Done, g.Total)
	if g.State != "" {
		b.WriteString(" " + clean(g.State, 16))
	}
	if g.State == "blocked" {
		if on := clean(StoredText(g.BlockedOn, nil), goalBlockedMax); on != "" {
			fmt.Fprintf(&b, ", in the goal's words: %q", on) // quoted like the title: it is text someone wrote, not Coral's
		}
	}
	if d := Name(g.Driver); d != "" {
		fmt.Fprintf(&b, " (driver %s)", d)
	}
	switch g.Remind {
	case RemindClose:
		b.WriteString(" READY: close it, or put an item in the operator's inbox")
	case RemindOperator:
		b.WriteString(" NEEDS THE OPERATOR: put an item in their inbox")
	}
	return b.String()
}

// goalsLine is the segment ("" when there is no open goal): ready goals first, then those that need the operator, then the rest by number; at most GoalsMax entries and goalsBudget bytes, the rest counted; when any
// goal carries a reminder, how to do it is said once at the end.
func goalsLine(goals []GoalLine) string {
	if len(goals) == 0 {
		return ""
	}
	gs := append([]GoalLine(nil), goals...)
	sort.SliceStable(gs, func(i, j int) bool {
		if gs[i].rank() != gs[j].rank() {
			return gs[i].rank() < gs[j].rank()
		}
		return gs[i].ID < gs[j].ID
	})
	legend := ""
	for _, g := range gs {
		if g.Remind != RemindNone {
			legend = " To close: coral-board goal close N --reason \"...\". For their inbox: coral-board post --ask \"@Operator goal N: what to check or decide\" (naming the goal ends this reminder)."
			break
		}
	}
	for shown := min(len(gs), GoalsMax); ; shown-- {
		parts := make([]string, 0, shown)
		for _, g := range gs[:shown] {
			parts = append(parts, goalEntry(g))
		}
		out := "Goals: " + strings.Join(parts, "; ")
		if more := len(gs) - shown; more > 0 {
			out += fmt.Sprintf("; and %d more", more)
		}
		out += "." + legend
		if len(out) <= goalsBudget || shown <= 1 {
			return out
		}
	}
}
