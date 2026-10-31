package board

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// A team's planning limits and the Operator's approval of what is added to it (#11389). Three board settings, all off by default so a team that never sets them is unchanged:
//   - max_open_goals: how many goals may be open at once (proposed, active or blocked, and goals waiting for approval); 0 is no limit.
//   - goals_need_approval, tasks_need_approval: an agent's new goal or task is stored as a PROPOSAL, not made, until the Operator approves it. The Operator is never held up by either.
// A proposal is a row of board_proposals. Approve makes the goal or task exactly as proposed (the handler claims the proposal first, so it is made once); Reject records the reason; a proposal not decided in
// ProposalTTL is marked expired, and is kept so the Operator sees it (never silently deleted). The store holds the rules every writer must keep (the cap, the one-per-title merge, the claim); who may
// propose, decide, and the notices are the handlers'.

// proposalCols are the columns every read of a proposal takes.
const proposalCols = `id, board_id, kind, title, payload, proposer, goal_proposal_id, state, reason, created_at, expires_at, decided_at, created_ref, notified, claimed_at, claim_title`

const (
	settingMaxOpenGoals         = "max_open_goals"
	settingGoalsNeedApproval    = "goals_need_approval"
	settingTasksNeedApproval    = "tasks_need_approval"
	ProposalGoal                = "goal"
	ProposalTask                = "task"
	ProposalPending             = "pending"
	ProposalApproving           = "approving" // claimed by an Approve that is making the goal or task: no other Approve or Reject takes it
	ProposalApproved            = "approved"
	ProposalRejected            = "rejected"
	ProposalExpired             = "expired"
	ProposalTTL                 = 7 * 24 * time.Hour
	MaxOpenGoalsCeiling         = 1000
	maxProposalTitle            = 512
	maxProposalPayloadBytes     = 300 << 10
	maxProposalReason           = 300
	maxPendingProposalsPerBoard = 200 // a flood of proposals is refused: the Operator has to read them
)

// The refusals the handlers turn into plain sentences.
var (
	ErrProposalNotFound  = &GoalError{"proposal_not_found", "this team has no such proposal"}
	ErrProposalNotOpen   = &GoalError{"proposal_not_pending", "this proposal was already decided (or is being made)"}
	ErrProposalTooMany   = &GoalError{"too_many_proposals", "this team already has the most proposals waiting for the Operator it can hold: wait for them to be decided"}
	ErrProposalWaitsGoal = &GoalError{"waits_for_goal", "this task waits for the goal it was proposed under: approve that goal first"}
	ErrProposalGoalGone  = &GoalError{"goal_not_approved", "the goal this task was proposed under was rejected or expired, so this task cannot be approved: reject it"}
)

// ErrGoalLimit is the refusal of a goal past the team's cap. The message names the limit; the handler fills it in.
func ErrGoalLimit(limit int) *GoalError {
	return &GoalError{"goal_limit", fmt.Sprintf("this team allows %d open goals: close one, or ask the Operator to raise the limit", limit)}
}

// Proposal is one thing an agent asked to add and the Operator has not decided, or has.
type Proposal struct {
	ID             int64    `db:"id" json:"id"`
	Board          string   `db:"board_id" json:"board_id"`
	Kind           string   `db:"kind" json:"kind"`
	Title          string   `db:"title" json:"title"`
	Payload        JSONText `db:"payload" json:"payload"`
	Proposer       string   `db:"proposer" json:"proposer"`
	GoalProposalID *int64   `db:"goal_proposal_id" json:"goal_proposal_id,omitempty"`
	State          string   `db:"state" json:"state"`
	Reason         string   `db:"reason" json:"reason,omitempty"`
	CreatedAt      string   `db:"created_at" json:"created_at"`
	ExpiresAt      string   `db:"expires_at" json:"expires_at"`
	DecidedAt      *string  `db:"decided_at" json:"decided_at,omitempty"`
	CreatedRef     *int64   `db:"created_ref" json:"created_ref,omitempty"` // the id of the goal or task it became
	Notified       bool     `db:"notified" json:"-"`
	ClaimedAt      *string  `db:"claimed_at" json:"-"`  // when an Approve took it (state approving)
	ClaimTitle     string   `db:"claim_title" json:"-"` // the title the goal or task was to have, so a recovery can look for it
}

