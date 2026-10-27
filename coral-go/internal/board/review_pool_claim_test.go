package board

import (
	"context"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8957 (Goal #80): the pool's rules. A review waits on the board; an agent that only reviews takes the oldest one that matches its areas; the author never does; a reviewer holds one at a time; a
// review-only agent is refused a build task; two reviewers can be asked for; a second round goes back to the same reviewer.

type poolEnv struct {
	t   *testing.T
	s   *Store
	ctx context.Context
}

func newPoolEnv(t *testing.T, reviewers map[string][]string) *poolEnv {
	t.Helper()
	ctx := context.Background()
	s := testStore(t)
	for _, m := range []struct{ name, role string }{{"Lead", "Orchestrator"}, {"Dev", "Developer"}, {"Dev2", "Developer"}} {
		_, err := s.Subscribe(ctx, "team", m.name, m.role, "claude-"+m.name, nil, "all")
		require.NoError(t, err)
	}
	yes := true
	for name, areas := range reviewers {
		_, err := s.Subscribe(ctx, "team", name, "Reviewer", "claude-"+name, nil, "all")
		require.NoError(t, err)
		a := areas
		_, err = s.SetReviewSettings(ctx, "team", name, &yes, &a)
		require.NoError(t, err)
	}
	return &poolEnv{t: t, s: s, ctx: ctx}
}

// submit makes a task, claims it as author, submits it for review and puts it in the pool; it returns the task id and whether it was pooled.
func (e *poolEnv) submit(author, title string, areas []string, wanted int) (int64, bool) {
	e.t.Helper()
	task, err := e.s.CreateTask(e.ctx, "team", title, "", "medium", "Lead", author)
	require.NoError(e.t, err)
	_, err = e.s.ClaimTask(e.ctx, "team", author, task.ID)
	require.NoError(e.t, err)
	_, err = e.s.SubmitCompletionReview(e.ctx, "team", task.ID, author, "candidate", "success", "ready", []TaskArtifact{{Name: "out", Content: "x", Revision: "r1"}})
	require.NoError(e.t, err)
	_, _, err = e.s.HandToOrchestrator(e.ctx, "team", task.ID, author)
	require.NoError(e.t, err)
	pooled, err := e.s.PutReviewInPool(e.ctx, "team", task.ID, areas, wanted)
	require.NoError(e.t, err)
	return task.ID, pooled
}

func (e *poolEnv) workflow(id int64) TaskWorkflow {
	e.t.Helper()
	w, err := loadWorkflow(e.ctx, e.s.db, id)
	require.NoError(e.t, err)
	return w
}

func (e *poolEnv) claim(who string) *Task {
	e.t.Helper()
	rt, err := e.s.ClaimTask(e.ctx, "team", who)
	require.NoError(e.t, err)
	return rt
}

func TestAReviewStaysWithTheOrchestratorWhenNoAgentOnlyReviews(t *testing.T) {
	e := newPoolEnv(t, nil)
	id, pooled := e.submit("Dev", "No pool", []string{"ui"}, 1)
	assert.False(t, pooled, "no review-only agent on the board: the orchestrator holds it as before")
	assert.False(t, e.workflow(id).ReviewInPool)
	assert.Empty(t, e.workflow(id).ReviewAreas, "nothing is recorded")
}

func TestAReviewOnlyAgentTakesTheOldestMatchingPooledReview(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevUI": {"ui"}, "RevGo": {"go", "security"}, "RevAll": {}})
	first, pooled := e.submit("Dev", "First: ui", []string{"ui"}, 1)
	require.True(t, pooled)
	second, _ := e.submit("Dev2", "Second: go", []string{"go"}, 1)
	third, _ := e.submit("Dev", "Third: docs", []string{"docs"}, 1)
	assert.True(t, e.workflow(first).ReviewInPool && e.workflow(second).ReviewInPool && e.workflow(third).ReviewInPool)
	assert.Equal(t, []string{"ui"}, e.workflow(first).ReviewAreas)

	// RevGo covers go and security: the ui review is not for it, the go one (second) is, and it is its oldest match
	rt := e.claim("RevGo")
	require.NotNil(t, rt)
	assert.Equal(t, second, e.workflow(rt.ID).ReviewOf, "the go review")
	assert.Equal(t, "in_progress", rt.Status)
	require.NotNil(t, rt.AssignedTo)
	assert.Equal(t, "RevGo", *rt.AssignedTo)
	assert.False(t, e.workflow(second).ReviewInPool, "one reviewer wanted: the pool closes for it")
	round := e.workflow(second).ReviewRounds[0]
	assert.Equal(t, 1, round.Round)
	assert.Equal(t, "the review pool", round.DelegatedBy)
	require.Len(t, round.Reviewers, 1)
	assert.Equal(t, ReviewerState{Reviewer: "RevGo", ReviewTaskID: rt.ID, State: "pending"}, round.Reviewers[0])

	// RevUI takes the ui one; RevAll (every area) takes the oldest left, the docs one is the only left
	assert.Equal(t, first, e.workflow(e.claim("RevUI").ID).ReviewOf)
	assert.Equal(t, third, e.workflow(e.claim("RevAll").ID).ReviewOf)
}

func TestAReviewerDoesNotGetWhatDoesNotMatchItsAreas(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevGo": {"go"}})
	id, _ := e.submit("Dev", "A ui change", []string{"ui"}, 1)
	assert.Nil(t, e.claim("RevGo"), "nothing for go in the pool")
	assert.True(t, e.workflow(id).ReviewInPool, "the review keeps waiting")
	// give the reviewer the area and it takes it
	areas := []string{"go", "ui"}
	_, err := e.s.SetReviewSettings(e.ctx, "team", "RevGo", nil, &areas)
	require.NoError(t, err)
	rt := e.claim("RevGo")
	require.NotNil(t, rt)
	assert.Equal(t, id, e.workflow(rt.ID).ReviewOf)
}

func TestAnAuthorNeverReviewsTheirOwnTask(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevB": {}})
	// RevA writes a task and submits it while it is an ordinary agent, then is set to review only
	_, err := e.s.Subscribe(e.ctx, "team", "RevA", "Reviewer", "claude-RevA", nil, "all")
	require.NoError(t, err)
	id, pooled := e.submit("RevA", "Written by RevA", nil, 1)
	require.True(t, pooled)
	yes := true
	_, err = e.s.SetReviewSettings(e.ctx, "team", "RevA", &yes, nil)
	require.NoError(t, err)
	assert.Nil(t, e.claim("RevA"), "the author is excluded")
	rt := e.claim("RevB")
	require.NotNil(t, rt)
	assert.Equal(t, id, e.workflow(rt.ID).ReviewOf)
}

func TestAReviewerHoldsOneReviewAtATime(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"Rev": {}})
	a, _ := e.submit("Dev", "One", nil, 1)
	b, _ := e.submit("Dev2", "Two", nil, 1)
	first := e.claim("Rev")
	require.NotNil(t, first)
	assert.Equal(t, a, e.workflow(first.ID).ReviewOf, "the oldest")
	_, err := e.s.ClaimTask(e.ctx, "team", "Rev")
	require.ErrorIs(t, err, errSlotHeld)
	assert.True(t, e.workflow(b).ReviewInPool, "and the second waits")
	// after its verdict the slot is free again
	_, err = e.s.ApproveReview(e.ctx, "team", a, "Rev", "ok", 1)
	require.NoError(t, err)
	next := e.claim("Rev")
	require.NotNil(t, next)
	assert.Equal(t, b, e.workflow(next.ID).ReviewOf)
}

