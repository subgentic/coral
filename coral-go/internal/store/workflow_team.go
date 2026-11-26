package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
)

// The workflows a team's Orchestrator proposes (#21505). A proposal is a workflow row (Team set) and, when it has a schedule, one scheduled job; both start disabled and are enabled only by ApproveTeamWorkflow,
// which compares the hash the Operator was shown with the hash of what is stored. Every change an Orchestrator makes turns both off in the same transaction.

// Limits on a team's proposals: they bound what can land in the Operator's Needs you.
const (
	MaxTeamWorkflows          = 10 // proposed workflows a team holds at once
	MaxTeamProposalsPerHour   = 6  // proposals and changes a team makes in an hour
	TeamWorkflowEventPropose  = "propose"
	TeamWorkflowEventApprove  = "approve"
	TeamWorkflowEventDeny     = "deny"
	TeamWorkflowEventDisable  = "disable"
	TeamWorkflowEventDelete   = "delete"
	TeamWorkflowEventRefused  = "refused" // a run stopped because what would run is not what was approved
	TeamWorkflowEventTestRun  = "test_run"
	teamWorkflowEventsKeepFor = 30 * 24 * time.Hour
)

var (
	ErrTeamWorkflowLimit    = fmt.Errorf("a team holds at most %d proposed automations: delete one first", MaxTeamWorkflows)
	ErrTeamProposalRate     = fmt.Errorf("a team may propose or change at most %d automations an hour", MaxTeamProposalsPerHour)
	ErrTeamWorkflowChanged  = errors.New("the automation changed since it was shown: look at it again before approving")
	ErrTeamWorkflowMissing  = errors.New("no such automation")
	ErrNotATeamWorkflow     = errors.New("this workflow is not one a team proposed")
	ErrTeamWorkflowNotFound = ErrTeamWorkflowMissing
)

