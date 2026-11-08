package board

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14421 (Threading S1): an Activity row carries the goal and the task it was about, saved when the row is written and never guessed afterwards, so the record can be grouped. An old row has neither. The
// sources: an ask's key from board_ask_subjects; a file's task (the handler knows it from the upload) and that task's goal; a task action's task and its goal; a goal action's goal. Prompt, wait and
// plain team-message rows have none.

func threadFixture(t *testing.T) (s *Store, goal *Goal, task *Task) {
	t.Helper()
	s = activityStore(t)
	ctx := context.Background()
	var err error
	goal, err = s.CreateGoal(ctx, "team-a", GoalInput{Title: "Ship the importer", CreatedBy: "Lead"})
	require.NoError(t, err)
	task, err = s.CreateTask(ctx, "team-a", "Write the importer", "", "medium", "Lead")
	require.NoError(t, err)
	gid := goal.ID
	require.NoError(t, s.SetTaskGoal(ctx, "team-a", task.ID, &gid))
	return s, goal, task
}

// recordAsk makes the message a question the board knows (RecordAskSubject keeps a subject only for a message recorded as an ask).
func recordAsk(t *testing.T, s *Store, team string, id int64) {
	t.Helper()
	require.NoError(t, s.RecordAsk(context.Background(), team, &Message{ID: id, SubscriberID: "Lead", CreatedAt: time.Now().UTC().Format(time.RFC3339)}, []string{"Operator"}))
}

func lastRow(t *testing.T, s *Store) OperatorAction {
	t.Helper()
	rows, err := s.ListActivity(context.Background(), ActivityFilter{})
	require.NoError(t, err)
	require.NotEmpty(t, rows)
	return rows[0]
}

func idOf(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func TestAnAskRowCarriesTheGoalAndTaskOfTheAsksSubject(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	recordAsk(t, s, "team-a", 77)
	require.NoError(t, s.RecordAskSubject(ctx, "team-a", 77, goal.ID, task.ID))
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActAnswer, "question", "77", "", "team-a"))
	r := lastRow(t, s)
	assert.Equal(t, goal.ID, idOf(r.GoalID), "the ask's goal")
	assert.Equal(t, task.ID, idOf(r.TaskID), "the ask's task")

	// an ask with a task and no goal of its own takes the task's goal; one with a goal only has no task
	recordAsk(t, s, "team-a", 78)
	require.NoError(t, s.RecordAskSubject(ctx, "team-a", 78, 0, task.ID))
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActAnswer, "question", "78", "", "team-a"))
	r = lastRow(t, s)
	assert.Equal(t, goal.ID, idOf(r.GoalID), "the goal of the task the ask is about")
	assert.Equal(t, task.ID, idOf(r.TaskID))
	recordAsk(t, s, "team-a", 79)
	require.NoError(t, s.RecordAskSubject(ctx, "team-a", 79, goal.ID, 0))
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActAnswer, "question", "79", "", "team-a"))
	r = lastRow(t, s)
	assert.Equal(t, goal.ID, idOf(r.GoalID))
	assert.Nil(t, r.TaskID)

	// an ask with no subject, and one in another team, carry neither
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActAnswer, "question", "80", "", "team-a"))
	r = lastRow(t, s)
	assert.Nil(t, r.GoalID)
	assert.Nil(t, r.TaskID)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActAnswer, "question", "77", "", "team-b"))
	r = lastRow(t, s)
	assert.Nil(t, r.GoalID, "the subject of team-a's ask 77 is not team-b's ask 77")
	assert.Nil(t, r.TaskID)
}

func TestATaskAndGoalActionCarryTheirOwnThread(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActTaskComplete, "task", strconv.FormatInt(task.ID, 10), "", "team-a"))
	r := lastRow(t, s)
	assert.Equal(t, task.ID, idOf(r.TaskID), "a task action: the task")
	assert.Equal(t, goal.ID, idOf(r.GoalID), "and its goal")

	require.NoError(t, s.RecordActivity(ctx, opMeta, ActTaskReply, "task", strconv.FormatInt(task.ID, 10), "", "team-a"))
	r = lastRow(t, s)
	assert.Equal(t, task.ID, idOf(r.TaskID), "a reply on a task: the task")
	assert.Equal(t, goal.ID, idOf(r.GoalID))

	require.NoError(t, s.RecordActivity(ctx, opMeta, ActGoalEdit, "goal", strconv.FormatInt(goal.ID, 10), "", "team-a"))
	r = lastRow(t, s)
	assert.Equal(t, goal.ID, idOf(r.GoalID), "a goal action: the goal")
	assert.Nil(t, r.TaskID)

	// a task with no goal carries the task alone
	free, err := s.CreateTask(ctx, "team-a", "No goal", "", "medium", "Lead")
	require.NoError(t, err)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActTaskEdit, "task", strconv.FormatInt(free.ID, 10), "", "team-a"))
	r = lastRow(t, s)
	assert.Equal(t, free.ID, idOf(r.TaskID))
	assert.Nil(t, r.GoalID)
}

