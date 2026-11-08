package board

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14472 (QA review of #14440): Security's condition "joins qualified by the team" and "bounded sources" and "a strict cursor", pinned against rows the way a bad write would leave them. Task, goal and message
// ids are one number space on a computer, so a read of team-b with team-a's id is not found (TestAThreadIsQualifiedByTheTeam) and the project predicates below look redundant: they are what keeps a row of
// ANOTHER team that names this team's task, goal or message out of this team's thread. These tests plant such rows and read this team's thread. Mutants that remove one predicate each (see the review) fail here.

// crossTeamWorld is team-a's thread (a goal, two tasks, an own question, reply and decision-free history) plus rows of team-b that name team-a's ids.
type crossTeamWorld struct {
	s           *Store
	goal        *Goal
	task, task2 *Task
	askA        int64
	foreignTask *Task
}

func newCrossTeamWorld(t *testing.T) *crossTeamWorld {
	t.Helper()
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	task2, err := s.CreateTask(ctx, "team-a", "A second task", "", "medium", "Lead")
	require.NoError(t, err)
	gid := goal.ID
	require.NoError(t, s.SetTaskGoal(ctx, "team-a", task2.ID, &gid))
	w := &crossTeamWorld{s: s, goal: goal, task: task, task2: task2}
	w.askA = addAsk(t, s, "team-a", "A-OWN-QUESTION", goal.ID, task.ID, "Operator")
	addReply(t, s, "team-a", "Dev", "A-OWN-REPLY", task.ID)
	// rows of team-b that carry team-a's ids
	addReply(t, s, "team-b", "Dev", "B-FOREIGN-REPLY", task.ID)
	addAsk(t, s, "team-b", "B-FOREIGN-ASK", goal.ID, task.ID, "Operator")
	bg, err := s.CreateGoal(ctx, "team-b", GoalInput{Title: "B-GOAL-TITLE", CreatedBy: "Lead"})
	require.NoError(t, err)
	require.NoError(t, s.RecordActivity(ctx, ActivityMeta{Actor: "local", Source: "local"}, ActGoalEdit, "goal", strconv.FormatInt(bg.ID, 10), "B-FOREIGN-NOTE", "team-b"))
	_, err = s.db.ExecContext(ctx, `UPDATE operator_actions SET goal_id = ?, task_id = ? WHERE team = 'team-b'`, goal.ID, task.ID)
	require.NoError(t, err)
	// a team-b task that names team-a's goal, and a team-a task that names team-b's goal
	w.foreignTask, err = s.CreateTask(ctx, "team-b", "B-FOREIGN-TASK", "", "medium", "Lead")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET goal_id = ? WHERE id = ?`, goal.ID, w.foreignTask.ID)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET goal_id = ? WHERE id = ?`, bg.ID, task2.ID)
	require.NoError(t, err)
	return w
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return string(b)
}

func TestAThreadNeverReadsAnotherTeamsRowsThatNameThisTeamsIds(t *testing.T) {
	w := newCrossTeamWorld(t)
	ctx := context.Background()
	for name, q := range map[string]ThreadQuery{
		"the task": {Team: "team-a", TaskID: w.task.ID, Redact: keepAll, Limit: ThreadMaxLimit},
		"the goal": {Team: "team-a", GoalID: w.goal.ID, Redact: keepAll, Limit: ThreadMaxLimit},
	} {
		p, err := w.s.ThreadEntries(ctx, q)
		require.NoError(t, err, name)
		raw := asJSON(t, p)
		assert.Contains(t, raw, "A-OWN-QUESTION", name+": its own question is there")
		assert.Contains(t, raw, "A-OWN-REPLY", name+": its own reply is there")
		assert.NotContains(t, raw, "B-FOREIGN-REPLY", name+": a team-b reply that names this task id is not this team's (replies are read by project)")
		assert.NotContains(t, raw, "B-FOREIGN-ASK", name+": a team-b question that names this task id is not this team's (asks are read by project)")
		for _, e := range p.Entries {
			assert.NotEqual(t, "decision", e.Kind, name+": a team-b decision that names this task id is not this team's (decisions are read by team)")
		}
		assert.NotContains(t, raw, "B-FOREIGN-TASK", name+": a team-b task that names this goal is not one of its tasks (tasks are read by board)")
	}
}

func TestAThreadNeverJoinsAnAskToAnotherTeamsSubjectOrText(t *testing.T) {
	w := newCrossTeamWorld(t)
	ctx := context.Background()
	// the subject row of team-a's question is saved under team-b and names task2: the join must not take it for team-a's
	_, err := w.s.db.ExecContext(ctx, `UPDATE board_ask_subjects SET project = 'team-b', task_id = ? WHERE message_id = ?`, w.task2.ID, w.askA)
	require.NoError(t, err)
	p, err := w.s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: w.task2.ID, Redact: keepAll, Limit: ThreadMaxLimit})
	require.NoError(t, err)
	assert.NotContains(t, asJSON(t, p), "A-OWN-QUESTION", "an ask whose subject row belongs to another team is not on this team's task (ask_subjects joined by project)")
	// the text of another team's message is never read for team-a's question
	w2 := newCrossTeamWorld(t)
	_, err = w2.s.db.ExecContext(ctx, `UPDATE board_messages SET project = 'team-b' WHERE id = ?`, w2.askA)
	require.NoError(t, err)
	p, err = w2.s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: w2.task.ID, Redact: keepAll, Limit: ThreadMaxLimit})
	require.NoError(t, err)
	assert.NotContains(t, asJSON(t, p), "A-OWN-QUESTION", "the question's text is a team-b message: it is not read for team-a (messages joined by project)")
}

