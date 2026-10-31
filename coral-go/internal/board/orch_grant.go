package board

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// The Operator's grant to a board's Orchestrator (#11432): a switch, off by default, that lets ONE session, the one the Operator names as the board's orchestrator seat, wake and sleep the agents seated on its own
// board and launch onto it, within caps; and the log of what agents did to the board's agents (launches by any agent, wakes and sleeps by the seat), kept whether the switch is on or off. The grant is written
// only by the Operator (the route checks the verified actor). The seat is a SESSION the Operator picked, not a member whose job title says "orchestrator": a title is chosen by whoever subscribes.

// Defaults and bounds of the grant.
const (
	DefaultOrchMaxPerHour = 10 // launches and wakes per hour on the board
	DefaultOrchMaxLive    = 8  // live agents on the board
	DefaultOrchIdleMin    = 5  // minutes an agent must have been idle before it may be put to sleep
	MaxOrchMaxPerHour     = 100
	MaxOrchMaxLive        = 50
	MaxOrchIdleMin        = 120
)

// Lifecycle kinds in the log.
const (
	LifecycleLaunch = "launch"
	LifecycleWake   = "wake"
	LifecycleSleep  = "sleep"
)

// OrchGrant is a board's grant: off unless Enabled, and then only for SeatSession.
type OrchGrant struct {
	Project     string `json:"project"`
	Enabled     bool   `json:"enabled"`
	SeatSession string `json:"seat_session,omitempty"` // the session id of the orchestrator seat, named by the Operator
	MaxPerHour  int    `json:"max_per_hour"`
	MaxLive     int    `json:"max_live"`
	IdleMin     int    `json:"idle_minutes"`
	SetBy       string `json:"set_by,omitempty"`
	SetAt       string `json:"set_at,omitempty"`
}

// ErrOrchGrantInvalid: a value outside its bounds, or a switch turned on with no seat.
var ErrOrchGrantInvalid = errors.New("the grant is not valid")

func defaultOrchGrant(project string) OrchGrant {
	return OrchGrant{Project: project, MaxPerHour: DefaultOrchMaxPerHour, MaxLive: DefaultOrchMaxLive, IdleMin: DefaultOrchIdleMin}
}