// A task or goal that is not this team's, or does not exist, is never recorded: the id is only kept when the team has it.
func TestAnItemThatIsNotThisTeamsCarriesNoThread(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActTaskComplete, "task", strconv.FormatInt(task.ID, 10), "", "team-b"))
	r := lastRow(t, s)
	assert.Nil(t, r.TaskID, "team-b has no such task")
	assert.Nil(t, r.GoalID)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActGoalEdit, "goal", strconv.FormatInt(goal.ID, 10), "", "team-b"))
	assert.Nil(t, lastRow(t, s).GoalID)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActTaskComplete, "task", "99999", "", "team-a"))
	assert.Nil(t, lastRow(t, s).TaskID)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActTaskComplete, "task", "not-a-number", "", "team-a"))
	assert.Nil(t, lastRow(t, s).TaskID)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActTaskComplete, "task", strconv.FormatInt(task.ID, 10), "", ""))
	assert.Nil(t, lastRow(t, s).TaskID, "a row with no team cannot say whose task")
}

// A file's task is what the handler knows from the upload (the board store does not hold it); it is kept only when the team has that task, and its goal comes from the task.
func TestAFileRowCarriesTheTaskTheHandlerNamedAndItsGoal(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	m := opMeta
	m.TaskID = task.ID
	require.NoError(t, s.RecordActivity(ctx, m, ActFileKeep, "file", hexN(3), "", "team-a"))
	r := lastRow(t, s)
	assert.Equal(t, task.ID, idOf(r.TaskID))
	assert.Equal(t, goal.ID, idOf(r.GoalID))

	m.TaskID = 99999 // an upload that names a task this team does not have
	require.NoError(t, s.RecordActivity(ctx, m, ActFileKeep, "file", hexN(3), "", "team-a"))
	assert.Nil(t, lastRow(t, s).TaskID)
	m.TaskID = task.ID
	require.NoError(t, s.RecordActivity(ctx, m, ActFileKeep, "file", hexN(3), "", "team-b"))
	assert.Nil(t, lastRow(t, s).TaskID, "the task is team-a's")

	// the same through a file decision's own transaction: the context carries the handler's task
	hex := hexN(4)
	s.forReview(t, "team-a", hex)
	ctxD := WithActivity(ctx, ActivityMeta{Actor: "local", Source: "local", TaskID: task.ID})
	_, _, err := s.DecideArtifactReview(ctxD, "team-a", hex, ReviewApproved, time.Now())
	require.NoError(t, err)
	r = lastRow(t, s)
	assert.Equal(t, ActApprove, r.Action)
	assert.Equal(t, task.ID, idOf(r.TaskID), "a decision written in its own transaction carries the thread too")
	assert.Equal(t, goal.ID, idOf(r.GoalID))
}

func TestPromptWaitAndPlainMessageRowsHaveNoThread(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	m := opMeta
	m.TaskID = task.ID // a hint on a kind that never uses it
	for _, c := range []struct{ action, kind, item string }{
		{ActPromptAnswer, "agent", "some-agent"},
		{ActWaitDismiss, "agent", "some-agent"},
		{ActMessage, "message", strconv.FormatInt(task.ID, 10)},
		{ActChatSend, "agent", strconv.FormatInt(goal.ID, 10)},
	} {
		require.NoError(t, s.RecordActivity(ctx, m, c.action, c.kind, c.item, "", "team-a"))
		r := lastRow(t, s)
		assert.Nil(t, r.GoalID, c.action)
		assert.Nil(t, r.TaskID, c.action)
	}
}

