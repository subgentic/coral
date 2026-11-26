package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"
)

// An automation's run token (#21502): minted for one run of a workflow whose board is set, so its shell steps may post to that board as "Automation: NAME". It is bound to the run, the workflow and
// the board, never outlives the run (expires_at, and it is revoked when the run ends), and only a SHA-256 is stored. It is a third kind of token, neither an agent's session token nor a check's.

// AutomationTokenHeader carries it; AutomationTokenEnv and AutomationBoardEnv are what a step's coral-board reads.
const (
	AutomationTokenHeader = "X-Coral-Automation-Token"
	AutomationTokenEnv    = "CORAL_AUTOMATION_TOKEN"
	AutomationBoardEnv    = "CORAL_AUTOMATION_BOARD"
	automationTokenPrefix = "au1."
)

// ErrUnknownAutomationToken is a token Coral never minted, one that ended with its run, or one that was revoked.
var ErrUnknownAutomationToken = errors.New("unknown, expired or revoked automation token")

// The limits of an automation's posts: per run, and per workflow per hour.
const (
	AutomationWritesPerRun  = 20
	AutomationWritesPerHour = 60
)

// AutomationTokenSpec is the run a token is for and for how long.
type AutomationTokenSpec struct {
	RunID, WorkflowID int64
	WorkflowName      string
	Project           string
	TTL               time.Duration
}

// AutomationTokenOwner is what a live automation token stands for.
type AutomationTokenOwner struct {
	RunID        int64  `db:"run_id"`
	WorkflowID   int64  `db:"workflow_id"`
	WorkflowName string `db:"workflow_name"`
	Project      string `db:"project"`
}

// MintAutomationToken returns a new token for one run.
func (db *DB) MintAutomationToken(ctx context.Context, sp AutomationTokenSpec, now time.Time) (string, error) {
	if sp.TTL <= 0 || sp.RunID <= 0 || sp.WorkflowID <= 0 || sp.WorkflowName == "" || sp.Project == "" {
		return "", errors.New("an automation token needs a run, a workflow, a board and a lifetime")
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := automationTokenPrefix + base64.RawURLEncoding.EncodeToString(b)
	_, err := db.ExecContext(ctx, `INSERT INTO automation_tokens (token_hash, run_id, workflow_id, workflow_name, project, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		hashSessionToken(token), sp.RunID, sp.WorkflowID, sp.WorkflowName, sp.Project, now.Unix(), now.Add(sp.TTL).Unix())
	return token, err
}

// AutomationTokenOf is who a live automation token stands for. It is read every time, never cached: a revoked token is refused at once.
func (db *DB) AutomationTokenOf(ctx context.Context, token string, now time.Time) (*AutomationTokenOwner, error) {
	var o AutomationTokenOwner
	err := db.GetContext(ctx, &o, `SELECT run_id, workflow_id, workflow_name, project FROM automation_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`, hashSessionToken(token), now.Unix())
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownAutomationToken
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

// RevokeAutomationToken ends one run's token.
func (db *DB) RevokeAutomationToken(ctx context.Context, token string, now time.Time) error {
	_, err := db.ExecContext(ctx, `UPDATE automation_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`, now.Unix(), hashSessionToken(token))
	return err
}

// RevokeAutomationTokensForWorkflow ends every live token of a workflow (it is deleted, disabled, or its board changed).
func (db *DB) RevokeAutomationTokensForWorkflow(ctx context.Context, workflowID int64, now time.Time) error {
	_, err := db.ExecContext(ctx, `UPDATE automation_tokens SET revoked_at = ? WHERE workflow_id = ? AND revoked_at IS NULL`, now.Unix(), workflowID)
	return err
}

// RevokeAllAutomationTokens ends every live automation token: Coral's start and exit.
func (db *DB) RevokeAllAutomationTokens(ctx context.Context, now time.Time) error {
	_, err := db.ExecContext(ctx, `UPDATE automation_tokens SET revoked_at = ? WHERE revoked_at IS NULL`, now.Unix())
	return err
}

// TakeAutomationWrite counts one post of a run: at most AutomationWritesPerRun in a run and AutomationWritesPerHour for the workflow in an hour. false means over a limit (nothing is counted).
func (db *DB) TakeAutomationWrite(ctx context.Context, token string, now time.Time) (bool, error) {
	tx, err := db.BeginTxx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var o struct {
		WorkflowID int64 `db:"workflow_id"`
		Writes     int   `db:"writes"`
	}
	if err := tx.GetContext(ctx, &o, `SELECT workflow_id, writes FROM automation_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`, hashSessionToken(token), now.Unix()); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if o.Writes >= AutomationWritesPerRun {
		return false, nil
	}
	var n int
	if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM automation_writes WHERE workflow_id = ? AND at > ?`, o.WorkflowID, now.Add(-time.Hour).Unix()); err != nil {
		return false, err
	}
	if n >= AutomationWritesPerHour {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE automation_tokens SET writes = writes + 1 WHERE token_hash = ?`, hashSessionToken(token)); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO automation_writes (workflow_id, at) VALUES (?, ?)`, o.WorkflowID, now.Unix()); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM automation_writes WHERE at < ?`, now.Add(-24*time.Hour).Unix()); err != nil {
		return false, err
	}
	return true, tx.Commit()
}
