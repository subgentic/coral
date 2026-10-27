package board

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"
)

// The review pool's rules (#8957, Goal #80). submit-review puts a review in the pool when the board has an agent that only reviews; such an agent claims the oldest pooled review that matches the areas it
// covers. The author never reviews their own task, a reviewer holds one review at a time (the one-active-task rule, which a review task takes a slot of like any task), and a second round goes back to
// the same reviewer (reopenReviews: a pooled review is only ever the first round). The orchestrator still holds the task and can name reviewers with task review.

// ErrReviewsOnly is the refusal of a build task for an agent set to take reviews only.
var ErrReviewsOnly = errors.New("this agent only takes reviews (its Reviews only setting is on): claim a review, or ask the Operator to turn the setting off")

// poolTeam reports whether the board has an active agent that only reviews.
func (s *Store) poolTeam(ctx context.Context, project string) (bool, error) {
	subs, err := s.ListSubscribers(ctx, project)
	if err != nil {
		return false, err
	}
	for _, sub := range subs {
		if sub.IsActive != 0 && sub.ReviewsOnly {
			return true, nil
		}
	}
	return false, nil
}

// PutReviewInPool puts the review of a task that was just submitted (HandToOrchestrator has made it review_pending) in the board's pool, with the areas that decide who may take it and the number of
// reviewers it wants (1 or 2). It says false, and changes nothing, when the review stays with the orchestrator: the board has no agent that only reviews, or the task has been reviewed already
// (a second round goes back to the same reviewers).
func (s *Store) PutReviewInPool(ctx context.Context, project string, id int64, areas []string, wanted int) (bool, error) {
	if wanted == 0 {
		wanted = 1
	}
	if wanted < 1 || wanted > MaxReviewersWanted {
		return false, fmt.Errorf("a review asks for 1 or %d reviewers", MaxReviewersWanted)
	}
	areas, err := NormalizeReviewAreas(areas)
	if err != nil {
		return false, err
	}
	pool, err := s.poolTeam(ctx, project)
	if err != nil || !pool {
		return false, err
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var status string
	if err := tx.GetContext(ctx, &status, "SELECT status FROM board_tasks WHERE id=? AND board_id=?", id, project); err != nil {
		return false, err
	}
	w, err := loadWorkflow(ctx, tx, id)
	if err != nil {
		return false, err
	}
	if status != "review_pending" || len(w.ReviewRounds) > 0 {
		return false, nil
	}
	w.ReviewAreas, w.ReviewersWanted, w.ReviewInPool, w.ReviewPooledAt = areas, wanted, true, nowUTC()
	if wanted == 1 {
		w.ReviewersWanted = 0 // the default is not written
	}
	if err := saveWorkflow(ctx, tx, id, w); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// poolCandidate is one pooled review a reviewer may be offered.
type poolCandidate struct {
	id       int64
	pooledAt string
}

// excludedFromReview lists who made the work and so never reviews it: the author the review took it from, who submitted it, who created it.
func (s *Store) excludedFromReview(ctx context.Context, project string, id int64, w TaskWorkflow) []string {
	out := []string{w.OriginalAuthor}
	if w.CompletionReview != nil {
		out = append(out, w.CompletionReview.SubmittedBy)
	}
	if t, err := s.GetTask(ctx, project, id); err == nil && t != nil {
		out = append(out, t.CreatedBy)
	}
	return out
}

// poolReviews are the board's pooled reviews, oldest first, each with room for another reviewer. A review is old by when it entered the pool.
func (s *Store) poolReviews(ctx context.Context, project string) ([]poolCandidate, error) {
	var rows []struct {
		ID       int64  `db:"id"`
		PooledAt string `db:"pooled_at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT t.id AS id, COALESCE(json_extract(w.data, '$.review_pooled_at'), '') AS pooled_at
		FROM board_tasks t JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.status = 'review_pending' AND json_extract(w.data, '$.review_in_pool') = 1`, project); err != nil {
		return nil, err
	}
	out := make([]poolCandidate, 0, len(rows))
	for _, r := range rows {
		out = append(out, poolCandidate{id: r.ID, pooledAt: r.PooledAt})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].pooledAt != out[j].pooledAt {
			return out[i].pooledAt < out[j].pooledAt
		}
		return out[i].id < out[j].id
	})
	return out, nil
}