func TestAReviewOnlyAgentIsRefusedABuildTask(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"Rev": {}})
	build, err := e.s.CreateTask(e.ctx, "team", "Build it", "", "high", "Lead", "Rev")
	require.NoError(t, err)
	_, err = e.s.ClaimTask(e.ctx, "team", "Rev", build.ID)
	require.ErrorIs(t, err, ErrReviewsOnly, "named")
	assert.Contains(t, err.Error(), "Reviews only")
	got, err := e.s.ClaimTask(e.ctx, "team", "Rev")
	require.NoError(t, err)
	assert.Nil(t, got, "and with no id it is simply not offered one")
	task, _ := e.s.GetTask(e.ctx, "team", build.ID)
	assert.Equal(t, "pending", task.Status, "the build task is untouched")
	// turned off, it claims like anyone
	no := false
	_, err = e.s.SetReviewSettings(e.ctx, "team", "Rev", &no, nil)
	require.NoError(t, err)
	got, err = e.s.ClaimTask(e.ctx, "team", "Rev", build.ID)
	require.NoError(t, err)
	require.NotNil(t, got)
}

func TestAReviewTaskNamedToAReviewOnlyAgentIsClaimedAsUsual(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"Rev": {}})
	// not pooled: the orchestrator names the reviewer, as before
	task, err := e.s.CreateTask(e.ctx, "team", "Named", "", "medium", "Lead", "Dev")
	require.NoError(t, err)
	_, err = e.s.ClaimTask(e.ctx, "team", "Dev", task.ID)
	require.NoError(t, err)
	_, err = e.s.SubmitCompletionReview(e.ctx, "team", task.ID, "Dev", "c", "success", "r", []TaskArtifact{{Name: "o", Content: "x", Revision: "r1"}})
	require.NoError(t, err)
	_, _, err = e.s.HandToOrchestrator(e.ctx, "team", task.ID, "Dev")
	require.NoError(t, err)
	_, reviews, err := e.s.DelegateReview(e.ctx, "team", task.ID, "Lead", []string{"Rev"})
	require.NoError(t, err)
	require.Len(t, reviews, 1)
	got, err := e.s.ClaimTask(e.ctx, "team", "Rev", reviews[0].ID)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, reviews[0].ID, got.ID, "a review task named to it is claimed")
}

