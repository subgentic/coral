package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"
)

// A custom health check's run token (#20138, design v2 section 4): minted for one run, for the member who added the check (its identity on the board), read-only unless the approved record says it may
// write, and never longer than the run (expires_at). Only a SHA-256 is stored. It is a second kind of token, not a session token: minting one does not touch the member's own.

// CheckTokenHeader carries it; CheckTokenEnv is the variable a script's CLI reads it from.
const (
	CheckTokenHeader = "X-Coral-Check-Token"
	CheckTokenEnv    = "CORAL_CHECK_TOKEN"
	checkTokenPrefix = "ck1."
)

// ErrUnknownCheckToken is a token Coral never minted, one that ended with its run, or one that was revoked.
var ErrUnknownCheckToken = errors.New("unknown, expired or revoked check token")

// The limits of what a check's writes may do (Security on #20135): per run, and per check per hour.
const (
	CheckWritesPerRun  = 5
	CheckWritesPerHour = 6
)

// CheckTokenSpec is whom a run's token acts as and for how long.
type CheckTokenSpec struct {
	SessionID, SessionName string // the member the check was added by
	Project, Check         string
	MayWrite               bool
	TTL                    time.Duration
}

// CheckTokenOwner is what a live check token stands for.
type CheckTokenOwner struct {
	SessionID   string `db:"session_id"`
	SessionName string `db:"session_name"`
	Project     string `db:"project"`
	Check       string `db:"check_name"`
	MayWrite    bool   `db:"may_write"`
}

// MintCheckToken returns a new token for one run.
func (db *DB) MintCheckToken(ctx context.Context, sp CheckTokenSpec, now time.Time) (string, error) {
	if sp.TTL <= 0 || sp.SessionName == "" || sp.Project == "" || sp.Check == "" {
		return "", errors.New("a check token needs a member, a check and a lifetime")
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := checkTokenPrefix + base64.RawURLEncoding.EncodeToString(b)
	_, err := db.ExecContext(ctx, `INSERT INTO check_tokens (token_hash, session_id, session_name, project, check_name, may_write, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		hashSessionToken(token), sp.SessionID, sp.SessionName, sp.Project, sp.Check, sp.MayWrite, now.Unix(), now.Add(sp.TTL).Unix())
	return token, err
}

// CheckTokenOf is who a live check token stands for. It is read every time, never cached: a revoked token is refused at once.
func (db *DB) CheckTokenOf(ctx context.Context, token string, now time.Time) (*CheckTokenOwner, error) {
	var o CheckTokenOwner
	err := db.GetContext(ctx, &o, `SELECT session_id, session_name, project, check_name, may_write FROM check_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`, hashSessionToken(token), now.Unix())
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownCheckToken
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

// RevokeCheckToken ends one run's token.
func (db *DB) RevokeCheckToken(ctx context.Context, token string, now time.Time) error {
	_, err := db.ExecContext(ctx, `UPDATE check_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`, now.Unix(), hashSessionToken(token))
	return err
}

// RevokeCheckTokensFor ends every live token of a check: its pause, update, removal, or a check whose member is archived.
func (db *DB) RevokeCheckTokensFor(ctx context.Context, project, check string, now time.Time) error {
	_, err := db.ExecContext(ctx, `UPDATE check_tokens SET revoked_at = ? WHERE project = ? AND check_name = ? AND revoked_at IS NULL`, now.Unix(), project, check)
	return err
}

// RevokeAllCheckTokens ends every live check token: Coral's start and exit.
func (db *DB) RevokeAllCheckTokens(ctx context.Context, now time.Time) error {
	_, err := db.ExecContext(ctx, `UPDATE check_tokens SET revoked_at = ? WHERE revoked_at IS NULL`, now.Unix())
	return err
}

// TakeCheckWrite counts one write of a run (a post, a task, a comment): at most CheckWritesPerRun in a run and CheckWritesPerHour for the check in an hour. false means over a limit (nothing is counted).
func (db *DB) TakeCheckWrite(ctx context.Context, token string, now time.Time) (bool, error) {
	tx, err := db.BeginTxx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var o struct {
		Project string `db:"project"`
		Check   string `db:"check_name"`
		Writes  int    `db:"writes"`
	}
	if err := tx.GetContext(ctx, &o, `SELECT project, check_name, writes FROM check_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`, hashSessionToken(token), now.Unix()); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if o.Writes >= CheckWritesPerRun {
		return false, nil
	}
	var n int
	if err := tx.GetContext(ctx, &n, `SELECT COUNT(*) FROM check_token_writes WHERE project = ? AND check_name = ? AND at > ?`, o.Project, o.Check, now.Add(-time.Hour).Unix()); err != nil {
		return false, err
	}
	if n >= CheckWritesPerHour {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE check_tokens SET writes = writes + 1 WHERE token_hash = ?`, hashSessionToken(token)); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO check_token_writes (project, check_name, at) VALUES (?, ?, ?)`, o.Project, o.Check, now.Unix()); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM check_token_writes WHERE at < ?`, now.Add(-24*time.Hour).Unix()); err != nil {
		return false, err
	}
	return true, tx.Commit()
}
