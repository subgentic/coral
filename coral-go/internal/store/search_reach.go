package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Search reach levels (#11048), lowest first.
const (
	SearchReachOwn      = "own"
	SearchReachTeam     = "team"
	SearchReachAll      = "all"
	SearchReachOperator = "operator"
)

// The access log keeps 90 days or 10,000 rows, whichever is less.
const (
	SearchAccessMaxRows = 10000
	SearchAccessMaxAge  = 90 * 24 * time.Hour
)

var ErrInvalidSearchReach = errors.New("search reach must be own, team, all or operator")

// SearchReachRank orders the levels; -1 is not a level.
func SearchReachRank(level string) int {
	switch level {
	case SearchReachOwn:
		return 0
	case SearchReachTeam:
		return 1
	case SearchReachAll:
		return 2
	case SearchReachOperator:
		return 3
	}
	return -1
}

// SearchAccessRow is one row of the access log. It never carries a query or a result.
type SearchAccessRow struct {
	ID        int64  `db:"id" json:"id"`
	Kind      string `db:"kind" json:"kind"`
	Team      string `db:"team" json:"team"`
	Agent     string `db:"agent" json:"agent"`
	FromLevel string `db:"from_level" json:"from_level"`
	ToLevel   string `db:"to_level" json:"to_level"`
	SetBy     string `db:"set_by" json:"set_by"`
	Via       string `db:"via" json:"via"`
	Outcome   string `db:"outcome" json:"outcome"`
	Results   int    `db:"results" json:"results"`
	At        string `db:"at" json:"at"`
}

// SearchReachForSession is the level of the member row the session is on; own when there is none.
func (s *TeamStore) SearchReachForSession(ctx context.Context, sessionID string) (string, error) {
	if sessionID == "" {
		return SearchReachOwn, nil
	}
	var level string
	err := s.db.GetContext(ctx, &level,
		`SELECT search_reach FROM team_members WHERE session_id = ? ORDER BY id DESC LIMIT 1`, sessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return SearchReachOwn, nil
	}
	if err != nil {
		return "", err
	}
	if SearchReachRank(level) < 0 {
		return SearchReachOwn, nil
	}
	return level, nil
}

// SetSearchReach sets the level of a team's member and logs the change in the same transaction. It returns the level it replaced.
func (s *TeamStore) SetSearchReach(ctx context.Context, team, agent, level, setBy, via string) (string, error) {
	if SearchReachRank(level) < 0 {
		return "", ErrInvalidSearchReach
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var id int64
	var from string
	err = tx.QueryRowxContext(ctx,
		`SELECT m.id, m.search_reach FROM team_members m JOIN teams t ON t.id = m.team_id
		 WHERE t.name = ? AND m.agent_name = ? ORDER BY m.id DESC LIMIT 1`, team, agent).Scan(&id, &from)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("no member %q on %q: %w", agent, team, sql.ErrNoRows)
	}
	if err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE team_members SET search_reach = ? WHERE id = ?`, level, id); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO search_access_log (kind, team, agent, from_level, to_level, set_by, via, at) VALUES ('raise', ?, ?, ?, ?, ?, ?, ?)`,
		team, agent, from, level, setBy, via, NowUTC()); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return from, nil
}

// ResetSearchReach puts every member of a team back to own (a clone or an import starts there).
func (s *TeamStore) ResetSearchReach(ctx context.Context, teamID int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE team_members SET search_reach = 'own' WHERE team_id = ?`, teamID)
	return err
}

// LogSearchRead records a search above own: who, at what level, the outcome and a count. No text.
func (s *TeamStore) LogSearchRead(ctx context.Context, team, agent, level, outcome string, results int) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO search_access_log (kind, team, agent, to_level, outcome, results, at) VALUES ('read', ?, ?, ?, ?, ?, ?)`,
		team, agent, level, outcome, results, NowUTC())
	return err
}

// ListSearchAccess returns the newest rows first.
func (s *TeamStore) ListSearchAccess(ctx context.Context, limit int) ([]SearchAccessRow, error) {
	var rows []SearchAccessRow
	err := s.db.SelectContext(ctx, &rows,
		`SELECT id, kind, team, agent, from_level, to_level, set_by, via, outcome, results, at
		 FROM search_access_log ORDER BY id DESC LIMIT ?`, limit)
	return rows, err
}

// PruneSearchAccess drops rows older than 90 days, then all but the newest 10,000.
func (s *TeamStore) PruneSearchAccess(ctx context.Context) error {
	cutoff := time.Now().UTC().Add(-SearchAccessMaxAge).Format(ISOFormat)
	if _, err := s.db.ExecContext(ctx, `DELETE FROM search_access_log WHERE at < ?`, cutoff); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM search_access_log WHERE id NOT IN (SELECT id FROM search_access_log ORDER BY id DESC LIMIT ?)`, SearchAccessMaxRows)
	return err
}
