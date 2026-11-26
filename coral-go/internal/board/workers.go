package board

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// The workers a team approves (mock v3 idea 2, #21467): setups the Operator saved once with the New agent steps and linked to a team, from which the Orchestrator launches a worker for a task
// ('coral-board worker launch "NAME" --task N'). A worker is only a saved launch request: the launch itself goes through the one launch route, so every limit of an agent's launch (the cap on what it may do
// without asking, the team's agent limit, the folder rule) holds for it as it does for any other. Nothing here is read from an agent: the rows are written by the person at the dashboard.

// Worker is one approved setup of a team.
type Worker struct {
	Name           string   `json:"name"`            // what the Orchestrator launches it by; unique in the team, any case
	Role           string   `json:"role"`            // the persona, "Developer"
	Purpose        string   `json:"purpose"`         // one line: what it is for, "for code tasks"
	AgentType      string   `json:"agent_type"`      // claude, codex, ...
	Model          string   `json:"model,omitempty"` // "" = the default for the type
	Thinking       string   `json:"thinking,omitempty"`
	Instructions   string   `json:"instructions"` // the same for every worker of this kind: the start of every launch's first message, so a provider's prompt cache can apply
	WorkingDir     string   `json:"working_dir,omitempty"`
	Skills         []string `json:"skills,omitempty"`
	PermissionMode string   `json:"permission_mode,omitempty"` // "", "default" or "custom:<id>", as the launch route takes it
	CreatedAt      string   `json:"created_at,omitempty"`
	UpdatedAt      string   `json:"updated_at,omitempty"`
}

// Limits of a saved worker: what one team may hold and how long each text may be.
const (
	MaxWorkersPerTeam   = 12
	MaxWorkerName       = 40
	MaxWorkerLine       = 80
	MaxWorkerInstruct   = 8000
	MaxWorkerSkills     = 20
	maxWorkerFieldBytes = 512
)

// Errors a worker's write answers.
var (
	ErrWorkerNotFound = errors.New("no such worker on this team")
	ErrWorkerExists   = errors.New("this team already has a worker with that name")
	ErrWorkerLimit    = errors.New("this team has the most workers it can have")
)

func (s *Store) ensureWorkersSchema(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS team_workers (
		board_id   TEXT NOT NULL,
		name_key   TEXT NOT NULL,
		name       TEXT NOT NULL,
		setup      TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (board_id, name_key)
	)`); err != nil {
		return err
	}
	// Which worker launched which agent, for the "From <worker>" chip (the launch's own record, written by the server after the launch).
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS worker_launches (
		board_id    TEXT NOT NULL,
		session     TEXT NOT NULL,
		worker_name TEXT NOT NULL,
		task_id     INTEGER NOT NULL DEFAULT 0,
		launched_at TEXT NOT NULL,
		PRIMARY KEY (board_id, session)
	)`)
	return err
}

// WorkerKey is the form a worker's name is compared in.
func WorkerKey(name string) string { return strings.ToLower(strings.TrimSpace(name)) }

// CleanWorker trims every text of w and says what is wrong with it ("" when it is fine). Names and lines are one line; the instructions keep their line breaks.
func CleanWorker(w *Worker) string {
	one := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	w.Name, w.Role, w.Purpose = one(w.Name), one(w.Role), one(w.Purpose)
	w.AgentType, w.Model, w.Thinking = strings.TrimSpace(w.AgentType), strings.TrimSpace(w.Model), strings.TrimSpace(w.Thinking)
	w.WorkingDir, w.PermissionMode = strings.TrimSpace(w.WorkingDir), strings.TrimSpace(w.PermissionMode)
	w.Instructions = strings.TrimSpace(strings.ReplaceAll(w.Instructions, "\r\n", "\n"))
	switch {
	case w.Name == "":
		return "a worker needs a name"
	case utf8.RuneCountInString(w.Name) > MaxWorkerName:
		return "a worker's name is at most 40 characters"
	case strings.ContainsAny(w.Name, "@\x00\"'`$\\"):
		return "a worker's name has no @, quotes, backticks, $ or backslash"
	case ClaimsOrchestrator(w.Name, ""):
		return "a worker's name does not say Orchestrator: that seat is the team's own"
	case utf8.RuneCountInString(w.Role) > MaxWorkerLine || utf8.RuneCountInString(w.Purpose) > MaxWorkerLine:
		return "a worker's role and purpose are at most 80 characters each"
	case utf8.RuneCountInString(w.Instructions) > MaxWorkerInstruct:
		return "a worker's instructions are at most 8000 characters"
	case w.AgentType == "" || w.AgentType == "terminal":
		return "a worker runs an agent: name its CLI"
	case len(w.Model) > maxWorkerFieldBytes || len(w.Thinking) > maxWorkerFieldBytes || len(w.WorkingDir) > 4096 || len(w.PermissionMode) > maxWorkerFieldBytes:
		return "a worker's model, thinking, folder or permission mode is too long"
	case len(w.Skills) > MaxWorkerSkills:
		return "a worker names at most 20 skills"
	}
	if w.PermissionMode != "" && w.PermissionMode != "default" && !strings.HasPrefix(w.PermissionMode, "custom:") {
		return `a worker's permission mode is "default" or a custom mode`
	}
	for i, k := range w.Skills {
		w.Skills[i] = strings.TrimSpace(k)
		if w.Skills[i] == "" || len(w.Skills[i]) > maxWorkerFieldBytes {
			return "a skill id is empty or too long"
		}
	}
	return ""
}

