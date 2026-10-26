package board

import (
	"context"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Pins of what CreateTaskWithOpts and ClaimTask do today, written before either is split into named steps (#8444): every refusal, every state change, and the claim race.

func pinCount(t *testing.T, s *Store, query string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, s.db.Get(&n, query, args...))
	return n
}

func TestPinCreateTaskDefaultsAndStoredFields(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	plain, err := s.CreateTaskWithOpts(ctx, "team", "plain", "", "", "Lead", nil)
	require.NoError(t, err)
	assert.Equal(t, "medium", plain.Priority, "an empty priority is medium")
	assert.Equal(t, "pending", plain.Status, "a task is published when it is not a draft")
	assert.Nil(t, plain.Body, "an empty body is stored as no body")
	assert.Nil(t, plain.AssignedTo, "no assignee given")
	assert.Equal(t, "Lead", plain.CreatedBy)
	assert.Equal(t, "team", plain.BoardID)
	assert.Nil(t, plain.GoalID)

	blankAssignee, err := s.CreateTaskWithOpts(ctx, "team", "blank", "text", "high", "Lead", nil, "")
	require.NoError(t, err)
	assert.Nil(t, blankAssignee.AssignedTo, "an empty assignee is no assignee")
	require.NotNil(t, blankAssignee.Body)
	assert.Equal(t, "text", *blankAssignee.Body)
	assert.Equal(t, "high", blankAssignee.Priority)

	assigned, err := s.CreateTaskWithOpts(ctx, "team", "assigned", "", "low", "Lead", nil, "Dev", "ignored")
	require.NoError(t, err)
	require.NotNil(t, assigned.AssignedTo)
	assert.Equal(t, "Dev", *assigned.AssignedTo, "the first assignee is the one kept")
	assert.Equal(t, 1, pinCount(t, s, `SELECT COUNT(*) FROM boards WHERE id = ?`, "team"), "the board row is made")
}

func TestPinCreateTaskRefusesABadPriorityAndStoresNothing(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, p := range []string{"urgent", "HIGH", " medium", "0"} {
		_, err := s.CreateTaskWithOpts(ctx, "team", "bad", "", p, "Lead", nil)
		require.Error(t, err, p)
		assert.Contains(t, err.Error(), "invalid priority", p)
	}
	assert.Zero(t, taskCount(t, s))
	for _, p := range []string{"critical", "high", "medium", "low"} {
		_, err := s.CreateTaskWithOpts(ctx, "team", "ok "+p, "", p, "Lead", nil)
		require.NoError(t, err, p)
	}
}

func TestPinCreateTaskDraftIsStoredUnpublishedAndUnclaimable(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	d, err := s.CreateTaskWithOpts(ctx, "team", "draft", "", "critical", "Lead", &CreateTaskOpts{Draft: true})
	require.NoError(t, err)
	assert.Equal(t, "draft", d.Status)
	got, err := s.ClaimTask(ctx, "team", "Dev")
	require.NoError(t, err)
	assert.Nil(t, got, "a draft is not offered")
	_, err = s.ClaimTask(ctx, "team", "Dev", d.ID)
	assert.ErrorContains(t, err, "requested task is not available to this subscriber")
	pub, err := s.PublishTask(ctx, "team", d.ID)
	require.NoError(t, err)
	assert.Equal(t, "pending", pub.Status)
	got, err = s.ClaimTask(ctx, "team", "Dev")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, d.ID, got.ID)
}

func TestPinCreateTaskDependenciesBlockUntilTheirBlockerIsDone(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	first, err := s.CreateTask(ctx, "team", "first", "", "low", "Lead")
	require.NoError(t, err)
	second, err := s.CreateTaskWithOpts(ctx, "team", "second", "", "critical", "Lead", &CreateTaskOpts{BlockedBy: []TaskDep{{TaskID: first.ID}}})
	require.NoError(t, err)
	assert.Equal(t, "blocked", second.Status)
	require.Len(t, second.BlockedBy, 1)
	assert.Equal(t, first.ID, second.BlockedBy[0].TaskID)
	assert.Equal(t, "success", second.BlockedBy[0].Condition, "the default condition is success")
	assert.Equal(t, "team", second.BlockedBy[0].BoardID, "the default board is the task's own")

	got, err := s.ClaimTask(ctx, "team", "Dev")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, first.ID, got.ID, "the critical blocked task is passed over")
	_, err = s.CompleteTask(ctx, "team", first.ID, "Dev", nil)
	require.NoError(t, err)
	got, err = s.ClaimTask(ctx, "team", "Dev")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, second.ID, got.ID)

	// a draft with a blocker stays a draft
	d, err := s.CreateTaskWithOpts(ctx, "team", "draft", "", "low", "Lead", &CreateTaskOpts{Draft: true, BlockedBy: []TaskDep{{TaskID: first.ID}}})
	require.NoError(t, err)
	assert.Equal(t, "draft", d.Status)
	assert.Len(t, d.BlockedBy, 1)
}