// JSONText is a JSON value kept as text in a column: it scans from the column's string and writes itself out as the JSON it holds.
type JSONText json.RawMessage

// Scan reads the column (text or bytes).
func (j *JSONText) Scan(src any) error {
	switch v := src.(type) {
	case string:
		*j = JSONText(v)
	case []byte:
		*j = append((*j)[:0], v...)
	case nil:
		*j = nil
	default:
		return fmt.Errorf("a proposal's payload is text, not %T", src)
	}
	return nil
}

// MarshalJSON writes the held JSON (null when there is none).
func (j JSONText) MarshalJSON() ([]byte, error) {
	if len(j) == 0 {
		return []byte("null"), nil
	}
	return []byte(j), nil
}

// ProposalInput is a new proposal: what the agent asked for, as a JSON object the creating handler can replay.
type ProposalInput struct {
	Board          string
	Kind           string
	Title          string
	Payload        json.RawMessage
	Proposer       string
	GoalProposalID *int64
}

func (s *Store) ensureProposalsSchema(ctx context.Context) error {
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS board_proposals (
			id               INTEGER PRIMARY KEY AUTOINCREMENT,
			board_id         TEXT NOT NULL,
			kind             TEXT NOT NULL CHECK (kind IN ('goal', 'task')),
			title            TEXT NOT NULL,
			norm_title       TEXT NOT NULL,
			payload          TEXT NOT NULL,
			proposer         TEXT NOT NULL DEFAULT '',
			goal_proposal_id INTEGER,
			state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approving', 'approved', 'rejected', 'expired')),
			reason           TEXT NOT NULL DEFAULT '',
			created_at       TEXT NOT NULL,
			expires_at       TEXT NOT NULL,
			decided_at       TEXT,
			created_ref      INTEGER,
			notified         INTEGER NOT NULL DEFAULT 0,
			claimed_at       TEXT,
			claim_title      TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_board_proposals_board ON board_proposals(board_id, state, id)`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// ---- the settings ----

// ProposalSettings are the three planning limits of a board.
type ProposalSettings struct {
	MaxOpenGoals      int  `json:"max_open_goals"`
	GoalsNeedApproval bool `json:"goals_need_approval"`
	TasksNeedApproval bool `json:"tasks_need_approval"`
}

// planningSettings reads the three settings through q (the store, or the transaction of a write). A setting that cannot be read is an error, never "off": the check fails closed.
func (s *Store) planningSettings(ctx context.Context, q goalQuerier, project string) (ProposalSettings, error) {
	get := func(key string) (string, error) {
		var v string
		err := q.GetContext(ctx, &v, `SELECT value FROM board_settings WHERE project = ? AND key = ?`, project, key)
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return v, err
	}
	var out ProposalSettings
	v, err := get(settingMaxOpenGoals)
	if err != nil {
		return ProposalSettings{}, err
	}
	if n := 0; v != "" {
		if _, serr := fmt.Sscanf(v, "%d", &n); serr == nil && n > 0 {
			out.MaxOpenGoals = min(n, MaxOpenGoalsCeiling)
		}
	}
	if v, err = get(settingGoalsNeedApproval); err != nil {
		return ProposalSettings{}, err
	}
	out.GoalsNeedApproval = v == "true"
	if v, err = get(settingTasksNeedApproval); err != nil {
		return ProposalSettings{}, err
	}
	out.TasksNeedApproval = v == "true"
	return out, nil
}

// PlanningSettings is the board's three limits.
func (s *Store) PlanningSettings(ctx context.Context, project string) (ProposalSettings, error) {
	return s.planningSettings(ctx, s.db, project)
}

// openGoalCount is the goals that count against the cap: open ones, and goals waiting for approval (except `except`, a proposal being approved into a goal, which is already counted once).
func (s *Store) openGoalCount(ctx context.Context, q goalQuerier, project string, except int64) (int, error) {
	var n int
	err := q.GetContext(ctx, &n, `SELECT
		(SELECT COUNT(*) FROM board_goals WHERE board_id = ? AND state IN ('proposed', 'active', 'blocked'))
		+ (SELECT COUNT(*) FROM board_proposals WHERE board_id = ? AND kind = 'goal' AND state IN ('pending', 'approving') AND id != ?)`, project, project, except)
	return n, err
}

// checkGoalCap refuses a new goal past the board's cap. except is the proposal being turned into this goal (0 for none).
func (s *Store) checkGoalCap(ctx context.Context, q goalQuerier, project string, except int64) error {
	set, err := s.planningSettings(ctx, q, project)
	if err != nil {
		return err
	}
	if set.MaxOpenGoals <= 0 {
		return nil
	}
	n, err := s.openGoalCount(ctx, q, project, except)
	if err != nil {
		return err
	}
	if n >= set.MaxOpenGoals {
		return ErrGoalLimit(set.MaxOpenGoals)
	}
	return nil
}

// ---- proposals ----

func normTitle(t string) string { return strings.ToLower(strings.Join(strings.Fields(t), " ")) }

// CreateProposal stores a proposal, or returns the pending one that already asks for the same thing (same board, kind and title, ignoring case and spacing): existed is true then. A goal proposal is refused past the
// cap (pending ones count); a board holds at most maxPendingProposalsPerBoard.
func (s *Store) CreateProposal(ctx context.Context, in ProposalInput) (*Proposal, bool, error) {
	if in.Board == "" || (in.Kind != ProposalGoal && in.Kind != ProposalTask) {
		return nil, false, errors.New("a proposal needs a board and a kind")
	}
	title := strings.TrimSpace(in.Title)
	if title == "" || len([]rune(title)) > maxProposalTitle {
		return nil, false, ErrGoalTitleRequired
	}
	if len(in.Payload) == 0 || len(in.Payload) > maxProposalPayloadBytes || !json.Valid(in.Payload) {
		return nil, false, errors.New("a proposal's payload is one JSON object")
	}
	if _, err := s.ExpireProposals(ctx, time.Now()); err != nil {
		return nil, false, err
	}
	var dup Proposal
	err := s.db.GetContext(ctx, &dup, `SELECT id, board_id, kind, title, payload, proposer, goal_proposal_id, state, reason, created_at, expires_at, decided_at, created_ref, notified, claimed_at, claim_title FROM board_proposals WHERE board_id = ? AND kind = ? AND norm_title = ? AND state IN ('pending', 'approving') ORDER BY id LIMIT 1`, in.Board, in.Kind, normTitle(title))
	if err == nil {
		return &dup, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	var pending int
	if err := s.db.GetContext(ctx, &pending, `SELECT COUNT(*) FROM board_proposals WHERE board_id = ? AND state = 'pending'`, in.Board); err != nil {
		return nil, false, err
	}
	if pending >= maxPendingProposalsPerBoard {
		return nil, false, ErrProposalTooMany
	}
	if in.Kind == ProposalGoal {
		if err := s.checkGoalCap(ctx, s.db, in.Board, 0); err != nil {
			return nil, false, err
		}
	}
	now := time.Now().UTC()
	res, err := s.execEnsuringBoard(ctx, in.Board, `INSERT INTO board_proposals (board_id, kind, title, norm_title, payload, proposer, goal_proposal_id, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
		in.Board, in.Kind, title, normTitle(title), string(in.Payload), in.Proposer, in.GoalProposalID, now.Format(time.RFC3339), now.Add(ProposalTTL).Format(time.RFC3339))
	if err != nil {
		return nil, false, err
	}
	id, _ := res.LastInsertId()
	p, err := s.GetProposal(ctx, in.Board, id)
	return p, false, err
}

// GetProposal is one proposal of a board.
func (s *Store) GetProposal(ctx context.Context, project string, id int64) (*Proposal, error) {
	var p Proposal
	err := s.db.GetContext(ctx, &p, `SELECT id, board_id, kind, title, payload, proposer, goal_proposal_id, state, reason, created_at, expires_at, decided_at, created_ref, notified, claimed_at, claim_title FROM board_proposals WHERE board_id = ? AND id = ?`, project, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProposalNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// ListProposals are a board's proposals in the states named (all of them when none), oldest first; project "" lists every board's (the Operator's Needs you).
func (s *Store) ListProposals(ctx context.Context, project string, states ...string) ([]Proposal, error) {
	q := `SELECT id, board_id, kind, title, payload, proposer, goal_proposal_id, state, reason, created_at, expires_at, decided_at, created_ref, notified, claimed_at, claim_title FROM board_proposals WHERE 1 = 1`
	var args []any
	if project != "" {
		q += ` AND board_id = ?`
		args = append(args, project)
	}
	if len(states) > 0 {
		q += ` AND state IN (` + strings.TrimSuffix(strings.Repeat("?,", len(states)), ",") + `)`
		for _, st := range states {
			args = append(args, st)
		}
	}
	q += ` ORDER BY id LIMIT 500`
	var out []Proposal
	if err := s.db.SelectContext(ctx, &out, q, args...); err != nil {
		return nil, err
	}
	return out, nil
}

// ExpireProposals marks every pending proposal past its time as expired and returns them (the handler tells each proposer once). They are kept: the Operator sees them as expired.
func (s *Store) ExpireProposals(ctx context.Context, now time.Time) ([]Proposal, error) {
	cut := now.UTC().Format(time.RFC3339)
	var due []Proposal
	if err := s.db.SelectContext(ctx, &due, `SELECT id, board_id, kind, title, payload, proposer, goal_proposal_id, state, reason, created_at, expires_at, decided_at, created_ref, notified, claimed_at, claim_title FROM board_proposals WHERE state = 'pending' AND expires_at <= ?`, cut); err != nil {
		return nil, err
	}
	var out []Proposal
	for _, p := range due {
		res, err := s.db.ExecContext(ctx, `UPDATE board_proposals SET state = 'expired', decided_at = ?, reason = 'not decided in 7 days' WHERE id = ? AND state = 'pending'`, cut, p.ID)
		if err != nil {
			return out, err
		}
		if n, _ := res.RowsAffected(); n == 1 {
			p.State = ProposalExpired
			out = append(out, p)
		}
	}
	return out, nil
}

// ClaimProposal takes a pending proposal for approval, once: the one caller that gets it makes the goal or task. Another Approve, or a Reject, then sees it is not pending.
func (s *Store) ClaimProposal(ctx context.Context, project string, id int64, madeTitle string) (*Proposal, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `UPDATE board_proposals SET state = 'approving', claimed_at = ?, claim_title = ? WHERE board_id = ? AND id = ? AND state = 'pending' AND expires_at > ?`, now, madeTitle, project, id, now)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		if _, gerr := s.GetProposal(ctx, project, id); gerr != nil {
			return nil, gerr
		}
		return nil, ErrProposalNotOpen
	}
	return s.GetProposal(ctx, project, id)
}

// FinishProposal records that the claimed proposal became the goal or task `ref`.
func (s *Store) FinishProposal(ctx context.Context, project string, id, ref int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE board_proposals SET state = 'approved', created_ref = ?, decided_at = ? WHERE board_id = ? AND id = ? AND state = 'approving'`, ref, nowUTC(), project, id)
	return err
}

// ReleaseProposal gives a claimed proposal back (the goal or task could not be made): it is pending again, and the Operator can try again.
func (s *Store) ReleaseProposal(ctx context.Context, project string, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE board_proposals SET state = 'pending' WHERE board_id = ? AND id = ? AND state = 'approving'`, project, id)
	return err
}

