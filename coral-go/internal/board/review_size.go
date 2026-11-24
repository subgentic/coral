package board

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/reviewsize"
)

// settingReviewSize holds a team's review size guard (#21022) as one JSON value in board_settings. A team that never saved it has the guard off.
const settingReviewSize = "review_size_guard"

// GetReviewSizeSetting reads the team's guard. A value that is not valid JSON or that no longer validates is an error, never "off": a guard that cannot be read must say so, not stop warning quietly.
func (s *Store) GetReviewSizeSetting(ctx context.Context, project string) (reviewsize.Setting, error) {
	raw, err := s.boardSettingValue(ctx, project, settingReviewSize)
	if err != nil || raw == "" {
		return reviewsize.Setting{}, err
	}
	var set reviewsize.Setting
	if err := json.Unmarshal([]byte(raw), &set); err != nil {
		return reviewsize.Setting{}, err
	}
	return set.Validate()
}

// SetReviewSizeSetting validates and saves the team's guard, and returns what was saved.
func (s *Store) SetReviewSizeSetting(ctx context.Context, project string, set reviewsize.Setting) (reviewsize.Setting, error) {
	set, err := set.Validate()
	if err != nil {
		return set, err
	}
	b, err := json.Marshal(set)
	if err != nil {
		return set, err
	}
	return set, s.SetBoardSetting(ctx, project, settingReviewSize, string(b))
}

// SendBackFromReview returns a task that is waiting in review to its author with a note (#21059): what Send back on the review size banner does. The Operator or the team's Orchestrator asks for
// it (the route checks who); the reviewers are not asked to reject. An open round ends as rejected with the note, the reviewers' review tasks that are still open are skipped (they are offered again
// when the author resubmits), and the task is back with its author, pending, like any rejected task. A task with no round yet (nobody was asked to review it) is simply returned. A task whose last
// round already ended is not in review: it is refused.
func (s *Store) SendBackFromReview(ctx context.Context, project string, id int64, actor, note string) (*Task, error) {
	if strings.TrimSpace(note) == "" || len(note) > 4096 {
		return nil, fmt.Errorf("say why: a send-back needs a note (4096 characters at most)")
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var status string
	if err := tx.GetContext(ctx, &status, "SELECT status FROM board_tasks WHERE id=? AND board_id=?", id, project); err != nil {
		return nil, fmt.Errorf("task #%d is not on this board", id)
	}
	w, err := loadWorkflow(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if status != "review_pending" || w.OriginalAuthor == "" {
		return nil, fmt.Errorf("task #%d is not waiting in review with an author to return it to", id)
	}
	if n := len(w.ReviewRounds); n > 0 {
		round := &w.ReviewRounds[n-1]
		if round.Result != "" {
			return nil, fmt.Errorf("task #%d has no open review: round %d already ended (%s)", id, round.Round, round.Result)
		}
		round.Result, round.SentBackBy, round.SentBackNote = "rejected", actor, note
		if err := skipOtherReviewTasks(ctx, tx, project, id, round, 0, actor); err != nil {
			return nil, err
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE board_tasks SET status='pending', assigned_to=?, "+keepWorkBeforeSQL+", claimed_at=NULL, edited_at=? WHERE id=? AND board_id=? AND status='review_pending'",
		append(append([]any{ptr.NullIfEmpty(w.OriginalAuthor)}, keepWorkArgs(submittedAtOf(w.CompletionReview))...), nowUTC(), id, project)...); err != nil {
		return nil, err
	}
	w.ReviewInPool = false
	w.CompletionReview = nil
	if err := saveWorkflow(ctx, tx, id, w); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	s.NoteArtifactsChanged(project)
	return s.getTaskByID(ctx, project, id)
}
