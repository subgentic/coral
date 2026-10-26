package board

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"
)

// Artifact tags (#8583, Goal #61): short lowercase words a team puts on its artifacts to find the ones that matter ("for review", "internal"). A tag belongs to a team's use of a stored object (board,
// object id), so another team that holds the same bytes has its own. Letters, digits, spaces and hyphens, 1 to 24 characters, at most 5 on an artifact; normalised on save.

const (
	MaxArtifactTags   = 5
	MaxArtifactTagLen = 24
)

// StarterArtifactTags are the four tags the UI offers first.
var StarterArtifactTags = []string{"for review", "internal", "final", "draft"}

// ErrArtifactTag is a tag (or a set of them) that is refused.
var ErrArtifactTag = errors.New("invalid artifact tag")

// NormalizeArtifactTag is a tag as it is stored: trimmed, lower-cased, runs of spaces made one; ok is false for one that is empty, over MaxArtifactTagLen characters, or holds anything but
// letters, digits, spaces and hyphens.
func NormalizeArtifactTag(s string) (string, bool) {
	s = strings.ToLower(strings.Join(strings.Fields(s), " "))
	n := 0
	for _, r := range s {
		n++
		if !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' || r == '-') {
			return "", false
		}
	}
	if n == 0 || n > MaxArtifactTagLen {
		return "", false
	}
	return s, true
}

// NormalizeArtifactTags is a set of tags as they are stored, or an error naming the first that is refused: each normalised, repeats once, in the order given, at most MaxArtifactTags.
func NormalizeArtifactTags(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, raw := range in {
		tag, ok := NormalizeArtifactTag(raw)
		if !ok {
			return nil, fmt.Errorf("%w: %q (1 to %d letters, digits, spaces or hyphens)", ErrArtifactTag, raw, MaxArtifactTagLen)
		}
		if !seen[tag] {
			seen[tag] = true
			out = append(out, tag)
		}
	}
	if len(out) > MaxArtifactTags {
		return nil, fmt.Errorf("%w: at most %d tags on an artifact", ErrArtifactTag, MaxArtifactTags)
	}
	return out, nil
}

// CleanArtifactTags is NormalizeArtifactTags for tags an agent sent: one that is refused is dropped, and those past MaxArtifactTags are left off, so a tag never stops an upload or a result.
func CleanArtifactTags(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, raw := range in {
		if tag, ok := NormalizeArtifactTag(raw); ok && !seen[tag] && len(out) < MaxArtifactTags {
			seen[tag] = true
			out = append(out, tag)
		}
	}
	return out
}

func (s *Store) ensureArtifactTagsSchema(ctx context.Context) error {
	for _, q := range []string{
		`CREATE TABLE IF NOT EXISTS artifact_tags (
			board_id TEXT NOT NULL,
			hex      TEXT NOT NULL,
			tag      TEXT NOT NULL,
			PRIMARY KEY (board_id, hex, tag)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_artifact_tags_board_tag ON artifact_tags(board_id, tag)`,
	} {
		if _, err := s.db.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}

// ArtifactTags maps each tagged stored object of the board (its 64-hex id) to its tags, sorted.
func (s *Store) ArtifactTags(ctx context.Context, boardID string) (map[string][]string, error) {
	var rows []struct {
		Hex string `db:"hex"`
		Tag string `db:"tag"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT hex, tag FROM artifact_tags WHERE board_id = ? ORDER BY hex, tag`, boardID); err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for _, r := range rows {
		out[r.Hex] = append(out[r.Hex], r.Tag)
	}
	for _, tags := range out {
		sort.Strings(tags)
	}
	return out, nil
}

// SetArtifactTags makes tags (already normalised, at most MaxArtifactTags) the whole set of the object's tags on the board.
func (s *Store) SetArtifactTags(ctx context.Context, boardID, hex string, tags []string) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_tags WHERE board_id = ? AND hex = ?`, boardID, hex); err != nil {
		return err
	}
	for _, tag := range tags {
		if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, tag); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AddArtifactTags adds tags (already cleaned) to the object's tags on the board, up to MaxArtifactTags in all: what is over is left off. It reports the object's tags after.
func (s *Store) AddArtifactTags(ctx context.Context, boardID, hex string, add []string) ([]string, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var have []string
	if err := tx.SelectContext(ctx, &have, `SELECT tag FROM artifact_tags WHERE board_id = ? AND hex = ? ORDER BY tag`, boardID, hex); err != nil {
		return nil, err
	}
	set := map[string]bool{}
	for _, t := range have {
		set[t] = true
	}
	for _, tag := range add {
		if len(have) >= MaxArtifactTags {
			break
		}
		if !set[tag] {
			set[tag] = true
			have = append(have, tag)
			if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_tags (board_id, hex, tag) VALUES (?, ?, ?)`, boardID, hex, tag); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	sort.Strings(have)
	return have, nil
}