func TestPinCreateTaskRefusedDependencyLeavesNoTaskBehind(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	first, err := s.CreateTask(ctx, "team", "first", "", "low", "Lead")
	require.NoError(t, err)
	tasks, workflows := taskCount(t, s), pinCount(t, s, `SELECT COUNT(*) FROM task_workflows`)

	for name, deps := range map[string][]TaskDep{
		"unknown blocker":  {{TaskID: 99999}},
		"duplicate":        {{TaskID: first.ID}, {TaskID: first.ID}},
		"unknown condtion": {{TaskID: first.ID, Condition: "never"}},
	} {
		_, err := s.CreateTaskWithOpts(ctx, "team", "refused", "", "medium", "Lead", &CreateTaskOpts{BlockedBy: deps})
		require.Error(t, err, name)
		assert.Equal(t, tasks, taskCount(t, s), name+": no task row")
		assert.Equal(t, workflows, pinCount(t, s, `SELECT COUNT(*) FROM task_workflows`), name+": no workflow row")
	}
}

func TestPinCreateTaskDependencyDepthDefaultsToThree(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	prev, err := s.CreateTask(ctx, "team", "t0", "", "medium", "Lead")
	require.NoError(t, err)
	depth := 0
	for ; depth < 8; depth++ {
		next, err := s.CreateTaskWithOpts(ctx, "team", "link", "", "medium", "Lead", &CreateTaskOpts{BlockedBy: []TaskDep{{TaskID: prev.ID}}})
		if err != nil {
			break
		}
		prev = next
	}
	assert.Equal(t, 3, depth, "a chain of three blocked links is the default limit")

	long, err := s.CreateTask(ctx, "team", "own0", "", "medium", "Lead")
	require.NoError(t, err)
	for i := 0; i < 5; i++ {
		long, err = s.CreateTaskWithOpts(ctx, "team", "own", "", "medium", "Lead", &CreateTaskOpts{MaxDepth: 10, BlockedBy: []TaskDep{{TaskID: long.ID}}})
		require.NoError(t, err, "an explicit MaxDepth raises the limit")
	}
}

func TestPinCreateTaskGoalRules(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	open := newGoal(t, s, "team", "Ship")
	otherBoard := newGoal(t, s, "other", "Elsewhere")
	closed := newGoal(t, s, "team", "Done")
	_, _, err := s.CloseGoal(ctx, "team", closed.ID, "finished", GoalDone)
	require.NoError(t, err)

	before := taskCount(t, s)
	_, err = s.CreateTaskWithOpts(ctx, "team", "x", "", "medium", "Lead", &CreateTaskOpts{GoalID: &otherBoard.ID})
	require.ErrorIs(t, err, ErrGoalNotFound, "a goal of another board")
	_, err = s.CreateTaskWithOpts(ctx, "team", "x", "", "medium", "Lead", &CreateTaskOpts{GoalID: &closed.ID})
	require.ErrorIs(t, err, ErrGoalClosed)
	assert.Equal(t, before, taskCount(t, s), "a refused goal stores nothing")

	linked, err := s.CreateTaskWithOpts(ctx, "team", "linked", "", "medium", "Lead", &CreateTaskOpts{GoalID: &open.ID})
	require.NoError(t, err)
	require.NotNil(t, linked.GoalID)
	assert.Equal(t, open.ID, *linked.GoalID)

}

