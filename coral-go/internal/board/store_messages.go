// Posting, reading, listing and searching messages (moved out of store.go, #4998; no behaviour change).

package board

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"

	"github.com/jmoiron/sqlx"
	"github.com/subgentic/coral/internal/clitext"
)

// PostMessage posts a new message to a project board.
func (s *Store) PostMessage(ctx context.Context, project, subscriberID, content string, targetGroupID *string) (*Message, error) {
	return s.postMessage(ctx, project, subscriberID, content, targetGroupID, "", "", false, nil)
}

// OriginHubUser marks a chat post a Coral Hub user made through the tunnel (#3377).
const OriginHubUser = "hub_user"

// OriginHubOperator marks a chat post a Coral Hub user made as the Operator through the
// tunnel (#3404): sent as the Operator, with HubUser naming who.
const OriginHubOperator = "hub_operator"

// OriginHubNotice marks a fixed-template notice from Coral Hub about a team link (#3489):
// sent as HubUnknownSender ("Coral Hub"), never an agent or the Operator.
const OriginHubNotice = "hub_notice"

// PostHubNotice posts a notice Coral Hub asked for, as "Coral Hub" with origin hub_notice,
// marked as one of Coral's own messages. content is built by Coral from a fixed template.
func (s *Store) PostHubNotice(ctx context.Context, project, content string) (*Message, error) {
	return s.postMessage(ctx, project, HubUnknownSender, content, nil, OriginHubNotice, "", true, nil)
}

// PostMessageWithOrigin is PostMessage with a server-set origin ("" for none).
func (s *Store) PostMessageWithOrigin(ctx context.Context, project, subscriberID, content string, targetGroupID *string, origin string) (*Message, error) {
	return s.postMessage(ctx, project, subscriberID, content, targetGroupID, origin, "", false, nil)
}

// PostHubMessage posts a chat message a Coral Hub user made through the tunnel, with the
// validated Hub user recorded (#3404): sent as that user with origin hub_user, or, when
// asOperator, as the Operator with origin hub_operator.
func (s *Store) PostHubMessage(ctx context.Context, project, hubUser, content string, targetGroupID *string, asOperator bool) (*Message, error) {
	return s.PostHubMessageForTask(ctx, project, hubUser, content, targetGroupID, asOperator, nil)
}

// PostHubMessageForTask is PostHubMessage for a reply to a task (taskID, #5463); nil for a plain post.
func (s *Store) PostHubMessageForTask(ctx context.Context, project, hubUser, content string, targetGroupID *string, asOperator bool, taskID *int64) (*Message, error) {
	sender, origin := hubUser, OriginHubUser
	if asOperator {
		sender, origin = "Operator", OriginHubOperator
	}
	return s.postMessage(ctx, project, sender, content, targetGroupID, origin, hubUser, false, taskID)
}

// PostMessageForTask is PostMessageWithOrigin for a reply to a task (taskID, #5463); nil for a plain post.
func (s *Store) PostMessageForTask(ctx context.Context, project, subscriberID, content string, targetGroupID *string, origin string, taskID *int64) (*Message, error) {
	return s.postMessage(ctx, project, subscriberID, content, targetGroupID, origin, "", false, taskID)
}

// PostSystemMessage posts as one of Coral's own senders (the task queue, the health
// monitor) and marks the message is_system (#3387). Only server code calls it.
func (s *Store) PostSystemMessage(ctx context.Context, project, sender, content string, targetGroupID *string) (*Message, error) {
	return s.postMessage(ctx, project, sender, content, targetGroupID, "", "", true, nil)
}

// PostDefusedMessage posts content as subscriberID (the Operator's own message to an agent) exactly as given: the caller has already cleaned it (clitext.Clean) and then defused the
// mentions it quotes (DefuseMentions puts a zero-width space after an @, which Clean would remove again, so this path does not clean a second time). Only server code calls it, with
// text it built itself.
func (s *Store) PostDefusedMessage(ctx context.Context, project, subscriberID, content string) (*Message, error) {
	return s.insertMessage(ctx, project, subscriberID, content, nil, "", "", false, nil)
}

