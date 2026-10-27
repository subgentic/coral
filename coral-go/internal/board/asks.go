package board

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// broadcastTagRE finds the tags that name everyone (@all and its spellings).
var broadcastTagRE = regexp.MustCompile(`(?i)(^|[^\p{L}\p{N}])@(all|notify-all|notify_all|notifyall)($|[^\p{L}\p{N}-])`)

// Asks (#7794, goal #21): a post that needs an answer from the members it @mentions, without being a task. `coral-board post --ask "@Name question"` marks the post as a question; it is
// open until each mentioned member has answered it. THE LINK, the simplest one that is reliable: a reply is a post of that member made after the question that either names it
// (`post --reply-to <message id>`, stored in board_replies) or @mentions the asker (the natural reply: "@Asker: yes, ..."). A reply that does neither is not seen as an answer, and the
// question stays open: that is the point of --reply-to. Everything here is read on demand from the two small tables and the board's messages: nothing is kept up to date by a job.

// ErrAskNobody refuses an ask that @mentions no member of the board (other than its asker): there is nobody to ask.
var ErrAskNobody = errors.New("an ask needs someone to ask: @mention at least one member of the board (not @all)")

// ErrReplyToUnknown refuses a reply_to that is no message of this board before the reply.
var ErrReplyToUnknown = errors.New("reply_to is not a message of this board")

// askMaxAge is how long a question counts as open for reminders and the health check: an older one is left alone (the people it was for have long since moved on).
const askMaxAge = 7 * 24 * time.Hour

// AskInfo is what a question message says about itself, filled where messages are read.
type AskInfo struct {
	To       []string `json:"to"`   // the members asked (subscriber ids)
	Open     []string `json:"open"` // those who have not answered yet
	Answered bool     `json:"answered"`
}