// TeamWorkflowJobOf is the scheduled job of a proposed workflow, or nil when it has none (a workflow run only by hand).
func (s *WorkflowStore) TeamWorkflowJobOf(ctx context.Context, workflowID int64) (*ScheduledJob, error) {
	var j ScheduledJob
	err := s.db.GetContext(ctx, &j, `SELECT * FROM scheduled_jobs WHERE workflow_id = ? AND job_type = 'workflow' ORDER BY id LIMIT 1`, workflowID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &j, err
}

// TeamWorkflowByName is the team's own proposed workflow of that name.
func (s *WorkflowStore) TeamWorkflowByName(ctx context.Context, team, name string) (*Workflow, error) {
	var w Workflow
	err := s.db.GetContext(ctx, &w, `SELECT w.* FROM workflows w JOIN team_workflows t ON t.workflow_id = w.id WHERE t.team = ? AND w.name = ?`, team, name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	w.HydrateSteps()
	s.fillBoards(ctx, &w)
	return &w, nil
}

// ListTeamWorkflows is every workflow the team proposed, oldest first.
func (s *WorkflowStore) ListTeamWorkflows(ctx context.Context, team string) ([]Workflow, error) {
	var ws []Workflow
	if err := s.db.SelectContext(ctx, &ws, `SELECT w.* FROM workflows w JOIN team_workflows t ON t.workflow_id = w.id WHERE t.team = ? ORDER BY w.id`, team); err != nil {
		return nil, err
	}
	ptrs := make([]*Workflow, len(ws))
	for i := range ws {
		ws[i].HydrateSteps()
		ptrs[i] = &ws[i]
	}
	s.fillBoards(ctx, ptrs...)
	return ws, nil
}

func (s *WorkflowStore) teamEventsSince(ctx context.Context, tx *sqlx.Tx, team, kind string, since time.Time) (int, error) {
	var n int
	err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM team_workflow_events WHERE team = ? AND kind = ? AND at >= ?`, team, kind, since.Unix())
	return n, err
}

func recordTeamEvent(ctx context.Context, tx *sqlx.Tx, team string, wfID int64, name, kind, hash, who string, now time.Time) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO team_workflow_events (team, workflow_id, name, kind, hash, who, at) VALUES (?, ?, ?, ?, ?, ?, ?)`, team, wfID, name, kind, hash, who, now.Unix())
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM team_workflow_events WHERE at < ?`, now.Add(-teamWorkflowEventsKeepFor).Unix())
	return err
}

// RecordTeamWorkflowEvent writes one row of the record (an approve, deny, disable, delete or a refused run): the hash and who, never the text.
func (s *WorkflowStore) RecordTeamWorkflowEvent(ctx context.Context, team string, wfID int64, name, kind, hash, who string) error {
	return s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		return recordTeamEvent(ctx, tx, team, wfID, name, kind, hash, who, time.Now())
	})
}

// TeamWorkflowEvent is one row of the record.
type TeamWorkflowEvent struct {
	ID         int64  `db:"id" json:"id"`
	Team       string `db:"team" json:"team"`
	WorkflowID int64  `db:"workflow_id" json:"workflow_id"`
	Name       string `db:"name" json:"name"`
	Kind       string `db:"kind" json:"kind"`
	Hash       string `db:"hash" json:"hash"`
	Who        string `db:"who" json:"who"`
	At         int64  `db:"at" json:"at"`
}

// TeamWorkflowEvents lists the team's record, newest first.
func (s *WorkflowStore) TeamWorkflowEvents(ctx context.Context, team string, limit int) ([]TeamWorkflowEvent, error) {
	var out []TeamWorkflowEvent
	err := s.db.SelectContext(ctx, &out, `SELECT * FROM team_workflow_events WHERE team = ? ORDER BY id DESC LIMIT ?`, team, limit)
	return out, err
}

// CreateTeamWorkflow stores a proposal: the workflow and its job, both disabled, in one transaction. The caller's Enabled is ignored. hash is what the card will show (the proposal event names it).
func (s *WorkflowStore) CreateTeamWorkflow(ctx context.Context, w *Workflow, job *ScheduledJob, hash string, now time.Time) (*Workflow, *ScheduledJob, error) {
	if w.Team == "" {
		return nil, nil, ErrNotATeamWorkflow
	}
	w.Enabled = 0
	w.ApprovedHash, w.ApprovedFiles, w.ApprovedAt = "", "", ""
	err := s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		var held int
		if err := tx.GetContext(ctx, &held, `SELECT COUNT(*) FROM team_workflows WHERE team = ?`, w.Team); err != nil {
			return err
		}
		if held >= MaxTeamWorkflows {
			return ErrTeamWorkflowLimit
		}
		if n, err := s.teamEventsSince(ctx, tx, w.Team, TeamWorkflowEventPropose, now.Add(-time.Hour)); err != nil {
			return err
		} else if n >= MaxTeamProposalsPerHour {
			return ErrTeamProposalRate
		}
		stamp := now.UTC().Format(ISOFormat)
		w.CreatedAt, w.UpdatedAt = stamp, stamp
		if w.BaseBranch == "" {
			w.BaseBranch = "main"
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO workflows
			(name, description, steps_json, default_agent_json, repo_path, base_branch, max_duration_s, cleanup_worktree, enabled, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
			w.Name, w.Description, w.StepsJSON, w.DefaultAgentJSON, w.RepoPath, w.BaseBranch, w.MaxDurationS, w.CleanupWorktree, stamp, stamp)
		if err != nil {
			return err
		}
		w.ID, _ = res.LastInsertId()
		w.Board = ""
		if _, err := tx.ExecContext(ctx, `INSERT INTO team_workflows (workflow_id, team, proposed_by) VALUES (?, ?, ?)`, w.ID, w.Team, w.ProposedBy); err != nil {
			return err
		}
		if job != nil {
			job.JobType, job.WorkflowID, job.Enabled = "workflow", &w.ID, 0
			job.TeamName = ""
			job.CreatedAt, job.UpdatedAt = stamp, stamp
			if job.Timezone == "" {
				job.Timezone = "UTC"
			}
			jr, err := tx.ExecContext(ctx, `INSERT INTO scheduled_jobs
				(name, description, cron_expr, timezone, agent_type, repo_path, base_branch, prompt, enabled, max_duration_s, cleanup_worktree, no_worktree, trust_worktree, flags, job_type, workflow_id, team_name, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'claude', ?, ?, '', 0, ?, 1, 1, 0, '', 'workflow', ?, '', ?, ?)`,
				job.Name, job.Description, job.CronExpr, job.Timezone, w.RepoPath, w.BaseBranch, w.MaxDurationS, w.ID, stamp, stamp)
			if err != nil {
				return err
			}
			job.ID, _ = jr.LastInsertId()
			job.RepoPath, job.BaseBranch, job.MaxDurationS = w.RepoPath, w.BaseBranch, w.MaxDurationS
		}
		return recordTeamEvent(ctx, tx, w.Team, w.ID, w.Name, TeamWorkflowEventPropose, hash, w.ProposedBy, now)
	})
	if err != nil {
		return nil, nil, err
	}
	w.HydrateSteps()
	return w, job, nil
}

// ReplaceTeamWorkflow stores a change by an Orchestrator: the new definition of the workflow and its job, and both turned OFF, in the same transaction. A change can never leave either one on. The job is made
// when the change gives a schedule and the workflow had none, and removed when it gives none. The approved hash is kept (the card says what it was); it matches the new version only if the change is a revert.
func (s *WorkflowStore) ReplaceTeamWorkflow(ctx context.Context, w *Workflow, job *ScheduledJob, hash, who string, now time.Time) (*Workflow, *ScheduledJob, error) {
	if w.ID == 0 || w.Team == "" {
		return nil, nil, ErrNotATeamWorkflow
	}
	err := s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		if n, err := s.teamEventsSince(ctx, tx, w.Team, TeamWorkflowEventPropose, now.Add(-time.Hour)); err != nil {
			return err
		} else if n >= MaxTeamProposalsPerHour {
			return ErrTeamProposalRate
		}
		stamp := now.UTC().Format(ISOFormat)
		res, err := tx.ExecContext(ctx, `UPDATE workflows SET description = ?, steps_json = ?, default_agent_json = ?, repo_path = ?, base_branch = ?, max_duration_s = ?, cleanup_worktree = ?, enabled = 0, updated_at = ?
			WHERE id = ? AND id IN (SELECT workflow_id FROM team_workflows WHERE team = ?)`, w.Description, w.StepsJSON, w.DefaultAgentJSON, w.RepoPath, w.BaseBranch, w.MaxDurationS, w.CleanupWorktree, stamp, w.ID, w.Team)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrTeamWorkflowMissing
		}
		if _, err := tx.ExecContext(ctx, `UPDATE team_workflows SET proposed_by = ? WHERE workflow_id = ?`, who, w.ID); err != nil {
			return err
		}
		var jobID int64
		err = tx.GetContext(ctx, &jobID, `SELECT id FROM scheduled_jobs WHERE workflow_id = ? AND job_type = 'workflow' ORDER BY id LIMIT 1`, w.ID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		switch {
		case job == nil && jobID != 0:
			if _, err := tx.ExecContext(ctx, `DELETE FROM scheduled_jobs WHERE id = ?`, jobID); err != nil {
				return err
			}
		case job != nil && jobID != 0:
			if job.Timezone == "" {
				job.Timezone = "UTC"
			}
			if _, err := tx.ExecContext(ctx, `UPDATE scheduled_jobs SET cron_expr = ?, timezone = ?, repo_path = ?, base_branch = ?, max_duration_s = ?, enabled = 0, resumed_at = '', paused_reason = '', updated_at = ? WHERE id = ?`,
				job.CronExpr, job.Timezone, w.RepoPath, w.BaseBranch, w.MaxDurationS, stamp, jobID); err != nil {
				return err
			}
			job.ID, job.Enabled = jobID, 0
		case job != nil:
			job.JobType, job.WorkflowID, job.Enabled = "workflow", &w.ID, 0
			if job.Timezone == "" {
				job.Timezone = "UTC"
			}
			jr, err := tx.ExecContext(ctx, `INSERT INTO scheduled_jobs
				(name, description, cron_expr, timezone, agent_type, repo_path, base_branch, prompt, enabled, max_duration_s, cleanup_worktree, no_worktree, trust_worktree, flags, job_type, workflow_id, team_name, created_at, updated_at)
				VALUES (?, ?, ?, ?, 'claude', ?, ?, '', 0, ?, 1, 1, 0, '', 'workflow', ?, '', ?, ?)`,
				job.Name, job.Description, job.CronExpr, job.Timezone, w.RepoPath, w.BaseBranch, w.MaxDurationS, w.ID, stamp, stamp)
			if err != nil {
				return err
			}
			job.ID, _ = jr.LastInsertId()
		}
		return recordTeamEvent(ctx, tx, w.Team, w.ID, w.Name, TeamWorkflowEventPropose, hash, who, now)
	})
	if err != nil {
		return nil, nil, err
	}
	out, err := s.GetWorkflow(ctx, w.ID)
	return out, job, err
}

// DisableTeamWorkflow turns the workflow and its job off in one transaction. It is what an Orchestrator's disable does, and what a run does that finds what would run is not what was approved. kind and who go
// to the record.
func (s *WorkflowStore) DisableTeamWorkflow(ctx context.Context, id int64, kind, hash, who string) error {
	return s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		w, err := teamWorkflowTx(ctx, tx, id)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workflows SET enabled = 0, updated_at = ? WHERE id = ?`, nowUTC(), id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE scheduled_jobs SET enabled = 0, updated_at = ? WHERE workflow_id = ?`, nowUTC(), id); err != nil {
			return err
		}
		return recordTeamEvent(ctx, tx, w.Team, id, w.Name, kind, hash, who, time.Now())
	})
}

// DeleteTeamWorkflow removes the workflow, its job and its runs (the runs cascade).
func (s *WorkflowStore) DeleteTeamWorkflow(ctx context.Context, id int64, kind, hash, who string) error {
	return s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		w, err := teamWorkflowTx(ctx, tx, id)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM scheduled_jobs WHERE workflow_id = ?`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM workflows WHERE id = ?`, id); err != nil {
			return err
		}
		return recordTeamEvent(ctx, tx, w.Team, id, w.Name, kind, hash, who, time.Now())
	})
}

// ApproveTeamWorkflow enables the workflow and its job IF what is stored hashes to expect: current computes the hash of the rows read inside this transaction, so a change that landed after the card was
// shown, or after the caller looked, enables nothing (ErrTeamWorkflowChanged). files is the repo files that hash covers, stored with it for the run's check.
func (s *WorkflowStore) ApproveTeamWorkflow(ctx context.Context, id int64, expect, files, who string, current func(w *Workflow, job *ScheduledJob) (hash, snapshot string, err error)) error {
	return s.db.WithTx(ctx, func(tx *sqlx.Tx) error {
		w, err := teamWorkflowTx(ctx, tx, id)
		if err != nil {
			return err
		}
		var job *ScheduledJob
		var j ScheduledJob
		if err := tx.GetContext(ctx, &j, `SELECT * FROM scheduled_jobs WHERE workflow_id = ? AND job_type = 'workflow' ORDER BY id LIMIT 1`, id); err == nil {
			job = &j
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		now, snapshot, err := current(w, job)
		if err != nil || now != expect {
			return ErrTeamWorkflowChanged
		}
		stamp := nowUTC()
		if _, err := tx.ExecContext(ctx, `UPDATE workflows SET enabled = 1, updated_at = ? WHERE id = ?`, stamp, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE team_workflows SET approved_hash = ?, approved_files = ?, approved_snapshot = ?, approved_at = ? WHERE workflow_id = ?`, expect, files, snapshot, stamp, id); err != nil {
			return err
		}
		if job != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE scheduled_jobs SET enabled = 1, resumed_at = ?, paused_reason = '', updated_at = ? WHERE id = ?`, stamp, stamp, job.ID); err != nil {
				return err
			}
		}
		return recordTeamEvent(ctx, tx, w.Team, id, w.Name, TeamWorkflowEventApprove, expect, who, time.Now())
	})
}

// teamRow is the side table's row of a proposed workflow.
type teamRow struct {
	WorkflowID       int64  `db:"workflow_id"`
	Team             string `db:"team"`
	ProposedBy       string `db:"proposed_by"`
	ApprovedHash     string `db:"approved_hash"`
	ApprovedFiles    string `db:"approved_files"`
	ApprovedSnapshot string `db:"approved_snapshot"`
	ApprovedAt       string `db:"approved_at"`
}

func (r teamRow) put(w *Workflow) {
	w.Team, w.ProposedBy, w.ApprovedHash, w.ApprovedFiles, w.ApprovedSnapshot, w.ApprovedAt = r.Team, r.ProposedBy, r.ApprovedHash, r.ApprovedFiles, r.ApprovedSnapshot, r.ApprovedAt
}

// IsTeamWorkflow reads, from the database and with its error, whether the workflow is one a team's Orchestrator proposed. The run gate asks this and not the Workflow value it was handed, so a value read
// without its team (or a read that failed) can never make a proposal look like an Operator's workflow.
func (s *WorkflowStore) IsTeamWorkflow(ctx context.Context, id int64) (bool, error) {
	var n int
	if err := s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM team_workflows WHERE workflow_id = ?`, id); err != nil {
		return false, err
	}
	return n > 0, nil
}

