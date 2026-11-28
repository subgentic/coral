package board

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// AnsweredGoalAsk is a question about a goal that a member answered, with the answer: the Goals page lists what the Operator answered under a goal (#22106).
type AnsweredGoalAsk struct {
	MessageID  int64
	Asker      string
	Content    string
	At         time.Time
	GoalID     int64
	TaskID     int64
	AnswerText string    // the member's latest reply to the question; "" when the answer was an @mention post that is not a reply
	AnsweredAt time.Time // when that reply was posted; zero with no reply
}

// answeredAsksScanMax bounds how many of a goal's questions one read looks at, however few are answered.
var answeredAsksScanMax = 200 // a var so a test can cut the scan short

// AnsweredAsksForGoal are the questions of the board about goalID that member was asked and has answered (not closed by hand: those have no answer to show), newest first, at most limit with a message id below
// beforeID (0 for the newest). next is the beforeID of the following page, 0 when nothing older remains: past the last question listed when the page is full, or past the last one looked at when the
// bounded scan was cut, so an older answer is always reachable. A question the member reopened counts only when answered again after that.
func (s *Store) AnsweredAsksForGoal(ctx context.Context, project, member string, goalID int64, limit int, beforeID int64) (out []AnsweredGoalAsk, next int64, err error) {
	if beforeID <= 0 {
		beforeID = 1<<62 - 1
	}
	var asks []askRow
	if err = s.reader().SelectContext(ctx, &asks, `SELECT a.message_id, a.asker, a.asked, a.created_at FROM board_asks a
		JOIN board_ask_subjects sj ON sj.message_id = a.message_id AND sj.project = a.project
		WHERE a.project = ? AND sj.goal_id = ? AND a.message_id < ? ORDER BY a.message_id DESC LIMIT ?`, project, goalID, beforeID, answeredAsksScanMax); err != nil {
		return nil, 0, err
	}
	if len(asks) == 0 {
		return nil, 0, nil
	}
	subs, err := s.subscriberIndex(ctx, project)
	if err != nil {
		return nil, 0, err
	}
	for _, a := range asks {
		var to []string
		_ = json.Unmarshal([]byte(a.Asked), &to)
		named := false
		for _, m := range to {
			named = named || strings.EqualFold(m, member)
		}
		if !named {
			continue
		}
		var closed bool
		if err = s.reader().GetContext(ctx, &closed, `SELECT EXISTS(SELECT 1 FROM board_ask_closed WHERE project = ? AND message_id = ?)`, project, a.MessageID); err != nil {
			return nil, 0, err
		}
		if closed {
			continue
		}
		var after int64
		_ = s.reader().GetContext(ctx, &after, `SELECT after_id FROM board_ask_reopened WHERE project = ? AND message_id = ?`, project, a.MessageID)
		a.Floor = after
		done, err := s.answeredBy(ctx, project, a, member, subs)
		if err != nil {
			return nil, 0, err
		}
		if !done {
			continue
		}
		if len(out) == limit {
			return out, out[len(out)-1].MessageID, nil // one more answered question exists past the page
		}
		row := AnsweredGoalAsk{MessageID: a.MessageID, Asker: a.Asker}
		row.At, _ = time.Parse(time.RFC3339, a.CreatedAt)
		_ = s.reader().GetContext(ctx, &row.Content, `SELECT content FROM board_messages WHERE project = ? AND id = ?`, project, a.MessageID)
		var sj struct {
			GoalID int64 `db:"goal_id"`
			TaskID int64 `db:"task_id"`
		}
		_ = s.reader().GetContext(ctx, &sj, `SELECT goal_id, task_id FROM board_ask_subjects WHERE message_id = ?`, a.MessageID)
		row.GoalID, row.TaskID = sj.GoalID, sj.TaskID
		var reply struct {
			Content string `db:"content"`
			At      string `db:"created_at"`
		}
		if s.reader().GetContext(ctx, &reply, `SELECT m.content, m.created_at FROM board_messages m JOIN board_replies r ON r.message_id = m.id
			WHERE m.project = ? AND m.id > ? AND m.subscriber_id = ? AND COALESCE(m.is_system, 0) = 0 AND COALESCE(m.no_answer, 0) = 0 AND r.reply_to = ? ORDER BY m.id DESC LIMIT 1`,
			project, a.floor(), member, a.MessageID) == nil {
			row.AnswerText = reply.Content
			row.AnsweredAt, _ = time.Parse(time.RFC3339Nano, strings.TrimSpace(reply.At))
		}
		out = append(out, row)
	}
	if len(asks) == answeredAsksScanMax { // a cut scan: an older answered question may remain, past the last one looked at
		next = asks[len(asks)-1].MessageID
	}
	return out, next, nil
}
