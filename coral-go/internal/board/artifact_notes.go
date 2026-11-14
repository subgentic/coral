package board

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/clitext"
)

// The note of an upload (#17119, #16824 part 2): the one line an agent says about what THIS version changed ("added a Copy all button"), shown under the version in the version list. It belongs to the
// bytes of the version (its 64-hex id), is set by the session that uploaded them, and is text: every reader sets it with textContent.

// MaxArtifactNoteRunes is the longest note kept; a longer one is cut here, on the server.
const MaxArtifactNoteRunes = 140

// CleanArtifactNote is a note as it is stored and shown: one line (control, format, bidi and invisible characters out, whitespace folded: clitext.CleanName), cut at MaxArtifactNoteRunes. ok is false for one
// that is empty once cleaned.
func CleanArtifactNote(s string) (note string, ok bool) {
	note = clitext.CleanName(s)
	if utf8.RuneCountInString(note) > MaxArtifactNoteRunes {
		note = strings.TrimSpace(string([]rune(note)[:MaxArtifactNoteRunes]))
	}
	return note, note != ""
}

func (s *Store) ensureArtifactNotesSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS artifact_notes (
		hex        TEXT NOT NULL PRIMARY KEY,
		note       TEXT NOT NULL,
		session_id TEXT NOT NULL,
		noted_at   TEXT NOT NULL
	)`)
	return err
}

// SetArtifactNote records note (already cleaned) for the version with this digest, written by session. A note already there from ANOTHER session is left as it is: only the agent that uploaded the bytes
// says what they changed.
func (s *Store) SetArtifactNote(ctx context.Context, hex, note, session string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO artifact_notes (hex, note, session_id, noted_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(hex) DO UPDATE SET note = excluded.note, noted_at = excluded.noted_at WHERE artifact_notes.session_id = excluded.session_id`,
		hex, note, session, at.UTC().Format(time.RFC3339))
	return err
}

// ArtifactNotes maps each of the digests that has a note to it.
func (s *Store) ArtifactNotes(ctx context.Context, digests []string) (map[string]string, error) {
	out := make(map[string]string, len(digests))
	for _, d := range digests {
		var n string
		if err := s.reader().GetContext(ctx, &n, `SELECT note FROM artifact_notes WHERE hex = ?`, d); err == nil && n != "" {
			out[d] = n
		}
	}
	return out, nil
}
