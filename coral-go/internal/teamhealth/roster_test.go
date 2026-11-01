package teamhealth

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func rosterNow() time.Time { return time.Date(2026, 10, 18, 8, 5, 0, 0, time.UTC) }

func counts(working, waiting, prompt, idle, asleep, offline int) map[string]int {
	return map[string]int{StateWorking: working, StateWaiting: waiting, StatePrompt: prompt, StateIdle: idle, StateAsleep: asleep, StateOffline: offline}
}

func min10(n int) time.Duration { return time.Duration(n) * time.Minute }

func listIn(r *Roster) CheckInput {
	return CheckInput{Now: rosterNow(), Agents: 14, Roster: r, Progress: Progress{Since: rosterNow().Add(-10 * time.Minute), Posts: 55}}
}

// Rules 1 and 7 (#11729): the check opens with what the orchestrator is to do, waits on the recipient first (with the waiter's last message number), then the oldest; the counts are last.
func TestActionListOpensWithWhatToDoOldestFirstAndEndsWithCounts(t *testing.T) {
	r := &Roster{Recipient: "Orchestrator", Counts: counts(2, 8, 0, 0, 4, 0),
		Waits: []WaitGroup{
			{On: "Security Reviewer", Waiters: []WaitEntry{{Name: "Frontend Dev", Age: min10(37), TargetSilent: true}, {Name: "Lead Developer", Age: min10(17), Stale: true}}},
			{On: "Orchestrator", You: true, Waiters: []WaitEntry{{Name: "QA Engineer", Age: min10(12), Reply: 140100}, {Name: "DevOps Engineer", Age: min10(19)}}},
		},
		Asleep: []AsleepUnread{{Name: "Digital Ocean Expert", Count: 2, Since: time.Date(2026, 10, 18, 7, 23, 0, 0, time.UTC)}},
	}
	lines := ComposeLines(listIn(r))
	assert.Equal(t, "[Coral health check] 08:05Z · Orchestrator, act on these (oldest first):", lines[0])
	assert.Equal(t, "1) DevOps Engineer has waited 19 min on YOU. Answer them.", lines[1], "what waits on the recipient is first, oldest first")
	assert.Equal(t, "2) QA Engineer has waited 12 min on YOU (their last message is #140100). Answer them.", lines[2])
	assert.Equal(t, "3) Digital Ocean Expert is asleep with 2 messages tagged to it unread since 07:23. Wake it.", lines[3], "then the oldest of the rest: 42 min")
	assert.Equal(t, "4) Frontend Dev has waited 37 min on Security Reviewer; Security Reviewer has not mentioned them since. Ask Security Reviewer what is holding it, or check Security Reviewer.", lines[4])
	assert.Equal(t, "5) Lead Developer has waited 17 min although Security Reviewer has posted a message mentioning them since: check Lead Developer.", lines[5])
	assert.Equal(t, "Since 07:55: 55 posts.", lines[len(lines)-2], "post volume is a count, never 'progressing'")
	assert.Equal(t, "Counts: 2 working · 8 waiting · 4 asleep · 0 claimable tasks", lines[len(lines)-1], "the counts are last")
	out := Compose(listIn(r))
	assert.NotContains(t, out, "\n", "typed as one paste")
	assert.NotContains(t, strings.ToLower(out), "progressing")
}

// Rule 2: a wait is listed when it is older than the threshold and its target has not mentioned the waiter since; a target that has is serving it, and a younger wait is not yet a finding.
func TestStuckWaitNeedsALongWaitAndASilentTarget(t *testing.T) {
	waits := func(w WaitEntry) CheckInput {
		return listIn(&Roster{Recipient: "O", Counts: counts(1, 1, 0, 0, 0, 0), Waits: []WaitGroup{{On: "Y", Waiters: []WaitEntry{w}}}})
	}
	text := func(in CheckInput) string { return strings.Join(ComposeLines(in), "\n") }
	assert.Contains(t, text(waits(WaitEntry{Name: "X", Age: min10(11), TargetSilent: true})), "X has waited 11 min on Y; Y has not mentioned them since")
	assert.NotContains(t, text(waits(WaitEntry{Name: "X", Age: min10(30), TargetSilent: false})), "has waited", "Y has posted since: the wait is being served")
	assert.NotContains(t, text(waits(WaitEntry{Name: "X", Age: min10(10), TargetSilent: true})), "has waited", "not past the threshold")
	in := waits(WaitEntry{Name: "X", Age: min10(6), TargetSilent: true})
	in.Rules.StuckWait = min10(5)
	assert.Contains(t, text(in), "X has waited 6 min on Y", "the threshold is a setting")
	assert.Contains(t, text(waits(WaitEntry{Name: "X", Age: min10(30), TargetSilent: true, Reason: "task #12"})), "(for task #12)", "the wait's reason is said (rule 11)")
}