// The three rows of the spec's done-when: a goal's ask answered, its file approved and its task completed share the goal id, and each has the right task.
func TestAnAnswerAnApprovalAndACompletionOfOneGoalShareItsId(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	recordAsk(t, s, "team-a", 5)
	require.NoError(t, s.RecordAskSubject(ctx, "team-a", 5, goal.ID, task.ID))
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActAnswer, "question", "5", "", "team-a"))
	hex := hexN(6)
	s.forReview(t, "team-a", hex)
	_, _, err := s.DecideArtifactReview(WithActivity(ctx, ActivityMeta{Actor: "local", Source: "local", TaskID: task.ID}), "team-a", hex, ReviewApproved, time.Now())
	require.NoError(t, err)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActTaskComplete, "task", strconv.FormatInt(task.ID, 10), "", "team-a"))
	rows, err := s.ListActivity(ctx, ActivityFilter{GoalID: goal.ID})
	require.NoError(t, err)
	require.Len(t, rows, 3, "the filter by goal finds all three")
	for _, r := range rows {
		assert.Equal(t, goal.ID, idOf(r.GoalID))
		assert.Equal(t, task.ID, idOf(r.TaskID))
	}
	byTask, err := s.ListActivity(ctx, ActivityFilter{TaskID: task.ID})
	require.NoError(t, err)
	assert.Len(t, byTask, 3)
	none, err := s.ListActivity(ctx, ActivityFilter{GoalID: goal.ID + 1000})
	require.NoError(t, err)
	assert.Empty(t, none)
}

// The chain: an old row (written before the columns) keeps its hash, a new row's goal and task are inside its hash, and the check finds a goal or task edited outside Coral.
func TestTheChainStaysWholeForOldRowsAndCatchesAnEditedThread(t *testing.T) {
	s, goal, task := threadFixture(t)
	ctx := context.Background()
	// a row written before this change: no goal, no task, hash as the old code made it
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActMessage, "message", "1", "", "team-a"))
	old := lastRow(t, s)
	assert.Nil(t, old.GoalID)
	assert.Nil(t, old.TaskID)
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActTaskComplete, "task", strconv.FormatInt(task.ID, 10), "", "team-a"))
	chk, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact, "%+v", chk)

	// the hash of a row with no thread is what it was before the columns (a fixed value pins it)
	a := OperatorAction{At: "2026-11-07T12:00:00.000000000Z", Actor: "local", Action: ActMessage, ItemKind: "message", ItemID: "1", Team: "team-a", Source: "local"}
	// ... as the code made it before the columns existed, written out here field by field: a row with no thread must hash to exactly this, or every row already in a record would stop matching its hash
	oldHash := func(prev string, r OperatorAction) string {
		h := sha256.New()
		for _, f := range []string{prev, r.At, r.Actor, r.Action, r.ItemKind, r.ItemID, r.Version, r.Team, r.Source, r.Hint, r.Surface, r.Title, r.Note} {
			fmt.Fprintf(h, "%d:%s|", len(f), f)
		}
		return hex.EncodeToString(h.Sum(nil))
	}
	assert.Equal(t, oldHash("prev", a), activityHash("prev", a), "a row with no thread hashes as it always did")
	withGoal := a
	g := goal.ID
	withGoal.GoalID = &g
	assert.NotEqual(t, activityHash("prev", a), activityHash("prev", withGoal), "a goal is inside the hash")
	withTask := a
	tk := task.ID
	withTask.TaskID = &tk
	assert.NotEqual(t, activityHash("prev", a), activityHash("prev", withTask), "a task is inside the hash")
	assert.NotEqual(t, activityHash("prev", withGoal), activityHash("prev", withTask), "and a goal alone is not a task alone")

	// an edit outside Coral to a row's goal shows
	_, err = s.db.ExecContext(ctx, `UPDATE operator_actions SET goal_id = ? WHERE id = ?`, goal.ID+1, old.ID)
	require.NoError(t, err)
	chk, err = s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.False(t, chk.Intact, "a thread given to an old row outside Coral is an edit")
	assert.Equal(t, old.ID, chk.FirstBad)
}

// A database made before the columns gets them, and its rows read with no thread.
func TestADatabaseFromBeforeTheColumnsGetsThemAndItsRowsHaveNoThread(t *testing.T) {
	s := activityStore(t)
	ctx := context.Background()
	require.NoError(t, s.RecordActivity(ctx, opMeta, ActMessage, "message", "1", "", "team-a"))
	_, err := s.db.ExecContext(ctx, `ALTER TABLE operator_actions DROP COLUMN goal_id`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `ALTER TABLE operator_actions DROP COLUMN task_id`)
	require.NoError(t, err)
	require.NoError(t, s.ensureOperatorActionsSchema(ctx), "the migration adds the columns again")
	require.NoError(t, s.ensureOperatorActionsSchema(ctx), "and is safe to run twice")
	r := lastRow(t, s)
	assert.Nil(t, r.GoalID)
	assert.Nil(t, r.TaskID)
	var n sql.NullInt64
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT goal_id FROM operator_actions WHERE id = ?`, r.ID))
	assert.False(t, n.Valid, "stored as NULL, not 0: never guessed")
	chk, err := s.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, chk.Intact, "%+v", chk)
}