// mayTakePoolReview is whether reviewer may take the pooled review id with workflow w: not its author, the areas match, and it has room (the round it is in has fewer reviewers than wanted).
func (s *Store) mayTakePoolReview(ctx context.Context, project string, id int64, w TaskWorkflow, reviewer string, reviewerAreas []string) bool {
	if !w.ReviewInPool || w.ReviewersWanted < 0 {
		return false
	}
	for _, e := range s.excludedFromReview(ctx, project, id, w) {
		if e != "" && SameIdentity(e, reviewer) {
			return false
		}
	}
	if !AreasMatch(reviewerAreas, w.ReviewAreas) {
		return false
	}
	have := 0
	if n := len(w.ReviewRounds); n > 0 && w.ReviewRounds[n-1].Result == "" {
		for _, r := range w.ReviewRounds[n-1].Reviewers {
			if SameIdentity(r.Reviewer, reviewer) {
				return false
			}
			have++
		}
	}
	return have < max(1, w.ReviewersWanted)
}

// ClaimPoolReview gives a reviewer that only reviews the oldest pooled review it may take (or, with only > 0, that one): it makes the reviewer's review task for it, in progress and claimed, adds the reviewer
// to the round, and closes the pool for the review when the wanted number of reviewers have it. It returns the review task, or nil when nothing matches. The reviewer must hold no other task.
func (s *Store) ClaimPoolReview(ctx context.Context, project, reviewer string, only int64) (*Task, error) {
	if err := s.refuseWhileSlotHeld(ctx, project, reviewer); err != nil {
		return nil, err
	}
	sub, err := s.GetProjectSubscription(ctx, project, reviewer)
	if err != nil || sub == nil || !sub.ReviewsOnly {
		return nil, err
	}
	areas := sub.ReviewAreas.Slice()
	cands, err := s.poolReviews(ctx, project)
	if err != nil {
		return nil, err
	}
	for _, c := range cands {
		if only > 0 && c.id != only {
			continue
		}
		w, err := loadWorkflow(ctx, s.db, c.id)
		if err != nil || !s.mayTakePoolReview(ctx, project, c.id, w, sub.SubscriberID, areas) {
			continue
		}
		rt, err := s.takePoolReview(ctx, project, c.id, sub.SubscriberID, areas)
		if err != nil {
			return nil, err
		}
		if rt != nil {
			return rt, nil
		}
	}
	return nil, nil
}

// takePoolReview makes the reviewer's review task for the pooled review id, then adds the reviewer to the round in one transaction that checks again that the review still has room, so two reviewers
// that reach for the last place do not both get it: the one that loses has its review task skipped and goes on to the next review. It says nil when the place was gone.
func (s *Store) takePoolReview(ctx context.Context, project string, id int64, reviewer string, reviewerAreas []string) (*Task, error) {
	task, err := s.GetTask(ctx, project, id)
	if err != nil || task == nil {
		return nil, err
	}
	w, err := loadWorkflow(ctx, s.db, id)
	if err != nil {
		return nil, err
	}
	round := 1
	if n := len(w.ReviewRounds); n > 0 && w.ReviewRounds[n-1].Result == "" {
		round = w.ReviewRounds[n-1].Round
	} else {
		round = len(w.ReviewRounds) + 1
	}
	rt, err := s.CreateTaskWithOpts(ctx, project, fmt.Sprintf("Review #%d: %s", id, task.Title), reviewTaskBody(id, task.Title, w.OriginalAuthor, round), task.Priority, "Coral Task Queue",
		&CreateTaskOpts{Workflow: TaskWorkflow{ReviewOf: id, ReviewRound: round}, reviewTask: true}, reviewer)
	if err != nil {
		return nil, err
	}
	skip := func(why string) {
		s.db.ExecContext(ctx, "UPDATE board_tasks SET status='skipped', completed_by=?, completion_message=?, completed_at=? WHERE id=? AND board_id=? AND status='pending'",
			"Coral Task Queue", why, nowUTC(), rt.ID, project)
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		skip("the pool review could not be taken")
		return nil, err
	}
	// The skip is a write of its own, and this transaction holds the write lock: every way out of it rolls back first.
	fail := func(why string) { tx.Rollback(); skip(why) }
	var status string
	if err := tx.GetContext(ctx, &status, "SELECT status FROM board_tasks WHERE id=? AND board_id=?", id, project); err != nil || status != "review_pending" {
		fail("the review was no longer waiting in the pool")
		return nil, nil
	}
	w, err = loadWorkflow(ctx, tx, id)
	if err != nil {
		fail("the pool review could not be taken")
		return nil, err
	}
	if !s.mayTakePoolReview(ctx, project, id, w, reviewer, reviewerAreas) {
		fail("the review was taken by another reviewer first")
		return nil, nil
	}
	var cur *ReviewRound
	if n := len(w.ReviewRounds); n > 0 && w.ReviewRounds[n-1].Result == "" {
		cur = &w.ReviewRounds[n-1]
	} else {
		w.ReviewRounds = append(w.ReviewRounds, ReviewRound{Round: round, DelegatedBy: "the review pool", DelegatedAt: nowUTC()})
		cur = &w.ReviewRounds[len(w.ReviewRounds)-1]
	}
	cur.Reviewers = append(cur.Reviewers, ReviewerState{Reviewer: reviewer, ReviewTaskID: rt.ID, State: "pending"})
	if len(cur.Reviewers) >= max(1, w.ReviewersWanted) {
		w.ReviewInPool = false
	}
	if err := saveWorkflow(ctx, tx, id, w); err != nil {
		fail("the pool review could not be taken")
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		skip("the pool review could not be taken")
		return nil, err
	}
	claimed, err := s.claimOne(ctx, project, reviewer, rt.ID, nowUTC())
	if err != nil {
		return nil, err
	}
	if !claimed {
		return s.getTaskByID(ctx, project, rt.ID) // left pending in the reviewer's own queue: it claims it next
	}
	s.recordClaimSession(ctx, project, reviewer, rt.ID)
	return s.getTaskByID(ctx, project, rt.ID)
}