// Rule 5: more than K open tasks on one agent while at least M agents sleep; not at K, and not when nobody sleeps.
func TestOverloadedAgentWhileOthersSleep(t *testing.T) {
	mk := func(open, asleep int) string {
		r := &Roster{Recipient: "O", Counts: counts(2, 0, 0, 0, asleep, 0), Open: map[string]int{"Busy Dev": open, "Calm Dev": 1}}
		return strings.Join(ComposeLines(listIn(r)), "\n")
	}
	assert.Contains(t, mk(6, 2), "Busy Dev holds 6 open tasks while 2 agents sleep. Reassign some, or wake a sleeper.")
	assert.NotContains(t, mk(5, 2), "holds", "5 is not more than 5")
	assert.NotContains(t, mk(9, 0), "holds", "nobody sleeps: nothing to hand it to")
	assert.NotContains(t, mk(6, 2), "Calm Dev holds")
	in := listIn(&Roster{Recipient: "O", Counts: counts(2, 0, 0, 0, 1, 0), Open: map[string]int{"Busy Dev": 3}})
	in.Rules.Overloaded = 2
	assert.Contains(t, strings.Join(ComposeLines(in), "\n"), "Busy Dev holds 3 open tasks while 1 agent sleeps")
}

// Rule 6: a task in review for more than H hours.
func TestStaleReviewAfterHours(t *testing.T) {
	r := &Roster{Recipient: "O", Counts: counts(1, 0, 0, 0, 0, 0), Reviews: []ReviewAge{{Task: 77, With: "QA Engineer", Age: 25 * time.Hour}, {Task: 78, With: "QA Engineer", Age: 23 * time.Hour}}}
	text := strings.Join(ComposeLines(listIn(r)), "\n")
	assert.Contains(t, text, "Task #77 has been in review with QA Engineer for 25 h. Ask QA Engineer, or give the review to someone else.")
	assert.NotContains(t, text, "#78")
	in := listIn(r)
	in.Rules.StaleReview = 22 * time.Hour
	assert.Contains(t, strings.Join(ComposeLines(in), "\n"), "#78")
}

// Rule 8: what only the Operator can do is a section of its own, oldest first, with its age, so it is relayed in one batch.
func TestNeedsTheOperatorIsOneSectionOldestFirst(t *testing.T) {
	in := listIn(&Roster{Recipient: "O", Counts: counts(1, 0, 0, 0, 0, 0)})
	in.Questions = []Question{{Asker: "Dev", Text: ShownText("ship it?", nil), Since: rosterNow().Add(-50 * time.Minute)}}
	in.Questions = append(in.Questions, Question{Asker: "QA", Text: ShownText("which colour?", nil), Since: rosterNow().Add(-3 * time.Hour)})
	lines := ComposeLines(in)
	at := -1
	for i, l := range lines {
		if strings.HasPrefix(l, "Needs the Operator") {
			at = i
		}
	}
	if assert.NotEqual(t, -1, at, strings.Join(lines, "\n")) {
		assert.Equal(t, "QA, 3 h ago: quoted: which colour?", lines[at+1], "the oldest first")
		assert.Equal(t, "Dev, 50 min ago: quoted: ship it?", lines[at+2])
	}
	assert.NotContains(t, strings.Join(lines, "\n"), "Nothing needs you")
	assert.NotContains(t, strings.Join(lines, "\n"), "act on these", "no action for the orchestrator: no such header")
}

func TestActionListAllClearAndAllWorking(t *testing.T) {
	in := listIn(&Roster{Recipient: "Orchestrator", Counts: counts(3, 0, 0, 0, 1, 0)})
	in.Progress = Progress{Since: rosterNow().Add(-10 * time.Minute), Completed: 2, Posts: 40}
	lines := ComposeLines(in)
	assert.Equal(t, "[Coral health check] 08:05Z · Nothing needs you.", lines[0])
	assert.Contains(t, strings.Join(lines, "\n"), "Since 07:55: 2 tasks completed, 40 posts.")
	in.Progress = Progress{Since: rosterNow().Add(-10 * time.Minute)}
	assert.Contains(t, strings.Join(ComposeLines(in), "\n"), "No progress since the last check (07:55).")
	// a goal that needs the Operator changes the words
	in.Goals = []GoalLine{{ID: 1, Title: "g", State: "active", Remind: RemindOperator}}
	assert.Contains(t, ComposeLines(in)[0], "No agent needs you.")
	// an idle agent is counted, a prompt too
	in = listIn(&Roster{Recipient: "O", Counts: counts(2, 0, 1, 1, 0, 2)})
	last := ComposeLines(in)
	assert.Contains(t, last[len(last)-1], "1 need input")
	assert.Contains(t, last[len(last)-1], "1 idle")
	assert.Contains(t, last[len(last)-1], "2 offline")
}