// fillTeams sets the team fields on each workflow from team_workflows.
func (s *WorkflowStore) fillTeams(ctx context.Context, ws []*Workflow) {
	var rows []teamRow
	if err := s.db.SelectContext(ctx, &rows, `SELECT * FROM team_workflows`); err != nil {
		return
	}
	by := make(map[int64]teamRow, len(rows))
	for _, r := range rows {
		by[r.WorkflowID] = r
	}
	for _, w := range ws {
		if r, ok := by[w.ID]; ok {
			r.put(w)
		}
	}
}

// teamWorkflowTx reads a proposed workflow and its team row inside a transaction.
func teamWorkflowTx(ctx context.Context, tx *sqlx.Tx, id int64) (*Workflow, error) {
	var w Workflow
	if err := tx.GetContext(ctx, &w, `SELECT * FROM workflows WHERE id = ?`, id); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTeamWorkflowMissing
	} else if err != nil {
		return nil, err
	}
	var r teamRow
	if err := tx.GetContext(ctx, &r, `SELECT * FROM team_workflows WHERE workflow_id = ?`, id); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotATeamWorkflow
	} else if err != nil {
		return nil, err
	}
	r.put(&w)
	w.HydrateSteps()
	return &w, nil
}

// TeamTestRunsSince counts the test runs the team's Orchestrator started since t.
func (s *WorkflowStore) TeamTestRunsSince(ctx context.Context, team string, t time.Time) (int, error) {
	var n int
	err := s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM team_workflow_events WHERE team = ? AND kind = ? AND at >= ?`, team, TeamWorkflowEventTestRun, t.Unix())
	return n, err
}
