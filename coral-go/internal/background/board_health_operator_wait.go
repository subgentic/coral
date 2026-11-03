package background

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/teamhealth"
)

// operatorWaitScan bounds one scan of a board's messages, and operatorWaitLook how many messages after a post are read for its cover (an --ask or a "for review" file of the same author).
const (
	operatorWaitScan = 200
	operatorWaitLook = 300
)

// noteOperatorWaits (#12138, the Operator): a post that waits on the Operator and is not in their Needs you. Each message the board got since the last scan, once it is OperatorWaitGrace old, by a member other than
// Coral's own, the Operator and Coral Hub users: if its words wait on the Operator (board.WaitsOnOperator) and neither it nor a later post of the author within the grace is an --ask to the Operator or links a file
// tagged "for review" (board.OperatorWaitCovered), it is a line of the check and a nudge to its author to put it in Needs you. The first scan only marks where the board is. A post younger than the grace stops the scan
// there (it is judged at a later check), so nothing is judged before the author had the time. Said once per message; the line has the message number and its age, never the post's words.
func (m *BoardHealthMonitor) noteOperatorWaits(ctx context.Context, project, orch string, subs []board.Subscriber, bySession map[string]AgentInfo, now time.Time) {
	cursor, known := m.store.OperatorWaitCursor(ctx, project)
	if !known {
		if latest, err := m.store.LatestMessageID(ctx, project); err == nil {
			_ = m.store.SetOperatorWaitCursor(ctx, project, latest)
		}
		return
	}
	msgs, err := m.store.ListMessagesAfter(ctx, project, cursor, operatorWaitScan)
	if err != nil || len(msgs) == 0 {
		return
	}
	member := map[string]bool{}
	for _, s := range subs {
		member[s.SubscriberID] = true
	}
	var tags map[string][]string
	last := cursor
	for _, msg := range msgs {
		at, err := time.Parse(time.RFC3339, msg.CreatedAt)
		if err != nil {
			at = now
		}
		if now.Sub(at) < board.OperatorWaitGrace {
			break // not old enough to judge: the author still has the time; a later check reads it
		}
		last = msg.ID
		if msg.IsSystem || msg.Origin != nil || !member[msg.SubscriberID] || board.IsOperatorName(msg.SubscriberID) || !board.WaitsOnOperator(msg.Content) {
			continue
		}
		if msg.Ask != nil && askedTheOperator(msg.Ask) {
			continue
		}
		if tags == nil {
			tags, _ = m.store.ArtifactTags(ctx, project)
		}
		later, err := m.store.ListMessagesAfter(ctx, project, msg.ID-1, operatorWaitLook)
		if err != nil {
			last = msg.ID - 1 // it cannot tell yet: it is judged again at the next check
			break
		}
		if board.OperatorWaitCovered(msg, later, tags) {
			continue
		}
		id := strconv.FormatInt(msg.ID, 10)
		detail := fmt.Sprintf("posted something that waits on the Operator (message #%s, %s ago) with no --ask to them and no \"for review\" file within %d minutes: it is not in their Needs you", id, teamhealth.Age(now.Sub(at)), int(board.OperatorWaitGrace/time.Minute))
		if added, err := m.store.AddOffBooksOnce(ctx, project, board.OffBooksOperatorWait, msg.SubscriberID, id, detail, at); err == nil && added {
			nudge := fmt.Sprintf("Your board message #%s waits on the Operator, but it is not in their Needs you. Post it again as `coral-board post --ask \"@Operator <the question>\"` (or tag the file \"for review\" and link it), so they see it.", id)
			m.nudgeMember(ctx, project, orch, board.HealthSettings{}, msg.SubscriberID, "operator-wait:"+id+":", nudge, bySession, subs)
		}
	}
	if last > cursor {
		_ = m.store.SetOperatorWaitCursor(ctx, project, last)
	}
}

// askedTheOperator says an ask is to the Operator.
func askedTheOperator(a *board.AskInfo) bool {
	for _, to := range a.To {
		if board.IsOperatorName(to) {
			return true
		}
	}
	return false
}