func (s *Store) ensureAsksSchema(ctx context.Context) error {
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS board_asks (
			message_id INTEGER PRIMARY KEY,
			project    TEXT NOT NULL,
			asker      TEXT NOT NULL,
			asked      TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_board_asks_project ON board_asks(project, message_id)`,
		`CREATE TABLE IF NOT EXISTS board_replies (
			message_id INTEGER PRIMARY KEY,
			project    TEXT NOT NULL,
			reply_to   INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_board_replies_to ON board_replies(project, reply_to)`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// AskTargets are the members a post would ask: every member other than the poster that the text explicitly @mentions. @all names no one in particular and asks nobody.
func (s *Store) AskTargets(ctx context.Context, project, poster, content string) ([]string, error) {
	subs, err := s.ListSubscribers(ctx, project)
	if err != nil {
		return nil, err
	}
	content = broadcastTagRE.ReplaceAllString(content, " ") // @all is a tag every member answers to: it asks no one in particular
	var out []string
	for _, sub := range subs {
		if SameIdentity(sub.SubscriberID, poster) {
			continue
		}
		if containsExplicitTag(content, sub.SubscriberID, sub.JobTitle) {
			out = append(out, sub.SubscriberID)
		}
	}
	if len(out) == 0 {
		return nil, ErrAskNobody
	}
	return out, nil
}

// CheckReplyTo refuses a reply_to that is no message of the board (and no later than the reply can be: it must exist now).
func (s *Store) CheckReplyTo(ctx context.Context, project string, replyTo int64) error {
	var n int
	if err := s.reader().GetContext(ctx, &n, `SELECT COUNT(*) FROM board_messages WHERE project = ? AND id = ?`, project, replyTo); err != nil {
		return err
	}
	if n == 0 {
		return ErrReplyToUnknown
	}
	return nil
}

// RecordAsk marks the posted message as a question to these members.
func (s *Store) RecordAsk(ctx context.Context, project string, msg *Message, asked []string) error {
	b, _ := json.Marshal(asked)
	_, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO board_asks (message_id, project, asker, asked, created_at) VALUES (?, ?, ?, ?, ?)`, msg.ID, project, msg.SubscriberID, string(b), msg.CreatedAt)
	return err
}

// RecordReply links the posted message as a reply to another.
func (s *Store) RecordReply(ctx context.Context, project string, msgID, replyTo int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO board_replies (message_id, project, reply_to) VALUES (?, ?, ?)`, msgID, project, replyTo)
	return err
}

type askRow struct {
	MessageID int64  `db:"message_id"`
	Asker     string `db:"asker"`
	Asked     string `db:"asked"`
	CreatedAt string `db:"created_at"`
}

// answeredBy reports whether member has answered the question: a post of theirs after it that is a reply to it (reply_to), or @mentions the asker. Neither read has a cap: the reply is one EXISTS
// query, and the mention reads the member's posts that contain the asker's name in pages until one really tags the asker, however many posts the member made before answering (#7845).
func (s *Store) answeredBy(ctx context.Context, project string, a askRow, member string, subs map[string]Subscriber) (bool, error) {
	var replied bool
	if err := s.reader().GetContext(ctx, &replied, `SELECT EXISTS(SELECT 1 FROM board_messages m JOIN board_replies r ON r.message_id = m.id
		WHERE m.project = ? AND m.id > ? AND m.subscriber_id = ? AND COALESCE(m.is_system, 0) = 0 AND r.reply_to = ?)`, project, a.MessageID, member, a.MessageID); err != nil {
		return false, err
	}
	if replied {
		return true, nil
	}
	title := subs[strings.ToLower(a.Asker)].JobTitle
	last := a.MessageID
	for {
		var posts []struct {
			ID      int64  `db:"id"`
			Content string `db:"content"`
		}
		// The substring narrows the posts to those that may tag the asker; the word-boundary test below decides.
		if err := s.reader().SelectContext(ctx, &posts, `SELECT id, content FROM board_messages
			WHERE project = ? AND id > ? AND subscriber_id = ? AND COALESCE(is_system, 0) = 0
			  AND (instr(lower(content), lower('@' || ?)) > 0 OR (? != '' AND instr(lower(content), lower('@' || ?)) > 0))
			ORDER BY id LIMIT 200`, project, last, member, a.Asker, title, title); err != nil {
			return false, err
		}
		for _, p := range posts {
			if containsExplicitTag(p.Content, a.Asker, title) {
				return true, nil
			}
		}
		if len(posts) < 200 {
			return false, nil
		}
		last = posts[len(posts)-1].ID
	}
}

func (s *Store) subscriberIndex(ctx context.Context, project string) (map[string]Subscriber, error) {
	subs, err := s.ListSubscribers(ctx, project)
	if err != nil {
		return nil, err
	}
	out := make(map[string]Subscriber, len(subs))
	for _, sub := range subs {
		out[strings.ToLower(sub.SubscriberID)] = sub
	}
	return out, nil
}

// fillAsks sets Ask and ReplyTo on the messages that are a question or a reply: one query for the page's ids, and per question the answers of the members asked.
func (s *Store) fillAsks(ctx context.Context, project string, msgs []Message) error {
	if len(msgs) == 0 {
		return nil
	}
	for i := range msgs { // how to answer a message from another board (#9054): from the message's own envelope, no query
		msgs[i].ReplyWith = CrossReplyLine(msgs[i].External, msgs[i].ID)
	}
	ids := make([]any, 0, len(msgs)+1)
	ids = append(ids, project)
	for _, m := range msgs {
		ids = append(ids, m.ID)
	}
	in := placeholders(len(msgs))
	var asks []askRow
	if err := s.reader().SelectContext(ctx, &asks, `SELECT message_id, asker, asked, created_at FROM board_asks WHERE project = ? AND message_id IN (`+in+`)`, ids...); err != nil {
		return err
	}
	var replies []struct {
		MessageID int64 `db:"message_id"`
		ReplyTo   int64 `db:"reply_to"`
	}
	if err := s.reader().SelectContext(ctx, &replies, `SELECT message_id, reply_to FROM board_replies WHERE project = ? AND message_id IN (`+in+`)`, ids...); err != nil {
		return err
	}
	if len(asks) == 0 && len(replies) == 0 {
		return nil
	}
	askBy := map[int64]askRow{}
	for _, a := range asks {
		askBy[a.MessageID] = a
	}
	replyBy := map[int64]int64{}
	for _, r := range replies {
		replyBy[r.MessageID] = r.ReplyTo
	}
	var subs map[string]Subscriber
	for i := range msgs {
		if to, ok := replyBy[msgs[i].ID]; ok {
			t := to
			msgs[i].ReplyTo = &t
		}
		a, ok := askBy[msgs[i].ID]
		if !ok {
			continue
		}
		if subs == nil {
			var err error
			if subs, err = s.subscriberIndex(ctx, project); err != nil {
				return err
			}
		}
		info, err := s.askInfo(ctx, project, a, subs)
		if err != nil {
			return err
		}
		msgs[i].Ask = info
	}
	return nil
}

func (s *Store) askInfo(ctx context.Context, project string, a askRow, subs map[string]Subscriber) (*AskInfo, error) {
	var to []string
	_ = json.Unmarshal([]byte(a.Asked), &to)
	info := &AskInfo{To: to, Open: []string{}}
	for _, m := range to {
		done, err := s.answeredBy(ctx, project, a, m, subs)
		if err != nil {
			return nil, err
		}
		if !done {
			info.Open = append(info.Open, m)
		}
	}
	info.Answered = len(info.Open) == 0
	return info, nil
}

// AskUpdate is a question the reader already holds, with its state now: a new post may have answered it (#8200).
type AskUpdate struct {
	ID  int64    `json:"id"`
	Ask *AskInfo `json:"ask"`
}

// askUpdateScan is how many of the board's newest questions older than the page are checked for an answer in it.
const askUpdateScan = 200

// AskUpdates are the questions older than afterID (the newest message the reader already holds) that a post in msgs could have answered: those
// that ask one of the posters of msgs, with their state as of now (the same rule as a question's own ask field: who still owes an answer). The
// reader replaces the ask of those messages with it, so it never works out "answered" itself. A question that asks none of the posters is not
// listed; one listed may be unchanged. Questions that are in msgs carry their state already.
func (s *Store) AskUpdates(ctx context.Context, project string, afterID int64, msgs []Message) ([]AskUpdate, error) {
	if len(msgs) == 0 || afterID <= 0 {
		return nil, nil
	}
	posters := map[string]bool{}
	for _, m := range msgs {
		posters[strings.ToLower(m.SubscriberID)] = true
	}
	var asks []askRow
	if err := s.reader().SelectContext(ctx, &asks, `SELECT message_id, asker, asked, created_at FROM board_asks WHERE project = ? AND message_id <= ? ORDER BY message_id DESC LIMIT ?`, project, afterID, askUpdateScan); err != nil {
		return nil, err
	}
	var subs map[string]Subscriber
	var out []AskUpdate
	for i := len(asks) - 1; i >= 0; i-- { // oldest first
		a := asks[i]
		var to []string
		_ = json.Unmarshal([]byte(a.Asked), &to)
		hit := false
		for _, m := range to {
			if posters[strings.ToLower(m)] {
				hit = true
				break
			}
		}
		if !hit {
			continue
		}
		if subs == nil {
			var err error
			if subs, err = s.subscriberIndex(ctx, project); err != nil {
				return nil, err
			}
		}
		info, err := s.askInfo(ctx, project, a, subs)
		if err != nil {
			return nil, err
		}
		out = append(out, AskUpdate{ID: a.MessageID, Ask: info})
	}
	return out, nil
}

// OpenAsk is one member who has not answered a question.
type OpenAsk struct {
	MessageID int64
	Asker     string
	Member    string
	Content   string
	At        time.Time
}

// OpenAsks are the unanswered questions of the board asked less than askMaxAge ago, one row per member still owing, oldest first. A member who has left the board is not asked.
func (s *Store) OpenAsks(ctx context.Context, project string, now time.Time) ([]OpenAsk, error) {
	var asks []askRow
	if err := s.reader().SelectContext(ctx, &asks, `SELECT message_id, asker, asked, created_at FROM board_asks WHERE project = ? AND created_at > ? ORDER BY message_id`, project, now.Add(-askMaxAge).UTC().Format(time.RFC3339)); err != nil {
		return nil, err
	}
	if len(asks) == 0 {
		return nil, nil
	}
	subs, err := s.subscriberIndex(ctx, project)
	if err != nil {
		return nil, err
	}
	var out []OpenAsk
	for _, a := range asks {
		info, err := s.askInfo(ctx, project, a, subs)
		if err != nil {
			return nil, err
		}
		var content string
		_ = s.reader().GetContext(ctx, &content, `SELECT content FROM board_messages WHERE project = ? AND id = ?`, project, a.MessageID)
		at, _ := time.Parse(time.RFC3339, a.CreatedAt)
		for _, m := range info.Open {
			if _, member := subs[strings.ToLower(m)]; !member {
				continue
			}
			out = append(out, OpenAsk{MessageID: a.MessageID, Asker: a.Asker, Member: m, Content: content, At: at})
		}
	}
	return out, nil
}

// withAsks fills the asks of msgs after a read, passing the read's own error through.
func (s *Store) withAsks(ctx context.Context, project string, msgs []Message, err error) ([]Message, error) {
	if err != nil {
		return msgs, err
	}
	if ferr := s.fillAsks(ctx, project, msgs); ferr != nil {
		return nil, fmt.Errorf("asks: %w", ferr)
	}
	return msgs, nil
}