func TestPinCreateTaskRequireGoalExemptions(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "team", "Ship")
	setRequireGoal(t, s, "team", true)

	_, err := s.CreateTaskWithOpts(ctx, "team", "none", "", "medium", "Lead", nil)
	require.ErrorIs(t, err, ErrGoalRequired)
	rev, err := s.CreateTaskWithOpts(ctx, "team", "review", "", "medium", "Coral", &CreateTaskOpts{reviewTask: true})
	require.NoError(t, err, "a review task Coral makes needs no goal")
	assert.Nil(t, rev.GoalID)

	link := &remoteGoalLink{BoardUID: "b-uid", GoalUID: "g-uid", RequestID: "req-1", Server: "srv", Board: "peer"}
	remote, err := s.CreateTaskWithOpts(ctx, "team", "for a request", "", "medium", "Coral", &CreateTaskOpts{remote: link})
	require.NoError(t, err, "a task made for another team's request needs no local goal")
	assert.Nil(t, remote.GoalID)
	var row struct {
		B, G, R, S, P *string
	}
	require.NoError(t, s.db.QueryRowx(`SELECT remote_board_uid, remote_goal_uid, request_id, request_server, request_board FROM board_tasks WHERE id = ?`, remote.ID).Scan(&row.B, &row.G, &row.R, &row.S, &row.P))
	require.NotNil(t, row.B)
	assert.Equal(t, []string{"b-uid", "g-uid", "req-1", "srv", "peer"}, []string{*row.B, *row.G, *row.R, *row.S, *row.P})

	// a remote link with no board uid stores no board uid; a local goal with a remote link is refused
	noUID := *link
	noUID.BoardUID, noUID.RequestID = "", "req-2"
	r2, err := s.CreateTaskWithOpts(ctx, "team", "no uid", "", "medium", "Coral", &CreateTaskOpts{remote: &noUID})
	require.NoError(t, err)
	require.NoError(t, s.db.QueryRowx(`SELECT remote_board_uid, remote_goal_uid, request_id, request_server, request_board FROM board_tasks WHERE id = ?`, r2.ID).Scan(&row.B, &row.G, &row.R, &row.S, &row.P))
	assert.Nil(t, row.B)
	before := taskCount(t, s)
	_, err = s.CreateTaskWithOpts(ctx, "team", "both", "", "medium", "Coral", &CreateTaskOpts{remote: link, GoalID: &g.ID})
	require.ErrorIs(t, err, ErrGoalRequestAnswered)
	assert.Equal(t, before, taskCount(t, s))
}

func TestPinClaimTaskStateChangeAndRefusals(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	mine, err := s.CreateTask(ctx, "team", "mine", "", "medium", "Lead")
	require.NoError(t, err)
	second, err := s.CreateTask(ctx, "team", "second", "", "high", "Lead")
	require.NoError(t, err)
	theirs, err := s.CreateTask(ctx, "team", "theirs", "", "critical", "Lead", "Other")
	require.NoError(t, err)
	_, err = s.CreateTask(ctx, "elsewhere", "other board", "", "critical", "Lead")
	require.NoError(t, err)

	none, err := s.ClaimTask(ctx, "empty", "Dev")
	require.NoError(t, err)
	assert.Nil(t, none, "an empty board has nothing")

	_, err = s.ClaimTask(ctx, "team", "Dev", theirs.ID)
	assert.ErrorContains(t, err, "requested task is not available to this subscriber", "another agent's assigned task")
	_, err = s.ClaimTask(ctx, "team", "Dev", 99999)
	assert.ErrorContains(t, err, "requested task is not available to this subscriber")
	got, err := s.ClaimTask(ctx, "team", "Dev", 0)
	require.NoError(t, err)
	require.NotNil(t, got, "an id of 0 is no id: the best task is taken")
	assert.Equal(t, second.ID, got.ID, "high before medium; the critical one is assigned to another and the other board is not this one")
	assert.Equal(t, "in_progress", got.Status)
	require.NotNil(t, got.AssignedTo)
	assert.Equal(t, "Dev", *got.AssignedTo, "an unassigned task is assigned to its claimer")
	assert.NotNil(t, got.ClaimedAt)
	assert.Equal(t, 1, pinCount(t, s, `SELECT COUNT(*) FROM board_tasks WHERE id = ? AND last_activity_at IS NOT NULL`, got.ID), "the claim is activity")

	_, err = s.ClaimTask(ctx, "team", "Dev")
	assert.ErrorContains(t, err, "complete your current task before claiming a new one")
	_, err = s.ClaimTask(ctx, "team", "Dev", mine.ID)
	assert.ErrorContains(t, err, "complete your current task before claiming a new one", "also when a task is named")

	other, err := s.ClaimTask(ctx, "team", "Dev2", mine.ID)
	require.NoError(t, err)
	require.NotNil(t, other)
	assert.Equal(t, mine.ID, other.ID, "another agent has its own slot")
	_, err = s.ClaimTask(ctx, "team", "Dev3", mine.ID)
	assert.ErrorContains(t, err, "requested task is not available to this subscriber", "a task in progress is not available")

	// a task assigned by an empty string is unassigned
	blank, err := s.CreateTask(ctx, "team", "blank", "", "low", "Lead")
	require.NoError(t, err)
	_, err = s.db.Exec(`UPDATE board_tasks SET assigned_to = '' WHERE id = ?`, blank.ID)
	require.NoError(t, err)
	_, err = s.CompleteTask(ctx, "team", second.ID, "Dev", nil)
	require.NoError(t, err)
	got, err = s.ClaimTask(ctx, "team", "Dev", blank.ID)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, blank.ID, got.ID)
	require.NotNil(t, got.AssignedTo)
	assert.Equal(t, "Dev", *got.AssignedTo)
}

