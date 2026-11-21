package board

import (
	"context"
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

// AnsweredAsksOf are the questions of the board asked less than askMaxAge ago that member answered with a reply (reply_to) and whose asker has posted nothing since the answer, oldest answer first, at most limit
// (#19923: the cap is applied in the query, so a board with thousands of old questions reads no more than limit rows and the cost does not grow with the questions). A question closed by hand is not listed, and neither is one whose
// asker posted anything on the board after the answer (the agent acted), or whose linked task finished; a question the Operator reopened counts from the reopening. Two queries per board, whatever the number of questions.
func (s *Store) AnsweredAsksOf(ctx context.Context, project, member string, now time.Time, limit int) ([]AnsweredAsk, error) {
	if limit < 1 {
		return nil, nil
	}
	var rows []struct {
		MessageID int64  `db:"message_id"`
		Asker     string `db:"asker"`
		ReplyID   int64  `db:"reply_id"`
		Answer    string `db:"answer"`
		At        string `db:"answered_at"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `
		SELECT a.message_id AS message_id, a.asker AS asker, m.id AS reply_id, m.content AS answer, m.created_at AS answered_at
		FROM board_asks a
		JOIN board_replies r ON r.project = a.project AND r.reply_to = a.message_id
		JOIN board_messages m ON m.project = r.project AND m.id = r.message_id
		WHERE a.project = ? AND a.created_at > ?
		  AND lower(m.subscriber_id) = lower(?) AND COALESCE(m.is_system, 0) = 0 AND COALESCE(m.no_answer, 0) = 0
		  AND lower(a.asker) != lower(?)
		  AND EXISTS (SELECT 1 FROM json_each(a.asked) j WHERE lower(j.value) = lower(?))
		  AND NOT EXISTS (SELECT 1 FROM board_ask_closed c WHERE c.project = a.project AND c.message_id = a.message_id)
          AND NOT EXISTS (SELECT 1 FROM board_ask_subjects sj JOIN board_tasks t ON t.board_id = sj.project AND t.id = sj.task_id
                          WHERE sj.project = a.project AND sj.message_id = a.message_id AND t.status IN ('completed','skipped','cancelled'))
		  AND m.id > COALESCE((SELECT o.after_id FROM board_ask_reopened o WHERE o.project = a.project AND o.message_id = a.message_id), 0)
		  AND m.id = (SELECT MAX(m2.id) FROM board_replies r2 JOIN board_messages m2 ON m2.project = r2.project AND m2.id = r2.message_id
		              WHERE r2.project = a.project AND r2.reply_to = a.message_id AND lower(m2.subscriber_id) = lower(?) AND COALESCE(m2.is_system, 0) = 0)
		  AND NOT EXISTS (SELECT 1 FROM board_messages x WHERE x.project = a.project AND x.id > m.id AND lower(x.subscriber_id) = lower(a.asker) AND COALESCE(x.is_system, 0) = 0)
		ORDER BY m.id LIMIT ?`,
		project, now.Add(-askMaxAge).UTC().Format(time.RFC3339), member, member, member, member, limit); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	ids := make([]any, 0, len(rows)+1)
	ids = append(ids, project)
	for _, r := range rows {
		ids = append(ids, r.MessageID)
	}
	var questions []struct {
		ID      int64  `db:"id"`
		Content string `db:"content"`
	}
	if err := s.reader().SelectContext(ctx, &questions, `SELECT id, content FROM board_messages WHERE project = ? AND id IN (`+placeholders(len(rows))+`)`, ids...); err != nil {
		return nil, err
	}
	text := make(map[int64]string, len(questions))
	for _, q := range questions {
		text[q.ID] = q.Content
	}
	out := make([]AnsweredAsk, 0, len(rows))
	for _, r := range rows {
		at, _ := time.Parse(time.RFC3339Nano, strings.TrimSpace(r.At))
		out = append(out, AnsweredAsk{MessageID: r.MessageID, Asker: r.Asker, Question: text[r.MessageID], AnswerID: r.ReplyID, Answer: r.Answer, AnsweredAt: at})
	}
	return out, nil
}