// ListWorkers is the team's approved workers, oldest first.
func (s *Store) ListWorkers(ctx context.Context, boardID string) ([]Worker, error) {
	var rows []struct {
		Setup     string `db:"setup"`
		CreatedAt string `db:"created_at"`
		UpdatedAt string `db:"updated_at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT setup, created_at, updated_at FROM team_workers WHERE board_id = ? ORDER BY created_at, rowid`, boardID); err != nil {
		return nil, err
	}
	out := make([]Worker, 0, len(rows))
	for _, r := range rows {
		var w Worker
		if json.Unmarshal([]byte(r.Setup), &w) != nil {
			continue // a row nothing can read is left out, not a reason to fail the page
		}
		w.CreatedAt, w.UpdatedAt = r.CreatedAt, r.UpdatedAt
		out = append(out, w)
	}
	return out, nil
}

// GetWorker is one worker by name (any case).
func (s *Store) GetWorker(ctx context.Context, boardID, name string) (*Worker, error) {
	var row struct {
		Setup     string `db:"setup"`
		CreatedAt string `db:"created_at"`
		UpdatedAt string `db:"updated_at"`
	}
	err := s.reader().GetContext(ctx, &row, `SELECT setup, created_at, updated_at FROM team_workers WHERE board_id = ? AND name_key = ?`, boardID, WorkerKey(name))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrWorkerNotFound
	}
	if err != nil {
		return nil, err
	}
	var w Worker
	if err := json.Unmarshal([]byte(row.Setup), &w); err != nil {
		return nil, err
	}
	w.CreatedAt, w.UpdatedAt = row.CreatedAt, row.UpdatedAt
	return &w, nil
}

// SaveWorker adds a worker (replace false: a name the team has is ErrWorkerExists) or replaces the one called oldName (replace true; the name may change, to one the team does not have).
func (s *Store) SaveWorker(ctx context.Context, boardID, oldName string, w Worker, replace bool) (*Worker, error) {
	if msg := CleanWorker(&w); msg != "" {
		return nil, errors.New(msg)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	created := now
	if replace {
		err := tx.GetContext(ctx, &created, `SELECT created_at FROM team_workers WHERE board_id = ? AND name_key = ?`, boardID, WorkerKey(oldName))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrWorkerNotFound
		}
		if err != nil {
			return nil, err
		}
		if WorkerKey(oldName) != WorkerKey(w.Name) {
			var n int
			if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM team_workers WHERE board_id = ? AND name_key = ?`, boardID, WorkerKey(w.Name)); err != nil {
				return nil, err
			}
			if n > 0 {
				return nil, ErrWorkerExists
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM team_workers WHERE board_id = ? AND name_key = ?`, boardID, WorkerKey(oldName)); err != nil {
			return nil, err
		}
	} else {
		var n int
		if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM team_workers WHERE board_id = ?`, boardID); err != nil {
			return nil, err
		}
		if n >= MaxWorkersPerTeam {
			return nil, ErrWorkerLimit
		}
		if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM team_workers WHERE board_id = ? AND name_key = ?`, boardID, WorkerKey(w.Name)); err != nil {
			return nil, err
		}
		if n > 0 {
			return nil, ErrWorkerExists
		}
	}
	w.CreatedAt, w.UpdatedAt = "", ""
	setup, err := json.Marshal(w)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO team_workers (board_id, name_key, name, setup, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		boardID, WorkerKey(w.Name), w.Name, string(setup), created, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	w.CreatedAt, w.UpdatedAt = created, now
	return &w, nil
}

// DeleteWorker removes a worker from the team (the agents it launched stay, with their "From" record).
func (s *Store) DeleteWorker(ctx context.Context, boardID, name string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM team_workers WHERE board_id = ? AND name_key = ?`, boardID, WorkerKey(name))
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrWorkerNotFound
	}
	return nil
}

// RecordWorkerLaunch notes that the agent named agent on the team (its member name) was launched from the worker, for the task (0 when none).
func (s *Store) RecordWorkerLaunch(ctx context.Context, boardID, agent, workerName string, taskID int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO worker_launches (board_id, session, worker_name, task_id, launched_at) VALUES (?, ?, ?, ?, ?)`,
		boardID, agent, workerName, taskID, time.Now().UTC().Format(time.RFC3339))
	return err
}

// WorkerLaunches maps the names of the board's agents that a worker launched to the worker's name.
func (s *Store) WorkerLaunches(ctx context.Context, boardID string) (map[string]string, error) {
	var rows []struct {
		Session string `db:"session"`
		Name    string `db:"worker_name"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT session, worker_name FROM worker_launches WHERE board_id = ?`, boardID); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.Session] = r.Name
	}
	return out, nil
}
