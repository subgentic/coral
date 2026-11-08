package board

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14440 (Threading S3): the story of a goal or a task, and one summary per task. A test per rule of Security's conditions on #14430: the same visibility as Needs you (only questions to the Operator),
// joins qualified by the team, redaction before the cut ("(text withheld)" on failure), a strict cursor, bounded sources, the Operator's decisions by the saved goal and task ids.

func keepAll(s string) (string, bool) { return s, true }

// addAsk writes a question from Lead to the given members about the task (and its goal), with the message text as the question line.
func addAsk(t *testing.T, s *Store, team, text string, goalID, taskID int64, to ...string) int64 {
	t.Helper()
	ctx := context.Background()
	m, err := s.insertMessage(ctx, team, "Lead", text, nil, "", "", false, nil)
	require.NoError(t, err)
	require.NoError(t, s.RecordAsk(ctx, team, m, to))
	require.NoError(t, s.RecordAskSubject(ctx, team, m.ID, goalID, taskID))
	return m.ID
}

func addReply(t *testing.T, s *Store, team, from, text string, taskID int64) {
	t.Helper()
	_, err := s.insertMessage(context.Background(), team, from, text, nil, "", "", false, &taskID)
	require.NoError(t, err)
}

func kinds(p *ThreadPage) []string {
	var out []string
	for _, e := range p.Entries {
		out = append(out, e.Kind)
	}
	return out
}

func TestAThreadReadsTheStoryOfATaskAndOfItsGoalInOrder(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	askID := addAsk(t, s, "team-a", "Ship the importer tonight?\nsecond line", goal.ID, task.ID, "Operator")
	addReply(t, s, "team-a", "Dev", "I started on it", task.ID)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActAnswer, "question", itoa(askID), "", "team-a"))

	p, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: keepAll})
	require.NoError(t, err)
	assert.Equal(t, "task", p.Thread.Kind)
	assert.Equal(t, task.Title, p.Thread.Title)
	assert.Equal(t, goal.Title, p.Thread.GoalTitle)
	assert.Contains(t, kinds(p), "task_event")
	assert.Contains(t, kinds(p), "ask")
	assert.Contains(t, kinds(p), "reply")
	assert.Contains(t, kinds(p), "decision")
	for i := 1; i < len(p.Entries); i++ {
		assert.LessOrEqual(t, p.Entries[i-1].At, p.Entries[i].At, "oldest first")
	}
	var ask, decision *ThreadEntry
	for i := range p.Entries {
		switch p.Entries[i].Kind {
		case "ask":
			ask = &p.Entries[i]
		case "decision":
			decision = &p.Entries[i]
		}
	}
	require.NotNil(t, ask)
	assert.Equal(t, "Ship the importer tonight?", ask.Line, "the ask's own first line")
	assert.Equal(t, "open", ask.State, "the Operator has not replied on the board")
	assert.Equal(t, "Lead", ask.Asker)
	require.NotNil(t, decision)
	assert.Equal(t, askID, decision.AskID, "the decision names its question")
	assert.Equal(t, task.ID, decision.TaskID)

	// the goal's own read has the same entries, each with its task, plus the goal's events and one summary per task
	g, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", GoalID: goal.ID, Redact: keepAll})
	require.NoError(t, err)
	assert.Equal(t, "goal", g.Thread.Kind)
	assert.Contains(t, kinds(g), "goal_event")
	require.Len(t, g.Tasks, 1)
	assert.Equal(t, task.ID, g.Tasks[0].TaskID)
	for _, e := range g.Entries {
		if e.Kind == "reply" || e.Kind == "ask" {
			assert.Equal(t, task.ID, e.TaskID)
		}
	}
	// a goal read narrowed to a task of that goal, and one narrowed to a task that is not of it
	n, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", GoalID: goal.ID, TaskID: task.ID, Redact: keepAll})
	require.NoError(t, err)
	assert.Equal(t, "task", n.Thread.Kind)
	other, err := s.CreateTask(ctx, "team-a", "A task of no goal", "", "medium", "Lead")
	require.NoError(t, err)
	_, err = s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", GoalID: goal.ID, TaskID: other.ID, Redact: keepAll})
	assert.ErrorIs(t, err, ErrThreadNotFound, "a task of another goal is not in this one")
}