// PostSystemDefusedMessage is PostSystemMessage for content the caller has already cleaned (clitext.Clean) and defused (DefuseMentions): it is stored as given, as PostDefusedMessage does, and marked
// is_system. Only server code calls it, with text it built itself.
func (s *Store) PostSystemDefusedMessage(ctx context.Context, project, sender, content string, targetGroupID *string) (*Message, error) {
	return s.insertMessage(ctx, project, sender, content, targetGroupID, "", "", true, nil)
}

func (s *Store) postMessage(ctx context.Context, project, subscriberID, content string, targetGroupID *string, origin, hubUser string, system bool, taskID *int64) (*Message, error) {
	// No terminal control is stored (#3580): a post is printed in agents' terminals by
	// coral-board, and system posts quote task titles agents wrote.
	return s.insertMessage(ctx, project, subscriberID, clitext.Clean(content), targetGroupID, origin, hubUser, system, taskID)
}

// insertMessage stores a message whose content is already clean.
func (s *Store) insertMessage(ctx context.Context, project, subscriberID, content string, targetGroupID *string, origin, hubUser string, system bool, taskID *int64) (*Message, error) {
	now := nowUTC()
	var originVal, hubUserVal *string
	if origin != "" {
		originVal = &origin
	}
	if hubUser != "" {
		hubUserVal = &hubUser
	}
	result, err := s.execEnsuringBoard(ctx, project,
		"INSERT INTO board_messages (project, session_id, subscriber_id, content, target_group_id, created_at, origin, hub_user, is_system, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		project, subscriberID, subscriberID, content, targetGroupID, now, originVal, hubUserVal, system, taskID)
	if err != nil {
		return nil, err
	}
	id, _ := result.LastInsertId()
	msg := &Message{ID: id, Project: project, SubscriberID: subscriberID, Content: content, CreatedAt: now, Origin: originVal, HubUser: hubUserVal, IsSystem: system, TaskID: taskID}
	if targetGroupID != nil {
		msg.TargetGroupID = targetGroupID
	}
	return msg, nil
}

// ReadMessages returns unread messages for a subscriber (cursor-based).
// By default, for non-orchestrator subscribers, only messages where they are
// explicitly tagged (or @all / @notify-all) are returned.
// For orchestrators or when readAll is true, all unread messages from others are returned.
func (s *Store) ReadMessages(ctx context.Context, project, subscriberID string, limit int, readAll ...bool) ([]Message, error) {
	msgs, err := s.readMessages(ctx, project, subscriberID, limit, true, readAll...)
	return s.withAsks(ctx, project, msgs, err)
}

// PeekMessages is ReadMessages that does not move the member's read position: what a person's page lists of an agent's unread messages (#7727's Waiting page), which must leave
// them unread for the agent. The same selection, so what it lists is what the agent's next read returns.
func (s *Store) PeekMessages(ctx context.Context, project, subscriberID string, limit int, readAll ...bool) ([]Message, error) {
	msgs, err := s.readMessages(ctx, project, subscriberID, limit, false, readAll...)
	return s.withAsks(ctx, project, msgs, err)
}

// readRule is who gets which message: the one selection coral-board read, a peek and the dashboard's "what this agent would read" list all apply (#8484).
type readRule struct {
	subscriberID, jobTitle string
	lastReadID             int64
	tagged                 bool // only the messages that explicitly tag the subscriber (or @all): every member but an orchestrator, and not read --all
	none                   bool // receive mode "none": read delivers nothing
}

// subscriberReadRule reads the subscriber's cursor, role and receive mode; nil when it is not subscribed (read delivers nothing).
func (s *Store) subscriberReadRule(ctx context.Context, project, subscriberID string, wantAll bool) *readRule {
	var sub struct {
		LastReadID  int64  `db:"last_read_id"`
		JobTitle    string `db:"job_title"`
		ReceiveMode string `db:"receive_mode"`
		CanPeek     int    `db:"can_peek"`
	}
	err := s.reader().GetContext(ctx, &sub,
		"SELECT last_read_id, job_title, receive_mode, can_peek FROM board_subscribers WHERE project = ? AND subscriber_id = ?",
		project, subscriberID)
	if err != nil {
		return nil // Not subscribed
	}
	return &readRule{
		subscriberID: subscriberID, jobTitle: sub.JobTitle, lastReadID: sub.LastReadID,
		tagged: !wantAll && !isOrchestrator(subscriberID, sub.JobTitle, sub.CanPeek),
		none:   !wantAll && sub.ReceiveMode == "none",
	}
}

// selectRead is the rule applied: the oldest limit messages above afterID that the subscriber would read, in id order. read passes the subscriber's cursor as afterID;
// the dashboard's list passes where its page starts.
func (s *Store) selectRead(ctx context.Context, project string, rule *readRule, afterID int64, limit int) (messages []Message, scanned int64, more bool, err error) {
	if rule.tagged {
		terms := mentionTerms(rule.subscriberID, rule.jobTitle)
		patterns := make([]string, len(terms))
		for i, t := range terms {
			patterns[i] = "%" + t + "%"
		}

		fetchLimit := limit * 2
		if fetchLimit < 50 {
			fetchLimit = 50
		}
		candidates, indexed, err := s.indexedMentionCandidates(ctx, project, rule.subscriberID, afterID, terms, fetchLimit)
		if err != nil {
			return nil, 0, false, err
		}
		if !indexed {
			if candidates, err = s.likeMentionCandidates(ctx, project, rule.subscriberID, afterID, patterns, fetchLimit); err != nil {
				return nil, 0, false, err
			}
		}

		numbered := s.numberedNamesCached(ctx, project)
		more = len(candidates) >= fetchLimit
		for _, msg := range candidates {
			scanned = msg.ID
			if containsExplicitTag(msg.Content, rule.subscriberID, rule.jobTitle, numbered) {
				messages = append(messages, msg)
				if len(messages) >= limit {
					more = true
					break
				}
			}
		}
		return messages, scanned, more, nil
	}
	err = s.reader().SelectContext(ctx, &messages,
		`SELECT m.id, m.project, m.subscriber_id, m.session_id, m.content, m.target_group_id, m.external_json, m.origin, m.hub_user, m.is_system, m.task_id, m.created_at,
		        COALESCE(s.job_title, m.subscriber_id, 'Unknown') as job_title
		 FROM board_messages m
		 LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id
		 WHERE m.project = ? AND m.id > ? AND m.subscriber_id != ?
		 ORDER BY m.id ASC LIMIT ?`,
		project, afterID, rule.subscriberID, limit)
	if n := len(messages); n > 0 {
		scanned = messages[n-1].ID
	}
	return messages, scanned, len(messages) >= limit, err
}

func (s *Store) readMessages(ctx context.Context, project, subscriberID string, limit int, advance bool, readAll ...bool) ([]Message, error) {
	rule := s.subscriberReadRule(ctx, project, subscriberID, len(readAll) > 0 && readAll[0])
	if rule == nil || rule.none {
		return nil, nil
	}
	messages, _, _, err := s.selectRead(ctx, project, rule, rule.lastReadID, limit)
	if err != nil {
		return nil, err
	}
	// Advance cursor past returned messages and own messages
	newCursor := rule.lastReadID
	if len(messages) > 0 {
		for _, m := range messages {
			if m.ID > newCursor {
				newCursor = m.ID
			}
		}
	}

	// Skip past own messages
	var ownMax int64
	getHot(ctx, s.hot().ownMaxMessageID, s.reader(), &ownMax, sqlOwnMaxMessageID, project, subscriberID)
	if ownMax > newCursor {
		newCursor = ownMax
	}

	if advance && newCursor > rule.lastReadID {
		s.db.ExecContext(ctx,
			"UPDATE board_subscribers SET last_read_id = ? WHERE project = ? AND subscriber_id = ?",
			newCursor, project, subscriberID)
	}

	return messages, nil
}

// ForPage is a page of ListMessagesFor: the latest Limit, the Limit before BeforeID, or the first Limit after AfterID (HasAfter: 0 is from the start).
type ForPage struct {
	Limit     int
	BeforeID  int64
	AfterID   int64
	HasAfter  bool
	Scanned   int // the messages selected in all (the board's "total" for this reader)
	Remaining int // those older than the page
}

// selectReadIDs is selectRead's ids: the same selection (the tagged rule reads a batch of candidates' text to apply it, and lets it go), kept as ids only.
func (s *Store) selectReadIDs(ctx context.Context, project string, rule *readRule, afterID int64, limit int) (ids []int64, scanned int64, more bool, err error) {
	if !rule.tagged { // every message from others: no text is needed to choose them
		err = s.reader().SelectContext(ctx, &ids, "SELECT id FROM board_messages WHERE project = ? AND id > ? AND subscriber_id != ? ORDER BY id ASC LIMIT ?", project, afterID, rule.subscriberID, limit)
		if n := len(ids); n > 0 {
			scanned = ids[n-1]
		}
		return ids, scanned, len(ids) >= limit, err
	}
	msgs, scanned, more, err := s.selectRead(ctx, project, rule, afterID, limit)
	ids = make([]int64, len(msgs))
	for i, m := range msgs {
		ids[i] = m.ID
	}
	return ids, scanned, more, err
}

// ReadSetIDs is what the agent's dock lists for it (#8484), as ids in order: what subscriberID's read would deliver from the whole board (selectRead, the one rule: a member's tags and @all,
// an orchestrator's everything from others; a receive mode of "none" delivers nothing), plus the member's own posts so its side of a thread is there; a post that also tags its author is
// there once. Not subscribed: nothing. The ids only are kept, so a board of many thousands of messages costs eight bytes a message, not their text.
func (s *Store) ReadSetIDs(ctx context.Context, project, subscriberID string) ([]int64, error) {
	rule := s.subscriberReadRule(ctx, project, subscriberID, false)
	if rule == nil {
		return nil, nil
	}
	// What an earlier call found is kept (readSetCache): the generations are read before the scan, so a change that lands meanwhile makes the entry stale at once, and the board's newest
	// message id is read before it, so a message that lands meanwhile is picked up by the next call.
	numberedGen, deleteGen := s.numbered.gen.Load(), s.readSets.gen.Load()
	boardMax, err := s.boardMaxMessageID(ctx, project)
	if err != nil {
		return nil, err
	}
	entry, cached := s.readSets.get(project, subscriberID, rule, numberedGen)
	if cached && entry.boardMax == boardMax {
		return mergeReadSet(entry.read, entry.own), nil // nothing new on the board
	}
	if !cached {
		entry = readSetEntry{project: project, subscriberID: subscriberID, jobTitle: rule.jobTitle, tagged: rule.tagged, none: rule.none, numberedGen: numberedGen, gen: deleteGen}
	}
	read := entry.read
	if !rule.none {
		// The tagged rule reads each batch's candidates in full to apply the rule, so the batch is small (its text is what is held at once); the others' are ids.
		batch := 100
		if !rule.tagged {
			batch = 5000
		}
		from := entry.upTo
		for i := 0; i < 2000; i++ { // a bound on a board of many thousands of selected messages (200,000 tagged ones)
			s.readSets.scans.Add(1)
			got, scanned, more, err := s.selectReadIDs(ctx, project, rule, from, batch)
			if err != nil {
				return nil, err
			}
			if len(got) > 0 {
				read = append(read[:len(read):len(read)], got...) // a copy: the entry's slice is shared with the calls that read it
			}
			if scanned > entry.upTo {
				entry.upTo = scanned
			}
			if !more || scanned <= from {
				break
			}
			from = scanned
		}
	}
	var newOwn []int64
	if err := s.reader().SelectContext(ctx, &newOwn, "SELECT id FROM board_messages WHERE project = ? AND subscriber_id = ? AND id > ? AND id <= ? ORDER BY id ASC", project, subscriberID, entry.boardMax, boardMax); err != nil {
		return nil, err
	}
	own := entry.own
	if len(newOwn) > 0 {
		own = append(own[:len(own):len(own)], newOwn...)
	}
	entry.read, entry.own, entry.boardMax = read, own, boardMax
	s.readSets.put(entry)
	return mergeReadSet(read, own), nil
}

// mergeReadSet merges the two lists, both in id order: a message in both once.
func mergeReadSet(read, own []int64) []int64 {
	out := make([]int64, 0, len(read)+len(own))
	i, j := 0, 0
	for i < len(read) || j < len(own) {
		switch {
		case j >= len(own) || (i < len(read) && read[i] < own[j]):
			out = append(out, read[i])
			i++
		case i >= len(read) || own[j] < read[i]:
			out = append(out, own[j])
			j++
		default:
			out = append(out, read[i])
			i++
			j++
		}
	}
	return out
}

// ListMessagesFor lists the dock's view of a board for subscriberID (ReadSetIDs), no cursor and no side effects, paged like the dashboard's list; only the page's messages are read in full.
func (s *Store) ListMessagesFor(ctx context.Context, project, subscriberID string, page ForPage) ([]Message, ForPage, error) {
	all, err := s.ReadSetIDs(ctx, project, subscriberID)
	if err != nil {
		return nil, page, err
	}
	page.Scanned = len(all)
	var picked []int64
	switch {
	case page.HasAfter:
		for _, id := range all {
			if id > page.AfterID {
				picked = append(picked, id)
				if len(picked) >= page.Limit {
					break
				}
			}
		}
	default:
		for _, id := range all {
			if page.BeforeID == 0 || id < page.BeforeID {
				picked = append(picked, id)
			}
		}
		if len(picked) > page.Limit {
			picked = picked[len(picked)-page.Limit:]
		}
	}
	anchor := page.BeforeID
	switch {
	case len(picked) > 0:
		anchor = picked[0]
	case page.HasAfter:
		anchor = page.AfterID + 1
	}
	page.Remaining = 0
	if anchor > 0 {
		page.Remaining = sort.Search(len(all), func(i int) bool { return all[i] >= anchor }) // the ids older than the page
	}
	if len(picked) == 0 {
		return nil, page, nil
	}
	query, args, err := sqlx.In(listMessagesSelect+" WHERE m.project = ? AND m.id IN (?) ORDER BY m.id ASC", project, picked)
	if err != nil {
		return nil, page, err
	}
	var msgs []Message
	err = s.reader().SelectContext(ctx, &msgs, s.reader().Rebind(query), args...)
	msgs, err = s.withAsks(ctx, project, msgs, err)
	return msgs, page, err
}

// MarkReadThrough moves a subscriber's read position forward to throughID
// (never back), for readers that looked at the newest messages rather than
// reading in order (coral-board read --last N). It reports the messages from
// others that were unread and older than fromID, the oldest one shown, which
// this skips without their having been displayed.
func (s *Store) MarkReadThrough(ctx context.Context, project, subscriberID string, throughID, fromID int64) (skipped int, firstSkipped, lastSkipped int64, err error) {
	var lastReadID int64
	if err = s.reader().GetContext(ctx, &lastReadID,
		"SELECT last_read_id FROM board_subscribers WHERE project = ? AND subscriber_id = ?",
		project, subscriberID); err != nil {
		if err == sql.ErrNoRows {
			err = fmt.Errorf("%s is not subscribed to %s", subscriberID, project)
		}
		return 0, 0, 0, err
	}
	if throughID <= lastReadID {
		return 0, 0, 0, nil
	}
	var r struct {
		N     int   `db:"n"`
		First int64 `db:"first"`
		Last  int64 `db:"last"`
	}
	if err = s.reader().GetContext(ctx, &r,
		`SELECT COUNT(*) AS n, COALESCE(MIN(id), 0) AS first, COALESCE(MAX(id), 0) AS last FROM board_messages
		 WHERE project = ? AND id > ? AND id < ? AND subscriber_id != ? AND subscriber_id NOT IN ('Coral Task Queue')`,
		project, lastReadID, fromID, subscriberID); err != nil {
		return 0, 0, 0, err
	}
	_, err = s.db.ExecContext(ctx,
		"UPDATE board_subscribers SET last_read_id = ? WHERE project = ? AND subscriber_id = ? AND last_read_id < ?",
		throughID, project, subscriberID, throughID)
	return r.N, r.First, r.Last, err
}

// ListMessages returns recent messages (no cursor, no side effects).
// If beforeID > 0, only messages with id < beforeID are returned (keyset pagination).
func (s *Store) ListMessages(ctx context.Context, project string, limit, offset int, beforeID int64) ([]Message, error) {
	var messages []Message
	var err error
	if beforeID > 0 {
		err = s.reader().SelectContext(ctx, &messages,
			`SELECT m.id, m.project, m.subscriber_id, m.session_id, m.content, m.created_at,
			        COALESCE(s.job_title, m.subscriber_id, 'Unknown') as job_title,
			        m.target_group_id, m.external_json, m.origin, m.hub_user, m.is_system, m.task_id
			 FROM board_messages m
			 LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id
			 WHERE m.project = ? AND m.id < ?
			 ORDER BY m.id ASC LIMIT ? OFFSET ?`,
			project, beforeID, limit, offset)
	} else if offset > 0 {
		// Paginated load: use ASC order with offset for consistent pagination
		err = s.reader().SelectContext(ctx, &messages,
			`SELECT m.id, m.project, m.subscriber_id, m.session_id, m.content, m.created_at,
			        COALESCE(s.job_title, m.subscriber_id, 'Unknown') as job_title,
			        m.target_group_id, m.external_json, m.origin, m.hub_user, m.is_system, m.task_id
			 FROM board_messages m
			 LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id
			 WHERE m.project = ?
			 ORDER BY m.id ASC LIMIT ? OFFSET ?`,
			project, limit, offset)
	} else {
		// Initial load (offset=0): get most recent messages
		err = s.reader().SelectContext(ctx, &messages,
			`SELECT * FROM (
			    SELECT m.id, m.project, m.subscriber_id, m.session_id, m.content, m.created_at,
			           COALESCE(s.job_title, m.subscriber_id, 'Unknown') as job_title,
			           m.target_group_id, m.external_json, m.origin, m.hub_user, m.is_system, m.task_id
			    FROM board_messages m
			    LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id
			    WHERE m.project = ?
			    ORDER BY m.id DESC LIMIT ?
			 ) sub ORDER BY id ASC`,
			project, limit)
	}
	return s.withAsks(ctx, project, messages, err)
}

// listMessagesSelect is the dashboard message row; callers append the WHERE.
const listMessagesSelect = `SELECT m.id, m.project, m.subscriber_id, m.session_id, m.content, m.created_at,
	        COALESCE(s.job_title, m.subscriber_id, 'Unknown') as job_title,
	        m.target_group_id, m.external_json, m.origin, m.hub_user, m.is_system, m.task_id
	 FROM board_messages m
	 LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id`

// Keyset paging queries; the EXPLAIN test checks these exact strings.
const (
	listMessagesBeforeSQL = `SELECT * FROM (` + listMessagesSelect + `
	    WHERE m.project = ? AND m.id < ?
	    ORDER BY m.id DESC LIMIT ?
	 ) sub ORDER BY id ASC`
	listMessagesAfterSQL = listMessagesSelect + `
	 WHERE m.project = ? AND m.id > ?
	 ORDER BY m.id ASC LIMIT ?`
	countMessagesBeforeSQL = "SELECT COUNT(*) FROM board_messages WHERE project = ? AND id < ?"
	// A board's total, counted from where its cached total stopped (messageTotal).
	messageTotalHighSQL  = "SELECT COALESCE(MAX(id), ?) FROM board_messages WHERE project = ? AND id > ?"
	messageTotalCountSQL = "SELECT COUNT(*) FROM board_messages WHERE project = ? AND id > ? AND id <= ?"
	// The messages from an id up to the counted high, at most a limit of them.
	countMessagesTailSQL = "SELECT COUNT(*) FROM (SELECT 1 FROM board_messages WHERE project = ? AND id >= ? AND id <= ? LIMIT ?)"
)

// beforeCountTail: CountMessagesBefore subtracts the messages from beforeID on from the
// board's total when there are at most this many (a dashboard poll or the latest page: none
// to a page's worth), and counts the older ones directly when paging deep into the history.
const beforeCountTail = 5000

// ListMessagesBefore returns the newest limit messages with id < beforeID,
// oldest first: the page just before a loaded one. Unlike OFFSET paging it
// seeks the (project, id) index, so its cost does not grow with board size.
func (s *Store) ListMessagesBefore(ctx context.Context, project string, beforeID int64, limit int) ([]Message, error) {
	var messages []Message
	err := s.reader().SelectContext(ctx, &messages, listMessagesBeforeSQL, project, beforeID, limit)
	return s.withAsks(ctx, project, messages, err)
}

// ListMessagesAfter returns the oldest limit messages with id > afterID,
// oldest first: what arrived after the newest loaded message.
func (s *Store) ListMessagesAfter(ctx context.Context, project string, afterID int64, limit int) ([]Message, error) {
	var messages []Message
	err := s.reader().SelectContext(ctx, &messages, listMessagesAfterSQL, project, afterID, limit)
	return s.withAsks(ctx, project, messages, err)
}

// CountMessagesBefore counts the project's messages with id < beforeID.
func (s *Store) CountMessagesBefore(ctx context.Context, project string, beforeID int64) (int, error) {
	total, hi, err := s.messageTotal(ctx, project)
	if err != nil {
		return 0, err
	}
	if beforeID > hi {
		return total, nil
	}
	var tail int
	if err := s.reader().GetContext(ctx, &tail, countMessagesTailSQL, project, beforeID, hi, beforeCountTail+1); err != nil {
		return 0, err
	}
	if tail <= beforeCountTail {
		return max(total-tail, 0), nil
	}
	var count int
	err = s.reader().GetContext(ctx, &count, countMessagesBeforeSQL, project, beforeID)
	return count, err
}

// GetMessageByID returns one message of a board by its id. Message ids are numbered across
// every board, so an id from another board is not found here (sql.ErrNoRows), as if it did
// not exist (#3864: an agent read other teams' messages by walking ids under its own board).
func (s *Store) GetMessageByID(ctx context.Context, project string, id int64) (*Message, error) {
	var msg Message
	err := s.reader().GetContext(ctx, &msg,
		`SELECT m.id, m.project, m.subscriber_id, m.session_id, m.content, m.created_at,
		        COALESCE(s.job_title, m.subscriber_id, 'Unknown') as job_title,
		        m.target_group_id, m.external_json, m.origin, m.hub_user, m.is_system, m.task_id
		 FROM board_messages m
		 LEFT JOIN board_subscribers s ON m.project = s.project AND m.subscriber_id = s.subscriber_id
		 WHERE m.id = ? AND m.project = ?`, id, project)
	if err != nil {
		return nil, err
	}
	one := []Message{msg}
	if err := s.fillAsks(ctx, project, one); err != nil {
		return nil, err
	}
	return &one[0], nil
}

// ExistingMessageIDs is which of these message ids are on the board: one query for all of them (a board's message ids are numbered across every board, so an id of another
// board is not there). Saved for Later uses it to mark the bookmarks whose message was deleted (#5802).
func (s *Store) ExistingMessageIDs(ctx context.Context, project string, ids []int64) (map[int64]bool, error) {
	have := map[int64]bool{}
	for len(ids) > 0 {
		n := min(len(ids), 500) // SQLite's variable limit stays far away
		chunk := ids[:n]
		ids = ids[n:]
		args := make([]any, 0, n+1)
		args = append(args, project)
		for _, id := range chunk {
			args = append(args, id)
		}
		var found []int64
		q := "SELECT id FROM board_messages WHERE project = ? AND id IN (?" + strings.Repeat(",?", n-1) + ")"
		if err := s.reader().SelectContext(ctx, &found, q, args...); err != nil {
			return nil, err
		}
		for _, id := range found {
			have[id] = true
		}
	}
	return have, nil
}

// SearchMessageHits returns bounded board messages containing query text. It
// exposes the immutable message ID used by chat search navigation.
func (s *Store) SearchMessageHits(ctx context.Context, query string, limit int) ([]Message, error) {
	if limit < 1 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	var messages []Message
	err := s.reader().SelectContext(ctx, &messages,
		`SELECT m.id, m.project, m.subscriber_id, m.session_id, m.content, m.created_at,
		        COALESCE(bs.job_title, m.subscriber_id, 'Unknown') as job_title,
		        m.target_group_id, m.external_json, m.origin, m.hub_user, m.is_system, m.task_id
		 FROM board_messages m
		 LEFT JOIN board_subscribers bs ON m.project = bs.project AND m.subscriber_id = bs.subscriber_id
		 WHERE m.content LIKE ? COLLATE NOCASE
		 ORDER BY m.id DESC LIMIT ?`, "%"+query+"%", limit)
	return messages, err
}

// CountMessages returns the total message count for a project.
func (s *Store) CountMessages(ctx context.Context, project string) (int, error) {
	total, _, err := s.messageTotal(ctx, project)
	return total, err
}

// CoralSender is the system sender of Coral's notices to one agent (#3636: "Coral restarted").
// Such a notice @-names its agent; a subscriber reading everything counts it only when it is the
// one named.
const CoralSender = "Coral"