// Rule 9: a line is never cut; a long list shows the top in full and says how many more, and where.
func TestActionListNeverCutsALineAndStaysWithinTheCap(t *testing.T) {
	var items []Item
	for i := 0; i < 200; i++ {
		items = append(items, Item{Rank: i, Age: time.Duration(200-i) * time.Minute, Agent: fmt.Sprintf("Agent %d", i), Problem: "idle " + strings.Repeat("x", 60), Suggest: "assign it"})
	}
	var qs []Question
	for i := 0; i < 80; i++ {
		qs = append(qs, Question{Asker: fmt.Sprintf("Asker %d", i), Text: strings.Repeat("y", 50), Since: rosterNow().Add(-time.Duration(i+1) * time.Minute)})
	}
	in := CheckInput{Now: rosterNow(), Items: items, Questions: qs, Progress: Progress{Since: rosterNow()}, Roster: &Roster{Recipient: "O", Counts: counts(0, 0, 0, 200, 0, 0)}}
	lines := ComposeLines(in)
	out := Compose(in)
	assert.LessOrEqual(t, len(out), MaxCheck)
	var more []string
	for _, l := range lines {
		if strings.HasPrefix(l, "and ") {
			more = append(more, l)
		}
		if strings.HasPrefix(l, "1) Agent") || strings.Contains(l, "Agent ") && strings.HasSuffix(l, "Suggest: assign it.") {
			assert.True(t, strings.HasSuffix(l, "Suggest: assign it."), "every shown line is whole: %q", l)
		}
	}
	assert.Len(t, more, 2, "the actions and the Operator's lines each say how many more: %v", more)
	for _, m := range more {
		assert.True(t, strings.HasSuffix(m, "more: coral-board status") || strings.Contains(m, " more: coral-board status"), m)
	}
	assert.Equal(t, "Counts: 0 working · 0 waiting · 200 idle · 0 asleep · 0 claimable tasks", lines[len(lines)-1], "the counts survive")
}

func TestBlockedAgentIsALineThatSaysNothingToNudge(t *testing.T) {
	r := &Roster{Recipient: "O", Counts: counts(1, 0, 0, 0, 0, 0), Blocked: []BlockedEntry{{Name: "Codex Dev", Resets: min10(40)}, {Name: "Pi Dev"}}}
	text := strings.Join(ComposeLines(listIn(r)), "\n")
	assert.Contains(t, text, "Codex Dev is blocked by a usage limit (resets in 40 min): nothing to nudge until it resets or its plan changes.")
	assert.Contains(t, text, "Pi Dev is blocked by a usage limit: nothing to nudge")
}

// An agent stopped at a dialog (rank 0) is said right after what waits on the recipient, before older lines (#11431); the rest are oldest first.
func TestAnAgentAtADialogIsPinnedAboveOlderLines(t *testing.T) {
	in := listIn(&Roster{Recipient: "O", Counts: counts(1, 0, 1, 1, 0, 0)})
	in.Items = []Item{
		{Rank: 2, Age: 45 * time.Minute, Agent: "Idler", Problem: "idle 45 min", Suggest: "assign it"},
		{Rank: 0, Age: 12 * time.Minute, Agent: "Prompted", Problem: "needs input", Suggest: "read its terminal"},
		{Rank: 2, Age: 60 * time.Minute, Agent: "Older", Problem: "idle 60 min", Suggest: "assign it"},
	}
	lines := ComposeLines(in)
	assert.Contains(t, lines[1], "Prompted: needs input")
	assert.Contains(t, lines[2], "Older: idle 60 min")
	assert.Contains(t, lines[3], "Idler: idle 45 min")
}

// Rule 4 (#11729): a member mentions may not reach is a line, with what to do about it; a new one is news for the quiet gate, its age ticking is not.
func TestNameIssuesAreLinesAndFacts(t *testing.T) {
	r := &Roster{Recipient: "O", Counts: counts(2, 0, 0, 0, 0, 0), NameIssues: []NameIssue{
		{Name: "Backend Dev", Posts: 2, Window: 30 * time.Minute, Age: 20 * time.Minute},
		{Name: ".Odd", Edge: true},
	}}
	text := strings.Join(ComposeLines(listIn(r)), "\n")
	assert.Contains(t, text, "Backend Dev: no mention has reached it in 30 min while 2 posts address a part of its name. Check its name (rename it, or tell the senders the full name).")
	assert.Contains(t, text, ".Odd: its name starts or ends with punctuation, so mentions may not reach it. Check its name.")
	before := r.Facts()
	r.NameIssues[0].Age = 25 * time.Minute
	assert.Equal(t, before, r.Facts(), "the age ticking is not news")
	r.NameIssues = append(r.NameIssues, NameIssue{Name: "Third", Posts: 1, Window: 30 * time.Minute})
	assert.NotEqual(t, before, r.Facts(), "a new one is")
}