func TestAThreadIsQualifiedByTheTeam(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	addAsk(t, s, "team-a", "A question for team-a", goal.ID, task.ID, "Operator")
	addReply(t, s, "team-a", "Dev", "a reply on team-a", task.ID)
	// the same ids read as another team: not found, never team-a's entries
	_, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-b", TaskID: task.ID, Redact: keepAll})
	assert.ErrorIs(t, err, ErrThreadNotFound)
	_, err = s.ThreadEntries(ctx, ThreadQuery{Team: "team-b", GoalID: goal.ID, Redact: keepAll})
	assert.ErrorIs(t, err, ErrThreadNotFound)
	// team-b has its own task with the same number space: team-a's ask and reply never appear in its thread
	bt, err := s.CreateTask(ctx, "team-b", "team-b's task", "", "medium", "Lead")
	require.NoError(t, err)
	p, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-b", TaskID: bt.ID, Redact: keepAll})
	require.NoError(t, err)
	for _, e := range p.Entries {
		assert.NotEqual(t, "ask", e.Kind)
		assert.NotEqual(t, "reply", e.Kind)
	}
	// and a task that exists on another team never appears in a summary list for this one
	sums, err := s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-b", Redact: keepAll})
	require.NoError(t, err)
	for _, th := range sums.Threads {
		assert.NotEqual(t, task.ID, th.TaskID, "team-a's task id in team-b's list")
	}
}

func TestAThreadShowsOnlyQuestionsToTheOperator(t *testing.T) {
	s, goal, task := threadFixture(t)
	mine := addAsk(t, s, "team-a", "For the Operator", goal.ID, task.ID, "Operator")
	addAsk(t, s, "team-a", "For another agent", goal.ID, task.ID, "Reviewer")
	p, err := s.ThreadEntries(context.Background(), ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: keepAll})
	require.NoError(t, err)
	var asks []int64
	for _, e := range p.Entries {
		if e.Kind == "ask" {
			asks = append(asks, e.MessageID)
		}
	}
	assert.Equal(t, []int64{mine}, asks, "a question to another member is not the Operator's to see here")
}

func TestThreadTextIsRedactedBeforeItIsCutAndWithheldWhenItFails(t *testing.T) {
	s, _, task := threadFixture(t)
	ctx := context.Background()
	secret := "sk-ABCDEFGHIJKLMNOP"
	long := strings.Repeat("x", ThreadTextCap-5) + secret + " tail"
	addReply(t, s, "team-a", "Dev", long, task.ID)
	addReply(t, s, "team-a", "Dev", "this one is FAILME", task.ID)
	redact := func(in string) (string, bool) {
		if strings.Contains(in, "FAILME") {
			return "", false
		}
		return strings.ReplaceAll(in, secret, "[redacted]"), true
	}
	p, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: redact})
	require.NoError(t, err)
	var texts []string
	for _, e := range p.Entries {
		if e.Kind == "reply" {
			texts = append(texts, e.Text)
			assert.NotContains(t, e.Text, "sk-", "the secret is gone before the cut: no fragment of it is left")
			assert.LessOrEqual(t, len([]rune(e.Text)), ThreadTextCap)
		}
	}
	assert.Contains(t, texts, ThreadWithheld, "a text the redaction fails is withheld, never shown raw")
	// no redaction function at all: every text is withheld
	p, err = s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: task.ID})
	require.NoError(t, err)
	for _, e := range p.Entries {
		if e.Kind == "reply" {
			assert.Equal(t, ThreadWithheld, e.Text)
		}
		if e.Kind == "task_event" {
			assert.Empty(t, e.Text)
		}
	}
}