func TestTheSummariesNeverCountOrShowAnotherTeamsRows(t *testing.T) {
	w := newCrossTeamWorld(t)
	ctx := context.Background()
	page, err := w.s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", Redact: keepAll, Limit: ThreadMaxLimit})
	require.NoError(t, err)
	raw := asJSON(t, page)
	for _, banned := range []string{"B-FOREIGN-REPLY", "B-FOREIGN-ASK", "B-FOREIGN-TASK", "B-GOAL-TITLE", "B-FOREIGN-NOTE"} {
		assert.NotContains(t, raw, banned, "team-b's "+banned+" is not in team-a's summaries")
	}
	var mine *TaskSummary
	for i := range page.Threads {
		if page.Threads[i].TaskID == w.task.ID {
			mine = &page.Threads[i]
		}
		assert.NotEqual(t, w.foreignTask.ID, page.Threads[i].TaskID, "a team-b task is not in team-a's list")
	}
	require.NotNil(t, mine)
	assert.Equal(t, 1, mine.Counts.Replies, "one reply of team-a's: team-b's reply naming this task is not counted")
	assert.Equal(t, 1, mine.Waiting, "one open question of team-a's: team-b's is not counted")
	assert.Equal(t, 0, mine.Counts.Decisions, "no decision of team-a's: team-b's row naming this task is not counted")
	assert.Nil(t, mine.LastDecision, "and it is not the last decision")
	// the second task names team-b's goal: team-b's goal title is not shown for it
	for _, th := range page.Threads {
		if th.TaskID == w.task2.ID {
			assert.NotContains(t, th.GoalTitle, "B-GOAL-TITLE", "a goal of another team is not read for this team's task")
		}
	}
	// a summary list's asks are joined by project too
	_, err = w.s.db.ExecContext(ctx, `UPDATE board_ask_subjects SET project = 'team-b' WHERE message_id = ?`, w.askA)
	require.NoError(t, err)
	page, err = w.s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", Redact: keepAll, Limit: ThreadMaxLimit})
	require.NoError(t, err)
	for _, th := range page.Threads {
		if th.TaskID == w.task.ID {
			assert.Equal(t, 0, th.Waiting, "a question whose subject row is team-b's does not wait on team-a's task")
		}
	}
	_, err = w.s.db.ExecContext(ctx, `UPDATE board_ask_subjects SET project = 'team-a' WHERE message_id = ?`, w.askA)
	require.NoError(t, err)
	// the newest entry of the task is a question whose message is team-b's: its text is the summary's line only if the join is not qualified
	late := addAsk(t, w.s, "team-a", "A-LATEST-QUESTION", w.goal.ID, w.task.ID, "Operator")
	_, err = w.s.db.ExecContext(ctx, `UPDATE board_messages SET project = 'team-b' WHERE id = ?`, late)
	require.NoError(t, err)
	_, err = w.s.db.ExecContext(ctx, `UPDATE board_asks SET created_at = '2099-01-01T00:00:00Z' WHERE message_id = ?`, late) // clearly the newest entry: the summary's line is its text
	require.NoError(t, err)
	page, err = w.s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", Redact: keepAll, Limit: ThreadMaxLimit})
	require.NoError(t, err)
	assert.NotContains(t, asJSON(t, page), "A-LATEST-QUESTION", "the text of a team-b message is not read for team-a's question (the summary's messages are joined by project)")
}

func TestAThreadCursorIsRefusedUnlessItIsExactlyOneThisReadGave(t *testing.T) {
	s, _, task := threadFixture(t)
	ctx := context.Background()
	enc := func(raw string) string { return base64.RawURLEncoding.EncodeToString([]byte(raw)) }
	now := "2026-11-07T10:00:00Z"
	for name, c := range map[string]string{
		"two parts":                   enc(now + "|0"),
		"one part":                    enc(now),
		"an empty id":                 enc(now + "|0|"),
		"a time that is not a time":   enc("yesterday|0|ask:1"),
		"a rank below the range":      enc(now + "|-1|ask:1"),
		"a rank above the range":      enc(now + "|7|ask:1"),
		"a rank that is not a number": enc(now + "|x|ask:1"),
		"not base64 at all":           "!!!",
	} {
		_, err := s.ThreadEntries(ctx, ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: keepAll, After: c})
		assert.ErrorIs(t, err, ErrThreadCursor, name)
		_, err = s.ThreadSummaries(ctx, ThreadsQuery{Team: "team-a", Redact: keepAll, After: c})
		assert.ErrorIs(t, err, ErrThreadCursor, name+" (summaries)")
	}
}

func TestEachSourceOfAThreadIsCutAtItsBoundAndAPageAtTheMaxLimit(t *testing.T) {
	s, _, task := threadFixture(t)
	ctx := context.Background()
	for i := 0; i < 505; i++ { // a literal, not the constant: a changed bound is seen
		addReply(t, s, "team-a", "Dev", "r"+strconv.Itoa(i), task.ID)
	}
	q := ThreadQuery{Team: "team-a", TaskID: task.ID, Redact: keepAll, Limit: 10000} // above the maximum
	p, err := s.ThreadEntries(ctx, q)
	require.NoError(t, err)
	assert.Len(t, p.Entries, 200, "a page is cut at the maximum limit, whatever was asked")
	replies, pages := 0, 0
	for {
		pages++
		for _, e := range p.Entries {
			if e.Kind == "reply" {
				replies++
			}
		}
		if !p.More {
			break
		}
		q.After = p.Cursor
		p, err = s.ThreadEntries(ctx, q)
		require.NoError(t, err)
		require.Less(t, pages, 20)
	}
	assert.Equal(t, 500, replies, "of 505 replies a thread reads the newest 500 and no more: the source is bounded")
	assert.True(t, strings.TrimSpace(asJSON(t, p)) != "")
}