func TestAReviewThatWantsTwoReviewersWaitsForBoth(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevA": {}, "RevB": {}, "RevC": {}})
	id, pooled := e.submit("Dev", "Needs two", []string{"go"}, 2)
	require.True(t, pooled)
	assert.Equal(t, 2, e.workflow(id).ReviewersWanted)
	a := e.claim("RevA")
	require.NotNil(t, a)
	assert.True(t, e.workflow(id).ReviewInPool, "one place is left")
	_, err := e.s.ClaimTask(e.ctx, "team", "RevA")
	require.ErrorIs(t, err, errSlotHeld, "the same reviewer cannot take the second place: it holds a review already")
	b := e.claim("RevB")
	require.NotNil(t, b)
	assert.False(t, e.workflow(id).ReviewInPool, "both places taken")
	assert.Nil(t, e.claim("RevC"), "no third reviewer")

	// the first approval does not finish it, the second does
	v, err := e.s.ApproveReview(e.ctx, "team", id, "RevA", "ok", 1)
	require.NoError(t, err)
	assert.False(t, v.Complete, "RevB has not given a verdict")
	v, err = e.s.ApproveReview(e.ctx, "team", id, "RevB", "ok", 1)
	require.NoError(t, err)
	assert.True(t, v.Complete)
	assert.ElementsMatch(t, []string{"RevA", "RevB"}, v.Approvers)
}

func TestAnApprovalWhileAPlaceIsStillOpenDoesNotFinishAReviewThatWantsTwo(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevA": {}, "RevB": {}})
	id, _ := e.submit("Dev", "Two wanted, one in a hurry", nil, 2)
	require.NotNil(t, e.claim("RevA"))
	v, err := e.s.ApproveReview(e.ctx, "team", id, "RevA", "ok", 1)
	require.NoError(t, err)
	assert.False(t, v.Complete, "the second place is still open in the pool")
	task, _ := e.s.GetTask(e.ctx, "team", id)
	assert.Equal(t, "review_pending", task.Status)
	rb := e.claim("RevB")
	require.NotNil(t, rb)
	v, err = e.s.ApproveReview(e.ctx, "team", id, "RevB", "ok", 1)
	require.NoError(t, err)
	assert.True(t, v.Complete)
}

