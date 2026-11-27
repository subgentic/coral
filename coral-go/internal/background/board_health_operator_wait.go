package background

import (
	"context"
	"fmt"
	"strconv"
	"strings"
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
	ow := m.store.GetHealthSettings(ctx, project).OperatorWait
	grace := time.Duration(ow.GraceMin) * time.Minute
	cursor, known := m.store.OperatorWaitCursor(ctx, project)
	if !ow.On {
		if latest, err := m.store.LatestMessageID(ctx, project); err == nil && known {
			_ = m.store.SetOperatorWaitCursor(ctx, project, latest) // off: nothing is judged later either
		}
		return
	}
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
		if now.Sub(at) < grace {
			break // not old enough to judge: the author still has the time; a later check reads it
		}
		last = msg.ID
		if msg.IsSystem || msg.Origin != nil || !member[msg.SubscriberID] || board.IsOperatorName(msg.SubscriberID) || ow.Exempt(msg.SubscriberID) || !board.WaitsOnOperator(msg.Content) {
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
		if board.OperatorWaitCoveredWithin(msg, later, tags, grace) {
			continue
		}
		id := strconv.FormatInt(msg.ID, 10)
		detail := fmt.Sprintf("posted something that waits on the Operator (message #%s, %s ago) with no --ask to them and no \"for review\" file within %d minutes: it is not in their Needs you", id, teamhealth.Age(now.Sub(at)), ow.GraceMin)
		if added, err := m.store.AddOffBooksOnce(ctx, project, board.OffBooksOperatorWait, msg.SubscriberID, id, detail, at); err == nil && added {
			nudge := operatorWaitNudge("Your board message #"+id, msg.Content)
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

// operatorWaitChatMaxAge is how old an agent's last chat reply may be and still be judged: the check runs every few minutes, so a reply this old that was never judged is not new, and a transcript read after a restart
// does not call up an old conversation.
const operatorWaitChatMaxAge = time.Hour

// noteChatOperatorWaits (#12138 part 2): the chat half. An agent's NEWEST chat reply (its transcript's last message, from the agent, not Coral's typed words) that waits on the Operator (board.WaitsOnOperator: an @Operator, or a waiting
// phrase with the word) and is between OperatorWaitGrace and an hour old, with no --ask to the Operator and no "for review" file linked by that author within the grace of the reply (board.OperatorWaitCovered), is the same line and nudge
// as a board post. Said once per reply (the reply's time is its ref); the line has how long ago, never the reply's words. Only the newest reply is read: an agent that has said more since has the Operator's wait in an older one that
// is not judged. The Operator, an agent with no live session and the orchestrator's nudge-to-itself follow the board-post rules.
func (m *BoardHealthMonitor) noteChatOperatorWaits(ctx context.Context, project, orch string, subs []board.Subscriber, bySession map[string]AgentInfo, now time.Time) {
	ow := m.store.GetHealthSettings(ctx, project).OperatorWait
	if m.lastMessage == nil || !ow.On {
		return
	}
	grace, chatMax := time.Duration(ow.GraceMin)*time.Minute, time.Duration(ow.ChatMaxAgeMin)*time.Minute
	var recent []board.Message
	var tags map[string][]string
	loaded := false
	for _, sub := range subs {
		a, live := bySession[sub.SessionName]
		if !live || board.IsOperatorName(sub.SubscriberID) || ow.Exempt(sub.SubscriberID) {
			continue
		}
		lm, ok := m.lastMessage(a.SessionID, a.WorkingDirectory, a.AgentType)
		if !ok || lm.Role != "assistant" || !board.WaitsOnOperator(lm.Text) {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, lm.At)
		if err != nil {
			continue
		}
		age := now.Sub(at)
		if age < grace || age > chatMax {
			continue
		}
		if !loaded {
			loaded = true
			if latest, err := m.store.LatestMessageID(ctx, project); err == nil {
				from := latest - operatorWaitLook
				if from < 0 {
					from = 0
				}
				recent, _ = m.store.ListMessagesAfter(ctx, project, from, operatorWaitLook)
			}
			tags, _ = m.store.ArtifactTags(ctx, project)
		}
		reply := board.Message{SubscriberID: sub.SubscriberID, CreatedAt: at.UTC().Format(time.RFC3339)}
		if board.OperatorWaitCoveredWithin(reply, recent, tags, grace) {
			continue
		}
		ref := "chat:" + a.SessionID + ":" + at.UTC().Format(time.RFC3339)
		detail := fmt.Sprintf("said something in its chat that waits on the Operator (%s ago) with no --ask to them and no \"for review\" file within %d minutes: it is not in their Needs you", teamhealth.Age(age), ow.GraceMin)
		if added, err := m.store.AddOffBooksOnce(ctx, project, board.OffBooksOperatorWait, sub.SubscriberID, ref, detail, at); err == nil && added {
			nudge := operatorWaitNudge("Your last chat reply", "")
			m.nudgeMember(ctx, project, orch, board.HealthSettings{}, sub.SubscriberID, "operator-wait-chat:"+ref+":", nudge, bySession, subs)
		}
	}
}

// operatorWaitNudge is what an agent is told when its words wait on the Operator and are not in their Needs you (#21811). A post that links a report or another file is sent as that file: the report is the thing to
// look at, so it goes for review (a file of the team that exists already, or one not uploaded yet), with its one-line question; a post with no file is posted again with --ask.
func operatorWaitNudge(what, content string) string {
	if strings.Contains(content, "coral://artifacts/") {
		return what + " waits on the Operator and links a file, but it is not in their Needs you. Send the file for review instead of only asking: `coral-agent artifact review <the coral://artifacts link> --question \"<what they decide>\"` " +
			"(a file you have not uploaded yet: `coral-agent artifact upload <file> --tag \"for review\" --question \"<what they decide>\"`; a goal's finished result: `coral-board goal close <id> --reason ... --result <file>`). A question with no file is `coral-board post --ask \"@Operator <the question>\"`."
	}
	return what + " waits on the Operator, but it is not in their Needs you. Post it again as `coral-board post --ask \"@Operator <the question>\"` (or tag the file \"for review\" and link it), so they see it."
}
