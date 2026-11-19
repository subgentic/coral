package board

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// AnsweredAsk is a question put to a member that the member answered and whose asker has done nothing on the board since (#19916): the Inbox's "Waiting on an agent" tab lists it.
type AnsweredAsk struct {
	MessageID  int64 // the question
	Asker      string
	Question   string
	AnswerID   int64 // the member's newest reply to it (reply_to)
	Answer     string
	AnsweredAt time.Time
}

// AnsweredAsksOf are the questions of the board asked less than askMaxAge ago that member answered with a reply (reply_to) and whose asker has posted nothing since the answer, oldest answer first. A question closed by hand
// is not listed, and neither is one whose asker posted anything on the board after the answer (the agent acted); a question the Operator reopened counts from the reopening. Reads only; nothing is kept up to date by a job.
func (s *Store) AnsweredAsksOf(ctx context.Context, project, member string, now time.Time) ([]AnsweredAsk, error) {
	var asks []askRow
	if err := s.reader().SelectContext(ctx, &asks, `SELECT message_id, asker, asked, created_at FROM board_asks WHERE project = ? AND created_at > ? ORDER BY message_id`, project, now.Add(-askMaxAge).UTC().Format(time.RFC3339)); err != nil {
		return nil, err
	}
	var out []AnsweredAsk
	for _, a := range asks {
		var to []string
		_ = json.Unmarshal([]byte(a.Asked), &to)
		named := false
		for _, m := range to {
			named = named || strings.EqualFold(m, member)
		}
		if !named || strings.EqualFold(a.Asker, member) {
			continue
		}
		var closed bool
		if err := s.reader().GetContext(ctx, &closed, `SELECT EXISTS(SELECT 1 FROM board_ask_closed WHERE project = ? AND message_id = ?)`, project, a.MessageID); err != nil {
			return nil, err
		}
		if closed {
			continue
		}
		var floor int64
		_ = s.reader().GetContext(ctx, &floor, `SELECT after_id FROM board_ask_reopened WHERE project = ? AND message_id = ?`, project, a.MessageID)
		var reply struct {
			ID        int64  `db:"id"`
			Content   string `db:"content"`
			CreatedAt string `db:"created_at"`
		}
		if err := s.reader().GetContext(ctx, &reply, `SELECT m.id AS id, m.content AS content, m.created_at AS created_at FROM board_messages m JOIN board_replies r ON r.message_id = m.id
			WHERE m.project = ? AND r.reply_to = ? AND m.id > ? AND lower(m.subscriber_id) = lower(?) AND COALESCE(m.is_system, 0) = 0 ORDER BY m.id DESC LIMIT 1`, project, a.MessageID, floor, member); err != nil {
			continue // not answered (no row)
		}
		var acted bool
		if err := s.reader().GetContext(ctx, &acted, `SELECT EXISTS(SELECT 1 FROM board_messages WHERE project = ? AND id > ? AND lower(subscriber_id) = lower(?) AND COALESCE(is_system, 0) = 0)`, project, reply.ID, a.Asker); err != nil {
			return nil, err
		}
		if acted {
			continue
		}
		var question string
		_ = s.reader().GetContext(ctx, &question, `SELECT content FROM board_messages WHERE project = ? AND id = ?`, project, a.MessageID)
		at, _ := time.Parse(time.RFC3339Nano, reply.CreatedAt)
		out = append(out, AnsweredAsk{MessageID: a.MessageID, Asker: a.Asker, Question: question, AnswerID: reply.ID, Answer: reply.Content, AnsweredAt: at})
	}
	return out, nil
}