func TestPinClaimTaskTakesAssignedWorkBeforeBetterUnassignedWork(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.CreateTask(ctx, "team", "unassigned critical", "", "critical", "Lead")
	require.NoError(t, err)
	mineLow, err := s.CreateTask(ctx, "team", "assigned low", "", "low", "Lead", "Dev")
	require.NoError(t, err)
	mineHigh, err := s.CreateTask(ctx, "team", "assigned high", "", "high", "Lead", "Dev")
	require.NoError(t, err)
	got, err := s.ClaimTask(ctx, "team", "Dev")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, mineHigh.ID, got.ID, "assigned work first, by priority")
	_, err = s.CompleteTask(ctx, "team", mineHigh.ID, "Dev", nil)
	require.NoError(t, err)
	got, err = s.ClaimTask(ctx, "team", "Dev")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, mineLow.ID, got.ID)
}

func TestPinClaimTaskBlockedCandidateIsReconciledAndSkipped(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	blocker, err := s.CreateTask(ctx, "team", "blocker", "", "low", "Lead", "Other")
	require.NoError(t, err)
	waiting, err := s.CreateTaskWithOpts(ctx, "team", "waiting", "", "critical", "Lead", &CreateTaskOpts{BlockedBy: []TaskDep{{TaskID: blocker.ID}}})
	require.NoError(t, err)
	ready, err := s.CreateTask(ctx, "team", "ready", "", "low", "Lead")
	require.NoError(t, err)
	// the queue metadata went stale: the waiting task reads as pending
	_, err = s.db.Exec(`UPDATE board_tasks SET status = 'pending' WHERE id = ?`, waiting.ID)
	require.NoError(t, err)

	got, err := s.ClaimTask(ctx, "team", "Dev")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, ready.ID, got.ID, "the stale row does not hide the ready one")
	var status string
	require.NoError(t, s.db.Get(&status, `SELECT status FROM board_tasks WHERE id = ?`, waiting.ID))
	assert.Equal(t, "blocked", status, "and it is put back to blocked")
}

func TestPinClaimTaskTwoClaimersOneTask(t *testing.T) {
	for round := 0; round < 20; round++ {
		s := testStore(t)
		ctx := context.Background()
		only, err := s.CreateTask(ctx, "team", "only", "", "medium", "Lead")
		require.NoError(t, err)
		names := []string{"A", "B", "C", "D"}
		results := make([]*Task, len(names))
		errs := make([]error, len(names))
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i, n := range names {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				results[i], errs[i] = s.ClaimTask(ctx, "team", n)
			}()
		}
		close(start)
		wg.Wait()
		won := 0
		for i := range names {
			require.NoError(t, errs[i])
			if results[i] != nil {
				won++
				assert.Equal(t, only.ID, results[i].ID)
				require.NotNil(t, results[i].AssignedTo)
				assert.Equal(t, names[i], *results[i].AssignedTo)
			}
		}
		require.Equal(t, 1, won, "exactly one claimer gets the one task")
	}
}

func TestPinClaimTaskManyClaimersTakeDistinctTasksOneEach(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const tasks = 6
	for i := 0; i < tasks; i++ {
		_, err := s.CreateTask(ctx, "team", "t", "", "medium", "Lead")
		require.NoError(t, err)
	}
	names := []string{"A", "B", "C", "D", "E", "F", "G", "H"}
	got := make([]*Task, len(names))
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i, n := range names {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			got[i], _ = s.ClaimTask(ctx, "team", n)
		}()
	}
	close(start)
	wg.Wait()
	seen := map[int64]bool{}
	claimed := 0
	for _, task := range got {
		if task == nil {
			continue
		}
		claimed++
		assert.False(t, seen[task.ID], "task %d claimed twice", task.ID)
		seen[task.ID] = true
	}
	assert.Equal(t, tasks, claimed, "every task went to someone")
}

func TestPinClaimTaskSameClaimerRacingItselfHoldsOneSlot(t *testing.T) {
	for round := 0; round < 20; round++ {
		s := testStore(t)
		ctx := context.Background()
		a, err := s.CreateTask(ctx, "team", "a", "", "medium", "Lead")
		require.NoError(t, err)
		b, err := s.CreateTask(ctx, "team", "b", "", "medium", "Lead")
		require.NoError(t, err)
		ids := []int64{a.ID, b.ID}
		errs := make([]error, 2)
		res := make([]*Task, 2)
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := range ids {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				res[i], errs[i] = s.ClaimTask(ctx, "team", "Dev", ids[i])
			}()
		}
		close(start)
		wg.Wait()
		won := 0
		for i := range ids {
			if errs[i] == nil && res[i] != nil {
				won++
			} else {
				require.Error(t, errs[i])
			}
		}
		require.Equal(t, 1, won, "one agent holds one task: the second claim is refused")
		assert.Equal(t, 1, pinCount(t, s, `SELECT COUNT(*) FROM board_tasks WHERE assigned_to = 'Dev' AND status = 'in_progress'`))
	}
}
