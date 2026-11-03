package board

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// The kind of a file for review (#12144, "choose what reaches Needs you"): file (the default, which an agent can never quiet), done, release, decided or digest. It is a field of the review kept in its own small
// table, keyed like the question's, and not a tag: a typed word cannot become a kind and tagging afterwards cannot change it. A non-default kind is set only by the server after it has checked a fact for it
// (the routes decide which); the table only holds the answer. A file with no row is a file.

// The kinds. KindFile is the default and has no row.
const (
	KindFile    = "file"
	KindDone    = "done"
	KindRelease = "release"
	KindDecided = "decided"
	KindDigest  = "digest"
)

// ArtifactKinds is the closed list the server checks.
var ArtifactKinds = []string{KindFile, KindDone, KindRelease, KindDecided, KindDigest}

// ValidArtifactKind reports whether k is one of the closed list.
func ValidArtifactKind(k string) bool {
	for _, x := range ArtifactKinds {
		if x == k {
			return true
		}
	}
	return false
}

func (s *Store) ensureArtifactKindsSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS artifact_kinds (
		board_id   TEXT NOT NULL,
		hex        TEXT NOT NULL,
		kind       TEXT NOT NULL,
		session_id TEXT NOT NULL,
		set_at     TEXT NOT NULL,
		PRIMARY KEY (board_id, hex)
	)`)
	return err
}

// SetArtifactKind records the kind of the object on the board; KindFile (or "") records nothing and clears none: a file stays what it was. The row is written once: a kind already there is never replaced, so
// the same bytes uploaded again cannot change it. It reports the kind the object has afterwards.
func (s *Store) SetArtifactKind(ctx context.Context, boardID, hex, kind, session string, at time.Time) (string, error) {
	if kind != "" && kind != KindFile {
		if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO artifact_kinds (board_id, hex, kind, session_id, set_at) VALUES (?, ?, ?, ?, ?)`,
			boardID, hex, kind, session, at.UTC().Format(time.RFC3339)); err != nil {
			return "", err
		}
	}
	return s.ArtifactKind(ctx, boardID, hex)
}

// ArtifactKind is the kind of one object on a board: KindFile when none is recorded.
func (s *Store) ArtifactKind(ctx context.Context, boardID, hex string) (string, error) {
	var k string
	err := s.reader().GetContext(ctx, &k, `SELECT kind FROM artifact_kinds WHERE board_id = ? AND hex = ?`, boardID, hex)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return KindFile, nil
		}
		return "", err
	}
	return k, nil
}

// ArtifactKindsOf maps each object of the board that has a non-default kind to it.
func (s *Store) ArtifactKindsOf(ctx context.Context, boardID string) (map[string]string, error) {
	var rows []struct {
		Hex  string `db:"hex"`
		Kind string `db:"kind"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT hex, kind FROM artifact_kinds WHERE board_id = ?`, boardID); err != nil {
		return nil, err
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		out[r.Hex] = r.Kind
	}
	return out, nil
}