func TestAThreadPagesWithAStrictCursor(t *testing.T) {
	s, _, task := threadFixture(t)
	ctx := context.Background()
	for i := 0; i < 7; i++ {
		addReply(t, s, "team-a", "Dev", "reply "+itoa(int64(i)), task.ID)
	}
	all, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: keepAll, Limit: ThreadMaxLimit})
	require.NoError(t, err)
	require.False(t, all.More)
	for _, order := range []string{"asc", "desc"} {
		var got []string
		cursor := ""
		for pages := 0; pages < 20; pages++ {
			p, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: keepAll, Limit: 3, After: cursor, Order: order})
			require.NoError(t, err)
			for _, e := range p.Entries {
				got = append(got, e.ID)
			}
			if !p.More {
				break
			}
			require.NotEmpty(t, p.Cursor)
			cursor = p.Cursor
		}
		assert.Len(t, got, len(all.Entries), order+": every entry once")
		seen := map[string]bool{}
		for _, id := range got {
			assert.False(t, seen[id], "%s: %s twice", order, id)
			seen[id] = true
		}
	}
	// a cursor this read did not give is refused
	for _, bad := range []string{"x", "!!!", "YWJj", "", "bm90fGF8Y3Vyc29y"} {
		if bad == "" {
			continue
		}
		_, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: keepAll, After: bad})
		assert.ErrorIs(t, err, ErrThreadCursor, bad)
	}
	// a limit above the maximum is cut to it
	p, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: keepAll, Limit: 100000})
	require.NoError(t, err)
	assert.LessOrEqual(t, len(p.Entries), ThreadMaxLimit)
}

func TestEachSourceOfAThreadIsBounded(t *testing.T) {
	s, _, task := threadFixture(t)
	for i := 0; i < threadSourceCap+5; i++ {
		addReply(t, s, "team-a", "Dev", "r", task.ID)
	}
	p, err := s.ThreadEntries(context.Background(), ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: keepAll, Limit: ThreadMaxLimit})
	require.NoError(t, err)
	assert.True(t, p.Capped, "a source that hit its bound says so")
	assert.True(t, p.More)
	assert.Len(t, p.Entries, ThreadMaxLimit)
}

func TestAHubTeamOwnerReadsTheirOwnDecisionsInAThread(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	a1 := addAsk(t, s, "team-a", "one", goal.ID, task.ID, "Operator")
	a2 := addAsk(t, s, "team-a", "two", goal.ID, task.ID, "Operator")
	require.NoError(t, s.RecordActivity(ctx, ActivityMeta{Actor: "hub:alice", Source: "hub"}, ActAnswer, "question", itoa(a1), "", "team-a"))
	require.NoError(t, s.RecordActivity(ctx, ActivityMeta{Actor: "hub:bob", Source: "hub"}, ActAnswer, "question", itoa(a2), "", "team-a"))
	count := func(actor string) int {
		p, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: keepAll, Actor: actor})
		require.NoError(t, err)
		n := 0
		for _, e := range p.Entries {
			if e.Kind == "decision" {
				n++
				if actor != "" {
					assert.Equal(t, actor, e.Actor)
				}
			}
		}
		return n
	}
	assert.Equal(t, 2, count(""), "this computer's own person reads every row of its record")
	assert.Equal(t, 1, count("hub:alice"), "a team owner reads their own rows alone")
}