// isReviewTaskID reports whether the task is a review task Coral made (a review of another task).
func (s *Store) isReviewTaskID(ctx context.Context, id int64) bool {
	w, err := loadWorkflow(ctx, s.db, id)
	return err == nil && w.ReviewOf > 0
}

// reviewsOnlyCandidates keeps, of the ids a claim would try, the review tasks: a reviewer that only reviews is never offered a build task. An id asked for by name that is not a review is the refusal.
func (s *Store) reviewsOnlyCandidates(ctx context.Context, ids []int64, named bool) ([]int64, error) {
	var keep []int64
	for _, id := range ids {
		if s.isReviewTaskID(ctx, id) {
			keep = append(keep, id)
		}
	}
	if named && len(keep) == 0 && len(ids) > 0 {
		return nil, ErrReviewsOnly
	}
	return keep, nil
}

// PoolWait is a review that waits in the pool: when it went in, its areas, how many reviewers it still needs, and which of its areas no active reviewer covers (an empty list when someone covers them all,
// or "any" when the review names no area and the board has no reviewer it could go to at all).
type PoolWait struct {
	TaskID    int64
	Title     string
	PooledAt  time.Time
	Areas     []string
	Needs     int      // reviewers still to come (the wanted number less those who took it)
	Uncovered []string // areas no review-only agent that is not the author covers; ["any"] when the review has no area and there is no eligible reviewer
}

// WaitingPoolReviews lists the board's reviews that still wait in the pool, oldest first, with the areas nobody covers (the health check's line, #8957).
func (s *Store) WaitingPoolReviews(ctx context.Context, project string) ([]PoolWait, error) {
	cands, err := s.poolReviews(ctx, project)
	if err != nil || len(cands) == 0 {
		return nil, err
	}
	subs, err := s.ListSubscribers(ctx, project)
	if err != nil {
		return nil, err
	}
	var out []PoolWait
	for _, c := range cands {
		w, err := loadWorkflow(ctx, s.db, c.id)
		if err != nil || !w.ReviewInPool {
			continue
		}
		task, err := s.GetTask(ctx, project, c.id)
		if err != nil || task == nil {
			continue
		}
		at, _ := time.Parse(time.RFC3339Nano, w.ReviewPooledAt)
		have := 0
		if n := len(w.ReviewRounds); n > 0 && w.ReviewRounds[n-1].Result == "" {
			have = len(w.ReviewRounds[n-1].Reviewers)
		}
		pw := PoolWait{TaskID: c.id, Title: task.Title, PooledAt: at, Areas: w.ReviewAreas, Needs: max(1, w.ReviewersWanted) - have}
		var eligible [][]string // the areas of each review-only agent that may take it
		excluded := s.excludedFromReview(ctx, project, c.id, w)
		for _, sub := range subs {
			if sub.IsActive == 0 || !sub.ReviewsOnly {
				continue
			}
			skip := false
			for _, e := range excluded {
				if e != "" && SameIdentity(e, sub.SubscriberID) {
					skip = true
				}
			}
			if !skip {
				eligible = append(eligible, sub.ReviewAreas.Slice())
			}
		}
		covered := func(area string) bool {
			for _, ar := range eligible {
				if AreasMatch(ar, []string{area}) {
					return true
				}
			}
			return false
		}
		if len(w.ReviewAreas) == 0 {
			if len(eligible) == 0 {
				pw.Uncovered = []string{"any"}
			}
		} else {
			for _, a := range w.ReviewAreas {
				if !covered(a) {
					pw.Uncovered = append(pw.Uncovered, a)
				}
			}
		}
		out = append(out, pw)
	}
	return out, nil
}