// RejectProposal marks a pending proposal rejected, with the Operator's reason (cleaned and cut by the caller; cut again here), and returns it.
func (s *Store) RejectProposal(ctx context.Context, project string, id int64, reason string) (*Proposal, error) {
	r := []rune(strings.TrimSpace(reason))
	if len(r) > maxProposalReason {
		r = r[:maxProposalReason]
	}
	res, err := s.db.ExecContext(ctx, `UPDATE board_proposals SET state = 'rejected', reason = ?, decided_at = ? WHERE board_id = ? AND id = ? AND state = 'pending'`, string(r), nowUTC(), project, id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		if _, gerr := s.GetProposal(ctx, project, id); gerr != nil {
			return nil, gerr
		}
		return nil, ErrProposalNotOpen
	}
	return s.GetProposal(ctx, project, id)
}

// MarkProposalNotified records that the proposer was told how it ended; it reports whether this call was the one that did (so a notice is posted once).
func (s *Store) MarkProposalNotified(ctx context.Context, project string, id int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE board_proposals SET notified = 1 WHERE board_id = ? AND id = ? AND notified = 0`, project, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// GoalOfProposal is the goal a task proposal waits for: its id once that goal proposal was approved, 0 while it is pending (ErrProposalWaitsGoal), and ErrProposalGoalGone when it was rejected or expired.
func (s *Store) GoalOfProposal(ctx context.Context, project string, goalProposalID int64) (int64, error) {
	gp, err := s.GetProposal(ctx, project, goalProposalID)
	if err != nil {
		return 0, ErrProposalGoalGone
	}
	switch gp.State {
	case ProposalApproved:
		if gp.CreatedRef != nil {
			return *gp.CreatedRef, nil
		}
		return 0, ErrProposalGoalGone
	case ProposalPending, ProposalApproving:
		return 0, ErrProposalWaitsGoal
	}
	return 0, ErrProposalGoalGone
}

// CreateGoalApproved makes the goal of an approved proposal: the same checks as CreateGoal, with the proposal's own place in the cap.
func (s *Store) CreateGoalApproved(ctx context.Context, project string, proposalID int64, in GoalInput) (*Goal, error) {
	if err := s.checkGoalCap(ctx, s.db, project, proposalID); err != nil {
		return nil, err
	}
	return s.createGoalUnchecked(ctx, project, in)
}

// ValidateGoalInput checks a goal's text the way CreateGoal does, without making it: a proposal is only stored when its goal could be made.
func ValidateGoalInput(in GoalInput) error {
	if t, err := goalLine("title", in.Title, MaxGoalTitle); err != nil {
		return err
	} else if t == "" {
		return ErrGoalTitleRequired
	}
	if _, err := goalText("outcome", in.Outcome, MaxGoalOutcome); err != nil {
		return err
	}
	if _, err := goalLine("done_when", in.DoneWhen, MaxGoalDoneWhen); err != nil {
		return err
	}
	return nil
}

// ProposalClaimTimeout is how long a proposal may stay claimed (approving) before it is looked at again: a process that stopped between the claim and the finish leaves it there.
const ProposalClaimTimeout = 5 * time.Minute

// StuckProposals are the proposals claimed more than ProposalClaimTimeout before now and never finished.
func (s *Store) StuckProposals(ctx context.Context, now time.Time) ([]Proposal, error) {
	var out []Proposal
	err := s.db.SelectContext(ctx, &out, `SELECT `+proposalCols+` FROM board_proposals WHERE state = 'approving' AND claimed_at IS NOT NULL AND claimed_at <= ?`, now.Add(-ProposalClaimTimeout).UTC().Format(time.RFC3339))
	return out, err
}

// MadeFor is the id of the goal or task a stuck proposal's Approve made before it stopped, found by the title it was to have, its proposer and the time of the claim (0 when nothing was made).
func (s *Store) MadeFor(ctx context.Context, p *Proposal) (int64, error) {
	if p.ClaimedAt == nil || p.ClaimTitle == "" {
		return 0, nil
	}
	table := "board_tasks"
	title := p.ClaimTitle
	if p.Kind == ProposalGoal {
		table = "board_goals"
		if t, err := goalLine("title", p.ClaimTitle, MaxGoalTitle); err == nil {
			title = t // a goal's title is stored cleaned
		}
	}
	var id int64
	err := s.db.GetContext(ctx, &id, `SELECT id FROM `+table+` WHERE board_id = ? AND title = ? AND created_by = ? AND created_at >= ? ORDER BY id LIMIT 1`, p.Board, title, p.Proposer, *p.ClaimedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return id, err
}