func TestTaskSummariesCarryWaitingLatestLastDecisionAndCounts(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	// a second task of the goal with nothing waiting
	quiet, err := s.CreateTask(ctx, "team-a", "A quiet task", "", "medium", "Lead")
	require.NoError(t, err)
	gid := goal.ID
	require.NoError(t, s.SetTaskGoal(ctx, "team-a", quiet.ID, &gid))
	open := addAsk(t, s, "team-a", "Is this the right shape?", goal.ID, task.ID, "Operator")
	done := addAsk(t, s, "team-a", "Already settled?", goal.ID, task.ID, "Operator")
	addReply(t, s, "team-a", "Dev", "working on it", task.ID)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActAnswer, "question", itoa(done), "", "team-a"))
	time.Sleep(2 * time.Millisecond)
	_ = open

	page, err := s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", Redact: keepAll})
	require.NoError(t, err)
	by := map[int64]TaskSummary{}
	for _, th := range page.Threads {
		by[th.TaskID] = th
	}
	require.Contains(t, by, task.ID)
	require.Contains(t, by, quiet.ID)
	sum := by[task.ID]
	assert.Equal(t, 2, sum.Counts.Asks)
	assert.Equal(t, 1, sum.Counts.Replies)
	assert.Equal(t, 1, sum.Counts.Decisions)
	assert.GreaterOrEqual(t, sum.Waiting, 1, "an open question to the Operator")
	require.NotNil(t, sum.Latest)
	assert.NotEmpty(t, sum.Latest.Line)
	require.NotNil(t, sum.LastDecision)
	assert.Equal(t, ActAnswer, sum.LastDecision.Action)
	assert.Equal(t, goal.Title, sum.GoalTitle)
	assert.Nil(t, by[quiet.ID].LastDecision)
	assert.Equal(t, 0, by[quiet.ID].Waiting)

	// the state filter, and the goal narrowing
	w, err := s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", State: "waiting", Redact: keepAll})
	require.NoError(t, err)
	for _, th := range w.Threads {
		assert.Greater(t, th.Waiting, 0)
	}
	d, err := s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", State: "decided", Redact: keepAll})
	require.NoError(t, err)
	require.Len(t, d.Threads, 1)
	assert.Equal(t, task.ID, d.Threads[0].TaskID)
	g, err := s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", GoalID: goal.ID, Redact: keepAll})
	require.NoError(t, err)
	assert.Len(t, g.Threads, 2)
	_, err = s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-b", GoalID: goal.ID, Redact: keepAll})
	assert.ErrorIs(t, err, ErrThreadNotFound, "a goal of another team")

	// paging: one per page, every task once, a bad cursor refused; a task of no goal is not in the list
	var ids []int64
	cursor := ""
	for i := 0; i < 5; i++ {
		p, err := s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", Limit: 1, After: cursor, Redact: keepAll})
		require.NoError(t, err)
		for _, th := range p.Threads {
			ids = append(ids, th.TaskID)
		}
		if !p.More {
			break
		}
		cursor = p.Cursor
	}
	assert.ElementsMatch(t, []int64{task.ID, quiet.ID}, ids)
	_, err = s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", After: "garbage", Redact: keepAll})
	assert.ErrorIs(t, err, ErrThreadCursor)
	// text in a summary is redacted before the cut too
	r, err := s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", Redact: func(string) (string, bool) { return "", false }})
	require.NoError(t, err)
	for _, th := range r.Threads {
		require.NotNil(t, th.Latest)
		assert.NotContains(t, th.Latest.Line, "Is this the right shape", "no raw text when the redaction fails")
	}
}

// Security's SHOULD on #14440: what an agent wrote reaches the page clean. An escape sequence and a right-to-left override in a reply, in an ask's line, in a title and in the Operator's own note are
// removed; the excerpt keeps its line breaks and a one-line field loses them.
func TestThreadTextHasNoTerminalControlOrReorderingCharacters(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	dirty := "\x1b[31mred\x1b[0m ‮evil‬ and \x1b]0;title\x07ok"
	addReply(t, s, "team-a", "Dev", "first line "+dirty+"\nsecond line", task.ID)
	addAsk(t, s, "team-a", dirty+"\nsecond line of the ask", goal.ID, task.ID, "Operator")
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActAnswer, "question", "1", "", "team-a"))
	p, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", GoalID: goal.ID, Redact: keepAll})
	require.NoError(t, err)
	bad := func(s string) bool {
		return strings.ContainsAny(s, "\x1b\x07‮‬")
	}
	var sawReply, sawAsk bool
	for _, e := range p.Entries {
		for _, f := range []string{e.Text, e.Line, e.Title, e.Note, e.Name, e.Asker, e.From} {
			assert.False(t, bad(f), "%s: %q", e.Kind, f)
		}
		switch e.Kind {
		case "reply":
			sawReply = true
			assert.Contains(t, e.Text, "\n", "the excerpt keeps its line breaks")
			assert.Contains(t, e.Text, "red")
		case "ask":
			sawAsk = true
			assert.NotContains(t, e.Line, "\n", "a one-line field has no line break")
			assert.Contains(t, e.Line, "evil")
		}
	}
	assert.True(t, sawReply && sawAsk)
	// the titles carried in the header and the summaries
	task2, err := s.CreateTask(ctx, "team-a", "Title \x1b[31mwith\x1b[0m ‮control", "", "medium", "Lead")
	require.NoError(t, err)
	gid := goal.ID
	require.NoError(t, s.SetTaskGoal(ctx, "team-a", task2.ID, &gid))
	h, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: task2.ID, Redact: keepAll})
	require.NoError(t, err)
	assert.False(t, bad(h.Thread.Title), "%q", h.Thread.Title)
	assert.False(t, bad(h.Thread.TaskTitle))
	sums, err := s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", Redact: keepAll})
	require.NoError(t, err)
	for _, th := range sums.Threads {
		assert.False(t, bad(th.Title), "%q", th.Title)
		if th.Latest != nil {
			assert.False(t, bad(th.Latest.Line), "%q", th.Latest.Line)
		}
	}
}