func TestARejectionClosesThePoolAndRoundTwoGoesBackToTheSameReviewer(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevA": {}, "RevB": {}})
	id, _ := e.submit("Dev", "Rejected once", nil, 1)
	ra := e.claim("RevA")
	require.NotNil(t, ra)
	v, err := e.s.RejectReview(e.ctx, "team", id, "RevA", "fix it", 1)
	require.NoError(t, err)
	assert.True(t, v.Rejected)
	assert.False(t, e.workflow(id).ReviewInPool)

	// the author resubmits: the same reviewer's review task reopens, nothing goes to the pool again
	_, err = e.s.ClaimTask(e.ctx, "team", "Dev", id)
	require.NoError(t, err)
	_, err = e.s.SubmitCompletionReview(e.ctx, "team", id, "Dev", "c2", "success", "again", []TaskArtifact{{Name: "out", Content: "y", Revision: "r2"}})
	require.NoError(t, err)
	_, reopened, err := e.s.HandToOrchestrator(e.ctx, "team", id, "Dev")
	require.NoError(t, err)
	require.NotNil(t, reopened, "round two")
	assert.Equal(t, 2, reopened.Round)
	require.Len(t, reopened.Reviewers, 1)
	assert.Equal(t, "RevA", reopened.Reviewers[0].Reviewer, "the same reviewer")
	pooled, err := e.s.PutReviewInPool(e.ctx, "team", id, nil, 1)
	require.NoError(t, err)
	assert.False(t, pooled, "a reviewed task is not pooled again")
	assert.Nil(t, e.claim("RevB"), "so the other reviewer finds nothing")
}

func TestTheOrchestratorNamingReviewersTakesTheReviewOutOfThePool(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"Rev": {}, "Rev2": {}})
	id, _ := e.submit("Dev", "Named after pooling", nil, 1)
	require.True(t, e.workflow(id).ReviewInPool)
	_, reviews, err := e.s.DelegateReview(e.ctx, "team", id, "Lead", []string{"Rev"})
	require.NoError(t, err)
	require.Len(t, reviews, 1)
	assert.False(t, e.workflow(id).ReviewInPool)
	got := e.claim("Rev")
	require.NotNil(t, got)
	assert.Equal(t, reviews[0].ID, got.ID, "what Rev gets is the review task the orchestrator named it to, not a second one from the pool")
	assert.Len(t, e.workflow(id).ReviewRounds, 1)
	assert.Nil(t, e.claim("Rev2"), "and the pool has nothing left")
}

func TestAPooledReviewCanBeClaimedByItsNumber(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"Rev": {"go"}})
	older, _ := e.submit("Dev", "Older", []string{"go"}, 1)
	newer, _ := e.submit("Dev2", "Newer", []string{"go"}, 1)
	rt, err := e.s.ClaimTask(e.ctx, "team", "Rev", newer)
	require.NoError(t, err)
	require.NotNil(t, rt)
	assert.Equal(t, newer, e.workflow(rt.ID).ReviewOf, "the one asked for, not the oldest")
	assert.True(t, e.workflow(older).ReviewInPool)
	// a pooled review that does not match is not given
	e2 := newPoolEnv(t, map[string][]string{"Rev": {"go"}})
	ui, _ := e2.submit("Dev", "ui", []string{"ui"}, 1)
	_, err = e2.s.ClaimTask(e2.ctx, "team", "Rev", ui)
	require.Error(t, err, "named, not matching and not a review task of its own")
}

func TestTwoReviewersReachingForTheLastPlaceOnlyOneGetsIt(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevA": {}, "RevB": {}, "RevC": {}, "RevD": {}})
	id, _ := e.submit("Dev", "Contested", nil, 1)
	var wg sync.WaitGroup
	got := make(chan *Task, 4)
	for _, who := range []string{"RevA", "RevB", "RevC", "RevD"} {
		wg.Add(1)
		go func(who string) {
			defer wg.Done()
			rt, err := e.s.ClaimTask(e.ctx, "team", who)
			if err == nil && rt != nil {
				got <- rt
			}
		}(who)
	}
	wg.Wait()
	close(got)
	var winners []*Task
	for rt := range got {
		winners = append(winners, rt)
	}
	require.Len(t, winners, 1, "exactly one reviewer takes the review")
	round := e.workflow(id).ReviewRounds[0]
	require.Len(t, round.Reviewers, 1)
	// the losers left no open review task behind
	var open int
	require.NoError(t, e.s.db.GetContext(e.ctx, &open, `SELECT COUNT(*) FROM board_tasks WHERE board_id='team' AND status IN ('pending','in_progress') AND title LIKE 'Review #%'`))
	assert.Equal(t, 1, open)
}

