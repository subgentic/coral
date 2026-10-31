package board

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/clitext"
)

// The question of a "for review" artifact (#11555): the one line an agent says it needs the Operator to decide, so a review row says what is being asked. It is the UPLOAD's own: kept apart from the
// tags (a person editing a file's tags never drops it, and another agent tagging the same bytes never changes it) and set only by the session that uploaded it.

// MaxReviewQuestionRunes is the longest question kept; a longer one is cut here, on the server.
const MaxReviewQuestionRunes = 140

// CleanReviewQuestion is a question as it is stored and shown: one line (control, format, bidi and invisible characters out, whitespace folded: clitext.CleanName), cut at MaxReviewQuestionRunes.
// ok is false for one that is empty once cleaned.
func CleanReviewQuestion(s string) (q string, ok bool) {
	q = clitext.CleanName(s)
	if utf8.RuneCountInString(q) > MaxReviewQuestionRunes {
		q = strings.TrimSpace(string([]rune(q)[:MaxReviewQuestionRunes]))
	}
	return q, q != ""
}

// ArtifactQuestion is the stored question of one object on a board and the session that asked it.
type ArtifactQuestion struct {
	Question string `db:"question" json:"question"`
	Session  string `db:"session_id" json:"-"`
	At       string `db:"asked_at" json:"asked_at"`
}

func (s *Store) ensureArtifactQuestionsSchema(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS artifact_questions (
		board_id   TEXT NOT NULL,
		hex        TEXT NOT NULL,
		question   TEXT NOT NULL,
		session_id TEXT NOT NULL,
		asked_at   TEXT NOT NULL,
		PRIMARY KEY (board_id, hex)
	)`)
	return err
}

// SetArtifactQuestion records question (already cleaned) for the object on the board, asked by session. A question already there from ANOTHER session is left as it is: only the agent that uploaded
// the file changes what it asks. It reports whether the stored question is this one.
func (s *Store) SetArtifactQuestion(ctx context.Context, boardID, hex, question, session string, at time.Time) (bool, error) {
	if _, err := s.db.ExecContext(ctx, `INSERT INTO artifact_questions (board_id, hex, question, session_id, asked_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(board_id, hex) DO UPDATE SET question = excluded.question, asked_at = excluded.asked_at WHERE artifact_questions.session_id = excluded.session_id`,
		boardID, hex, question, session, at.UTC().Format(time.RFC3339)); err != nil {
		return false, err
	}
	var got string
	if err := s.db.GetContext(ctx, &got, `SELECT question FROM artifact_questions WHERE board_id = ? AND hex = ?`, boardID, hex); err != nil {
		return false, err
	}
	return got == question, nil
}

// ArtifactQuestions maps each object of the board that has a question (its 64-hex id) to it.
func (s *Store) ArtifactQuestions(ctx context.Context, boardID string) (map[string]ArtifactQuestion, error) {
	var rows []struct {
		Hex string `db:"hex"`
		ArtifactQuestion
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT hex, question, session_id, asked_at FROM artifact_questions WHERE board_id = ?`, boardID); err != nil {
		return nil, err
	}
	out := make(map[string]ArtifactQuestion, len(rows))
	for _, r := range rows {
		out[r.Hex] = r.ArtifactQuestion
	}
	return out, nil
}
