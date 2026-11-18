package board

import (
	"context"
	"fmt"
	"strings"
)

// InReviewByAuthor reports whether task id is in review (review_pending, no verdict on the open round yet) and actor is the author who submitted it (#18336).
func (s *Store) InReviewByAuthor(ctx context.Context, project string, id int64, actor string) bool {
	var status string
	if err := s.db.GetContext(ctx, &status, "SELECT status FROM board_tasks WHERE id=? AND board_id=?", id, project); err != nil || status != "review_pending" {
		return false
	}
	w, err := loadWorkflow(ctx, s.db, id)
	if err != nil || w.CompletionReview == nil || w.OriginalAuthor == "" || !SameIdentity(w.OriginalAuthor, actor) {
		return false
	}
	n := len(w.ReviewRounds)
	return n == 0 || w.ReviewRounds[n-1].Result == ""
}

// NewRevisionInReview records a new revision from the author of a task that is in review (#18336), where submit-review is otherwise refused: the evidence replaces the one the reviewers have,
// and the open round's reviewers (when one is open) get the next round on the SAME review tasks, each pending again, so the old revision is superseded. The task stays in review with the orchestrator.
// reopened is nil when no round is open yet (the review waits for the orchestrator or the pool): the new evidence is what they will read. orch is who holds the task.
func (s *Store) NewRevisionInReview(ctx context.Context, project string, id int64, actor, message, outcome, reason string, artifacts []TaskArtifact, expectedRevision *int, candidateRevision string) (orch string, reopened *ReviewRound, err error) {
	return s.NewRevisionInReviewAtHead(ctx, project, id, actor, message, outcome, reason, artifacts, expectedRevision, candidateRevision, "")
}

// NewRevisionInReviewAtHead is that with the commit the author names ("" for none): it replaces the head recorded at the first submit, so the author can correct a wrong one (#19685).
func (s *Store) NewRevisionInReviewAtHead(ctx context.Context, project string, id int64, actor, message, outcome, reason string, artifacts []TaskArtifact, expectedRevision *int, candidateRevision, head string) (orch string, reopened *ReviewRound, err error) {
	head = strings.TrimSpace(head)
	if head != "" && !commitHead.MatchString(head) {
		return "", nil, fmt.Errorf("head must be a commit id: 7 to 64 hex characters (got %q)", clipHead(head))
	}
	if strings.TrimSpace(reason) == "" || len(reason) > 4096 || len(message) > 65536 {
		return "", nil, fmt.Errorf("a review reason is required (maximum 4096 characters); message maximum is 65536")
	}
	if outcome == "" {
		outcome = "success"
	}
	if outcome != "success" && outcome != "failed" {
		return "", nil, fmt.Errorf("proposed outcome must be success or failed")
	}
	artifacts = copyArtifacts(artifacts)
	if _, err := validateTaskArtifacts(artifacts); err != nil {
		return "", nil, err
	}
	clearStamps(artifacts)
	if !s.InReviewByAuthor(ctx, project, id, actor) {
		return "", nil, fmt.Errorf("only the author can send a new revision, and only while the task is in review with no verdict yet")
	}
	w0, err := loadWorkflow(ctx, s.db, id)
	if err != nil {
		return "", nil, err
	}
	gateResults, gateErr := checkCompletionGatesWithPolicy(w0.CompletionGates, artifacts, candidateRevision, s.completionCheckRunner, s.completionChecksEnabled)
	if gateErr != nil && outcome == "success" {
		return "", nil, gateErr
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback()
	var row struct {
		Status     string  `db:"status"`
		AssignedTo *string `db:"assigned_to"`
		Revision   int     `db:"revision"`
		Title      string  `db:"title"`
	}
	if err := tx.GetContext(ctx, &row, "SELECT status,assigned_to,revision,title FROM board_tasks WHERE id=? AND board_id=?", id, project); err != nil {
		return "", nil, err
	}
	if row.Revision > 1 && (expectedRevision == nil || *expectedRevision != row.Revision) {
		return "", nil, fmt.Errorf("task #%d has revision %d; reread task detail before submitting review", id, row.Revision)
	}
	w, err := loadWorkflow(ctx, tx, id)
	if err != nil {
		return "", nil, err
	}
	n := len(w.ReviewRounds)
	if row.Status != "review_pending" || w.CompletionReview == nil || !SameIdentity(w.OriginalAuthor, actor) || (n > 0 && w.ReviewRounds[n-1].Result != "") {
		return "", nil, fmt.Errorf("task #%d changed while the revision was being sent: it is no longer in review with you", id)
	}
	if head != "" {
		w.SubmittedHead = head
	}
	w.CompletionReview = &CompletionReview{SubmittedBy: actor, SubmittedAt: nowUTC(), Message: message, ProposedOutcome: outcome, Reason: reason, Artifacts: artifacts, CandidateRevision: candidateRevision, GateResults: gateResults,
		ReleasedBy: "Coral", ReleasedAt: nowUTC(), ReleaseReason: "a new revision was submitted while the task was in review"}
	if n > 0 {
		if reopened, err = reopenReviews(ctx, tx, project, id, &w); err != nil {
			return "", nil, err
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE board_tasks SET edited_at=? WHERE id=? AND board_id=?", nowUTC(), id, project); err != nil {
		return "", nil, err
	}
	if err := saveWorkflow(ctx, tx, id, w); err != nil {
		return "", nil, err
	}
	if err := tx.Commit(); err != nil {
		return "", nil, err
	}
	s.NoteArtifactsChanged(project)
	if row.AssignedTo != nil {
		orch = *row.AssignedTo
	}
	return orch, reopened, nil
}