func TestPutReviewInPoolValidates(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"Rev": {}})
	task, err := e.s.CreateTask(e.ctx, "team", "T", "", "medium", "Lead", "Dev")
	require.NoError(t, err)
	_, err = e.s.PutReviewInPool(e.ctx, "team", task.ID, []string{"bad area"}, 1)
	require.ErrorIs(t, err, ErrReviewArea)
	_, err = e.s.PutReviewInPool(e.ctx, "team", task.ID, nil, 3)
	require.Error(t, err)
	pooled, err := e.s.PutReviewInPool(e.ctx, "team", task.ID, nil, 1)
	require.NoError(t, err)
	assert.False(t, pooled, "a task that is not in review is not pooled")
}

func TestWaitingPoolReviewsNameWhatNobodyCoversAndWhoStillIsWanted(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevUI": {"ui"}, "RevGo": {"go"}})
	older, _ := e.submit("Dev", "Needs ui and docs", []string{"ui", "docs"}, 1)
	newer, _ := e.submit("Dev2", "Needs two for go", []string{"go"}, 2)
	open, _ := e.submit("Dev", "Any reviewer", nil, 1)

	waits, err := e.s.WaitingPoolReviews(e.ctx, "team")
	require.NoError(t, err)
	require.Len(t, waits, 3)
	assert.Equal(t, []int64{older, newer, open}, []int64{waits[0].TaskID, waits[1].TaskID, waits[2].TaskID}, "oldest first")
	assert.Equal(t, []string{"docs"}, waits[0].Uncovered, "ui is covered by RevUI, docs by nobody")
	assert.Empty(t, waits[1].Uncovered, "go is covered")
	assert.Equal(t, 2, waits[1].Needs, "two wanted")
	assert.Empty(t, waits[2].Uncovered, "a review with no area has reviewers it could go to")
	assert.False(t, waits[0].PooledAt.IsZero())
	assert.Equal(t, "Needs ui and docs", waits[0].Title)

	// once RevGo has one of the two places the review still needs one
	rt := e.claim("RevGo")
	require.NotNil(t, rt)
	waits, err = e.s.WaitingPoolReviews(e.ctx, "team")
	require.NoError(t, err)
	var got *PoolWait
	for i := range waits {
		if waits[i].TaskID == newer {
			got = &waits[i]
		}
	}
	require.NotNil(t, got, "still waiting: one place of two is taken")
	assert.Equal(t, 1, got.Needs)
}

func TestAReviewWhoseOnlyCoveringReviewerIsItsAuthorIsUncovered(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevB": {"go"}})
	// RevA covers ui, and writes a ui change as an ordinary agent before being set to review only
	_, err := e.s.Subscribe(e.ctx, "team", "RevA", "Reviewer", "claude-RevA", nil, "all")
	require.NoError(t, err)
	id, pooled := e.submit("RevA", "RevA's ui change", []string{"ui"}, 1)
	require.True(t, pooled)
	yes := true
	ui := []string{"ui"}
	_, err = e.s.SetReviewSettings(e.ctx, "team", "RevA", &yes, &ui)
	require.NoError(t, err)
	waits, err := e.s.WaitingPoolReviews(e.ctx, "team")
	require.NoError(t, err)
	require.Len(t, waits, 1)
	assert.Equal(t, id, waits[0].TaskID)
	assert.Equal(t, []string{"ui"}, waits[0].Uncovered, "RevA covers ui but wrote the change, and RevB covers go only")
}

func TestThePoolIsOldestFirstByWhenItWentInNotByNumber(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"Rev": {}})
	first, _ := e.submit("Dev", "Lower number", nil, 1)
	second, _ := e.submit("Dev2", "Higher number", nil, 1)
	// the higher-numbered review went into the pool earlier
	w := e.workflow(second)
	w.ReviewPooledAt = "2000-01-01T00:00:00Z"
	require.NoError(t, saveWorkflow(e.ctx, e.s.db, second, w))
	w = e.workflow(first)
	w.ReviewPooledAt = "2001-01-01T00:00:00Z"
	require.NoError(t, saveWorkflow(e.ctx, e.s.db, first, w))
	rt := e.claim("Rev")
	require.NotNil(t, rt)
	assert.Equal(t, second, e.workflow(rt.ID).ReviewOf, "the one that waited longest")
}