func (s *Store) ensureOrchSchema(ctx context.Context) error {
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS board_orch_grant (
			project      TEXT PRIMARY KEY,
			enabled      INTEGER NOT NULL DEFAULT 0,
			seat_session TEXT NOT NULL DEFAULT '',
			max_per_hour INTEGER NOT NULL,
			max_live     INTEGER NOT NULL,
			idle_min     INTEGER NOT NULL,
			set_by       TEXT NOT NULL DEFAULT '',
			set_at       TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS board_lifecycle_log (
			id      INTEGER PRIMARY KEY AUTOINCREMENT,
			project TEXT NOT NULL,
			kind    TEXT NOT NULL,
			actor   TEXT NOT NULL,
			target  TEXT NOT NULL,
			status  TEXT NOT NULL,
			note    TEXT NOT NULL DEFAULT '',
			at      TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_board_lifecycle_project ON board_lifecycle_log(project, at)`,
		// The manager's private mark on an artifact (#11457): a guide never reads it, whatever board it is on. Keyed by the artifact's digest alone: the mark follows the content.
		`CREATE TABLE IF NOT EXISTS artifact_private (
			artifact_id TEXT PRIMARY KEY,
			set_by      TEXT NOT NULL DEFAULT '',
			set_at      TEXT NOT NULL DEFAULT ''
		)`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// GetOrchGrant is the board's grant; a board that has none has the switch off with the default caps.
func (s *Store) GetOrchGrant(ctx context.Context, project string) (OrchGrant, error) {
	g := defaultOrchGrant(project)
	var row struct {
		Enabled     int    `db:"enabled"`
		SeatSession string `db:"seat_session"`
		MaxPerHour  int    `db:"max_per_hour"`
		MaxLive     int    `db:"max_live"`
		IdleMin     int    `db:"idle_min"`
		SetBy       string `db:"set_by"`
		SetAt       string `db:"set_at"`
	}
	err := s.reader().GetContext(ctx, &row, `SELECT enabled, seat_session, max_per_hour, max_live, idle_min, set_by, set_at FROM board_orch_grant WHERE project = ?`, project)
	if errors.Is(err, sql.ErrNoRows) {
		return g, nil
	}
	if err != nil {
		return g, err
	}
	g.Enabled, g.SeatSession, g.MaxPerHour, g.MaxLive, g.IdleMin, g.SetBy, g.SetAt = row.Enabled != 0, row.SeatSession, row.MaxPerHour, row.MaxLive, row.IdleMin, row.SetBy, row.SetAt
	return g, nil
}

// SetOrchGrant writes the grant. The caller (the route) has decided the writer is the verified Operator; by is who is recorded. Turning it on needs a seat; values outside their bounds are refused.
func (s *Store) SetOrchGrant(ctx context.Context, g OrchGrant, by string) error {
	g.SeatSession = strings.TrimSpace(g.SeatSession)
	if g.MaxPerHour < 1 || g.MaxPerHour > MaxOrchMaxPerHour || g.MaxLive < 1 || g.MaxLive > MaxOrchMaxLive || g.IdleMin < 1 || g.IdleMin > MaxOrchIdleMin {
		return fmt.Errorf("%w: caps out of range", ErrOrchGrantInvalid)
	}
	if g.Enabled && g.SeatSession == "" {
		return fmt.Errorf("%w: a seat is required to turn it on", ErrOrchGrantInvalid)
	}
	enabled := 0
	if g.Enabled {
		enabled = 1
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO board_orch_grant (project, enabled, seat_session, max_per_hour, max_live, idle_min, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(project) DO UPDATE SET enabled = excluded.enabled, seat_session = excluded.seat_session, max_per_hour = excluded.max_per_hour, max_live = excluded.max_live, idle_min = excluded.idle_min, set_by = excluded.set_by, set_at = excluded.set_at`,
		g.Project, enabled, g.SeatSession, g.MaxPerHour, g.MaxLive, g.IdleMin, by, nowUTC())
	return err
}

// LifecycleEntry is one row of the log.
type LifecycleEntry struct {
	ID      int64  `db:"id" json:"id"`
	Project string `db:"project" json:"project"`
	Kind    string `db:"kind" json:"kind"`
	Actor   string `db:"actor" json:"actor"`
	Target  string `db:"target" json:"target"`
	Status  string `db:"status" json:"status"` // reserved (in flight), ok, failed
	Note    string `db:"note" json:"note,omitempty"`
	At      string `db:"at" json:"at"`
}

// The caps a reservation is checked against.
var (
	ErrLifecycleCapHour = errors.New("the hourly limit of launches and wakes on this board is used up")
	ErrLifecycleCapLive = errors.New("the limit of live agents on this board is reached")
)

// LifecycleCaps are what a reservation must stay within: launches and wakes in the last hour, and the live agents of the board (Live is read by the caller just before; reservations still in flight count too).
type LifecycleCaps struct {
	MaxPerHour int
	MaxLive    int
	Live       int
}

// inFlightFor is how long a reservation that was never finished counts as an agent about to be live.
const inFlightFor = 2 * time.Minute

// ReserveLifecycle writes a log row for an action about to be taken and, when caps is not nil, only if the caps allow it: the check and the write are ONE statement, so two requests at once cannot both pass the same
// cap. A launch or a wake counts toward both; a refused one writes nothing and says which cap (ErrLifecycleCapHour, ErrLifecycleCapLive). The row is 'reserved' until FinishLifecycle says how it went. Names are cleaned
// and cut by the caller; the log keeps what it is given.
func (s *Store) ReserveLifecycle(ctx context.Context, project, kind, actor, target string, caps *LifecycleCaps) (int64, error) {
	now := time.Now().UTC()
	if caps == nil {
		res, err := s.db.ExecContext(ctx, `INSERT INTO board_lifecycle_log (project, kind, actor, target, status, at) VALUES (?, ?, ?, ?, 'reserved', ?)`, project, kind, actor, target, now.Format(time.RFC3339))
		if err != nil {
			return 0, err
		}
		return res.LastInsertId()
	}
	hourAgo := now.Add(-time.Hour).Format(time.RFC3339)
	flightAgo := now.Add(-inFlightFor).Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `INSERT INTO board_lifecycle_log (project, kind, actor, target, status, at)
		SELECT ?, ?, ?, ?, 'reserved', ?
		WHERE (SELECT COUNT(*) FROM board_lifecycle_log WHERE project = ? AND kind IN ('launch', 'wake') AND status != 'failed' AND at > ?) < ?
		  AND ? + (SELECT COUNT(*) FROM board_lifecycle_log WHERE project = ? AND kind IN ('launch', 'wake') AND status = 'reserved' AND at > ?) < ?`,
		project, kind, actor, target, now.Format(time.RFC3339),
		project, hourAgo, caps.MaxPerHour,
		caps.Live, project, flightAgo, caps.MaxLive)
	if err != nil {
		return 0, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var inHour int
		_ = s.reader().GetContext(ctx, &inHour, `SELECT COUNT(*) FROM board_lifecycle_log WHERE project = ? AND kind IN ('launch', 'wake') AND status != 'failed' AND at > ?`, project, hourAgo)
		if inHour >= caps.MaxPerHour {
			return 0, ErrLifecycleCapHour
		}
		return 0, ErrLifecycleCapLive
	}
	return res.LastInsertId()
}

// FinishLifecycle records how a reserved action went: "ok" or "failed" (a failed one stops counting against the hourly cap), with a short note.
func (s *Store) FinishLifecycle(ctx context.Context, id int64, status, note string) error {
	if status != "ok" && status != "failed" {
		status = "failed"
	}
	if r := []rune(note); len(r) > 200 {
		note = string(r[:200])
	}
	_, err := s.db.ExecContext(ctx, `UPDATE board_lifecycle_log SET status = ?, note = ? WHERE id = ?`, status, note, id)
	return err
}

// LifecycleLog is the newest rows of a board's log, newest first.
func (s *Store) LifecycleLog(ctx context.Context, project string, limit int) ([]LifecycleEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var rows []LifecycleEntry
	err := s.reader().SelectContext(ctx, &rows, `SELECT id, project, kind, actor, target, status, note, at FROM board_lifecycle_log WHERE project = ? ORDER BY id DESC LIMIT ?`, project, limit)
	return rows, err
}