func TestARejectionWhileASecondPlaceIsOpenDoesNotLeaveThePoolOpenForTheNextRound(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevA": {}, "RevB": {}})
	id, _ := e.submit("Dev", "Two wanted, rejected by the first", nil, 2)
	require.NotNil(t, e.claim("RevA"))
	require.True(t, e.workflow(id).ReviewInPool, "a second place is open")
	_, err := e.s.RejectReview(e.ctx, "team", id, "RevA", "no", 1)
	require.NoError(t, err)
	assert.False(t, e.workflow(id).ReviewInPool, "the rejection ended the round and its open place")
	// the author resubmits: round two is RevA's again, and RevB cannot join it from the pool
	_, err = e.s.ClaimTask(e.ctx, "team", "Dev", id)
	require.NoError(t, err)
	_, err = e.s.SubmitCompletionReview(e.ctx, "team", id, "Dev", "c2", "success", "again", []TaskArtifact{{Name: "out", Content: "y", Revision: "r2"}})
	require.NoError(t, err)
	_, reopened, err := e.s.HandToOrchestrator(e.ctx, "team", id, "Dev")
	require.NoError(t, err)
	require.NotNil(t, reopened)
	assert.False(t, e.workflow(id).ReviewInPool)
	assert.Nil(t, e.claim("RevB"), "round two goes back to the same reviewer only")
}

func TestOneReviewerCannotTakeBothPlacesOfAReviewThatWantsTwo(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"RevA": {}, "RevB": {}})
	id, _ := e.submit("Dev", "Two wanted", nil, 2)
	require.NotNil(t, e.claim("RevA"))
	_, err := e.s.ApproveReview(e.ctx, "team", id, "RevA", "ok", 1)
	require.NoError(t, err)
	assert.Nil(t, e.claim("RevA"), "RevA's slot is free again, but it already holds a place in this review: a second reviewer is a different one")
	rb := e.claim("RevB")
	require.NotNil(t, rb)
	assert.Equal(t, id, e.workflow(rb.ID).ReviewOf)
	assert.Len(t, e.workflow(id).ReviewRounds[0].Reviewers, 2)
}

// A reviewer that is busy by the time it takes a place (two claims racing) does not keep the place: the review is back in the pool and the review task made for it is skipped.
func TestAPlaceTakenByABusyReviewerGoesBackToThePool(t *testing.T) {
	e := newPoolEnv(t, map[string][]string{"Rev": {}})
	a, _ := e.submit("Dev", "One", nil, 1)
	b, _ := e.submit("Dev2", "Two", nil, 1)
	require.NotNil(t, e.claim("Rev"), "Rev holds the review of One")
	_ = a
	_, err := e.s.takePoolReview(e.ctx, "team", b, "Rev", nil) // the racing second claim, past ClaimTask's own slot check
	require.ErrorIs(t, err, errSlotHeld)
	w := e.workflow(b)
	assert.True(t, w.ReviewInPool, "the place is back in the pool")
	assert.Empty(t, w.ReviewRounds, "no round and no reviewer recorded for Rev")
	var pending int
	require.NoError(t, e.s.db.GetContext(e.ctx, &pending, "SELECT COUNT(*) FROM board_tasks WHERE board_id='team' AND status='pending' AND title LIKE 'Review #%'"))
	assert.Zero(t, pending, "no review task waits on Rev")
	other := newPoolReviewerFor(t, e, "Rev2")
	got := e.claim(other)
	require.NotNil(t, got)
	assert.Equal(t, b, e.workflow(got.ID).ReviewOf, "another reviewer takes it")
}

func newPoolReviewerFor(t *testing.T, e *poolEnv, name string) string {
	t.Helper()
	_, err := e.s.Subscribe(e.ctx, "team", name, "Reviewer", "claude-"+name, nil, "all")
	require.NoError(t, err)
	yes := true
	none := []string{}
	_, err = e.s.SetReviewSettings(e.ctx, "team", name, &yes, &none)
	require.NoError(t, err)
	return name
}
