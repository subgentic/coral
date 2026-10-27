package board

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/querypage"
)

// The board message search (#4745): GET /api/board/{project}/messages/search. Like the Team Artifacts query it takes q, since, until,
// sort and cursor, and answers with total and next_cursor (and prev_cursor: it pages both ways). The text and the names are matched in
// Go on the rows the time bounds leave, on what a viewer sees (MessageQuery.Shown). A plain ASCII text search is narrowed by SQL first
// (queryTextInSQL: a bound, escaped LIKE parameter, so nothing a caller sends reaches a statement and % and _ are ordinary characters);
// the Go scan answers every other query and every case where LIKE and Go's match could differ. The scan is bounded by rows and by text.

const (
	MessageQueryDefaultLimit = 50
	MessageQueryMaxLimit     = 200
	MessageQueryMaxTextLen   = 200
	messageQueryMaxValues    = 50
)

// messageScanRows and messageScanBytes bound one search's scan: the messages read and the text of them. Past either the scan stops and
// the reply says Truncated. Variables so a test can lower them.
var (
	messageScanRows  = 200000
	messageScanBytes = 64 << 20
)

var ErrMessageQuery = errors.New("invalid message query")

func messageQueryErr(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrMessageQuery, fmt.Sprintf(format, a...))
}

// MessageQueryParams are the raw values of a request, one slice per parameter.
type MessageQueryParams struct {
	Q, From, Mentions, Since, Until, Sort, Limit, Cursor []string
	ForSubscriber                                        []string // the member whose list is searched: what its read delivers and its own posts (ReadSetIDs, #8484)
}

// MessageQuery is a validated query. Build it with ParseMessageQuery; the caller sets Project and, for a request through Coral Hub,
// Shown (what a viewer sees of a text: the match is made on it; nil is the text as stored).
type MessageQuery struct {
	Project       string
	Text          string   // lower-cased; empty: no text search
	From          []string // lower-cased sender ids or names
	Mentions      string   // lower-cased: messages that tag this member
	ForSubscriber string   // the member's id as given: only the messages of its list (ReadSetIDs) are searched
	Since         string   // created_at >= (UTC RFC 3339)
	Until         string   // created_at <  (UTC RFC 3339)
	Oldest        bool     // sort=oldest; the default is newest first
	Limit         int
	Shown         func(string) string
	cursor        *messageCursor
	finger        string
}

type messageCursor struct {
	Finger string `json:"f"`
	ID     int64  `json:"i"`
	Prev   bool   `json:"p,omitempty"` // the page before ID, not the one after it
}

func (c messageCursor) encode() string {
	raw, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeMessageCursor(s string) (*messageCursor, error) {
	if len(s) > 512 {
		return nil, errors.New("long")
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	var c messageCursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	if c.ID <= 0 || c.Finger == "" {
		return nil, errors.New("bad")
	}
	return &c, nil
}

func messageSingle(name string, vals []string) (string, bool, error) {
	switch len(vals) {
	case 0:
		return "", false, nil
	case 1:
		return vals[0], true, nil
	}
	return "", false, messageQueryErr("%s is given more than once", name)
}

func messageText(name string, vals []string, max int) (string, error) {
	v, ok, err := messageSingle(name, vals)
	if err != nil || !ok {
		return "", err
	}
	if querypage.HasControl(v) {
		return "", messageQueryErr("%s is at most %d characters, without control characters", name, max)
	}
	v = strings.TrimSpace(v)
	if len(v) > max {
		return "", messageQueryErr("%s is at most %d characters, without control characters", name, max)
	}
	return strings.ToLower(v), nil
}

func messageTime(name string, vals []string) (string, error) {
	v, ok, err := messageSingle(name, vals)
	if err != nil || !ok {
		return "", err
	}
	t, perr := time.Parse(time.RFC3339, v)
	if perr != nil {
		return "", messageQueryErr("%s must be an RFC 3339 time, for example 2026-10-18T00:00:00Z", name)
	}
	return t.UTC().Format(time.RFC3339), nil
}

// ParseMessageQuery validates the raw parameters; the error names what was wrong.
func ParseMessageQuery(p MessageQueryParams) (*MessageQuery, error) {
	q := &MessageQuery{}
	var err error
	if q.Text, err = messageText("q", p.Q, MessageQueryMaxTextLen); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, v := range p.From {
		if querypage.HasControl(v) {
			return nil, messageQueryErr("from has a value over 200 characters or with control characters")
		}
		for _, part := range strings.Split(v, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				return nil, messageQueryErr("from has an empty value")
			}
			if len(part) > 200 {
				return nil, messageQueryErr("from has a value over 200 characters or with control characters")
			}
			if l := strings.ToLower(part); !seen[l] {
				seen[l] = true
				q.From = append(q.From, l)
			}
		}
	}
	if len(q.From) > messageQueryMaxValues {
		return nil, messageQueryErr("from has more than %d values", messageQueryMaxValues)
	}
	if q.Mentions, err = messageText("mentions", p.Mentions, 200); err != nil {
		return nil, err
	}
	if v, ok, ferr := messageSingle("for_subscriber", p.ForSubscriber); ferr != nil {
		return nil, ferr
	} else if ok {
		v = strings.TrimSpace(v)
		if v == "" || len(v) > 200 || querypage.HasControl(v) {
			return nil, messageQueryErr("for_subscriber must name a member, at most 200 characters, without control characters")
		}
		q.ForSubscriber = v
	}
	if q.Since, err = messageTime("since", p.Since); err != nil {
		return nil, err
	}
	if q.Until, err = messageTime("until", p.Until); err != nil {
		return nil, err
	}
	if v, ok, serr := messageSingle("sort", p.Sort); serr != nil {
		return nil, serr
	} else if ok {
		switch v {
		case "newest":
		case "oldest":
			q.Oldest = true
		default:
			return nil, messageQueryErr("unknown sort %s (newest or oldest)", v)
		}
	}
	q.Limit = MessageQueryDefaultLimit
	if v, ok, serr := messageSingle("limit", p.Limit); serr != nil {
		return nil, serr
	} else if ok {
		n := 0
		if _, scanErr := fmt.Sscanf(v, "%d", &n); scanErr != nil || fmt.Sprint(n) != v || n < 1 || n > MessageQueryMaxLimit {
			return nil, messageQueryErr("limit must be a whole number from 1 to %d", MessageQueryMaxLimit)
		}
		q.Limit = n
	}
	// What a cursor is tied to: every filter and the sort (not the limit, nor the cursor itself).
	fp := sha256.New()
	fmt.Fprintf(fp, "%s|%v|%s|%s|%s|%v|%s", q.Text, q.From, q.Mentions, q.Since, q.Until, q.Oldest, q.ForSubscriber)
	q.finger = hex.EncodeToString(fp.Sum(nil))[:16]
	if v, ok, serr := messageSingle("cursor", p.Cursor); serr != nil {
		return nil, serr
	} else if ok {
		c, cerr := decodeMessageCursor(v)
		if cerr != nil {
			return nil, messageQueryErr("cursor is not one this server gave")
		}
		if c.Finger != q.finger {
			return nil, messageQueryErr("cursor was made for other filters or another sort")
		}
		q.cursor = c
	}
	return q, nil
}

// MessageQueryResult is one page, in the query's order. Total is every message that matches, whatever the page; Truncated says the scan
// stopped at its bound, so the total and the pages are those of what it read.
type MessageQueryResult struct {
	Messages   []Message
	Total      int
	NextCursor string // the page after the last message, when there is one
	PrevCursor string // the page before the first message, when there is one
	Truncated  bool
}

func (q *MessageQuery) shown(s string) string {
	if q.Shown == nil || s == "" {
		return s
	}
	return q.Shown(s)
}

// QueryMessages runs q. The messages the time bounds leave are read once, in the query's order (bounded), each is tested, and the
// page is cut out of the matches around the cursor.
func (s *Store) QueryMessages(ctx context.Context, q *MessageQuery) (*MessageQueryResult, error) {
	var mentionID, mentionTitle string
	var numbered map[string]bool
	if q.Mentions != "" {
		mentionID, mentionTitle = q.Mentions, q.Mentions
		if subs, err := s.ListSubscribers(ctx, q.Project); err == nil {
			for _, sub := range subs {
				if strings.EqualFold(sub.SubscriberID, q.Mentions) || strings.EqualFold(sub.JobTitle, q.Mentions) {
					mentionID, mentionTitle = sub.SubscriberID, sub.JobTitle
					break
				}
			}
		}
		numbered = s.numberedNames(ctx, s.reader(), q.Project)
	}
	var allowed map[int64]bool // the member's list (ReadSetIDs): a message outside it matches nothing
	if q.ForSubscriber != "" {
		ids, err := s.ReadSetIDs(ctx, q.Project, q.ForSubscriber)
		if err != nil {
			return nil, err
		}
		allowed = make(map[int64]bool, len(ids))
		for _, id := range ids {
			allowed[id] = true
		}
	}
	where := []string{"m.project = ?"}
	args := []any{q.Project}
	if q.Since != "" {
		where = append(where, "m.created_at >= ?")
		args = append(args, q.Since)
	}
	if q.Until != "" {
		where = append(where, "m.created_at < ?")
		args = append(args, q.Until)
	}
	dir := "DESC"
	if q.Oldest {
		dir = "ASC"
	}
	if q.sqlTextOnly(allowed) {
		if res, ok, err := s.queryTextInSQL(ctx, q, where, args, dir); err != nil || ok {
			return res, err
		}
	}
	rows, err := s.reader().QueryxContext(ctx, listMessagesSelect+" WHERE "+strings.Join(where, " AND ")+" ORDER BY m.id "+dir, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	pg := q.pager()
	res := &MessageQueryResult{}
	scannedRows, scannedBytes := 0, 0
	for rows.Next() {
		var m Message
		if err := rows.StructScan(&m); err != nil {
			return nil, err
		}
		if scannedRows++; scannedRows > messageScanRows || scannedBytes+len(m.Content) > messageScanBytes {
			res.Truncated = true
			break
		}
		scannedBytes += len(m.Content)
		if allowed != nil && !allowed[m.ID] {
			continue
		}
		if q.matches(m, mentionID, mentionTitle, numbered) {
			pg.Add(m)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	q.fill(res, pg)
	return res, nil
}

// pager is the page cutter around the query's cursor, in the query's order.
func (q *MessageQuery) pager() *querypage.Pager[Message] {
	pg := &querypage.Pager[Message]{Limit: q.Limit}
	if q.cursor != nil {
		cur := q.cursor.ID
		pg.Prev = q.cursor.Prev
		pg.After = func(m Message) bool { // the message comes after the cursor in the query's order
			if q.Oldest {
				return m.ID > cur
			}
			return m.ID < cur
		}
		pg.AtCursor = func(m Message) bool { return m.ID == cur }
	}
	return pg
}

// fill sets the result's page, total and cursors from a finished pager.
func (q *MessageQuery) fill(res *MessageQueryResult, pg *querypage.Pager[Message]) {
	res.Total = pg.Total
	res.Messages = pg.Page
	if res.Messages == nil {
		res.Messages = []Message{}
	}
	if pg.HasNext() {
		res.NextCursor = messageCursor{Finger: q.finger, ID: pg.Page[len(pg.Page)-1].ID}.encode()
	}
	if pg.HasPrev() {
		res.PrevCursor = messageCursor{Finger: q.finger, ID: pg.Page[0].ID, Prev: true}.encode()
	}
}

// sqlTextOnly says the query is a plain text search the database can narrow: an ASCII needle, no sender, mention or member list, and
// no redaction (a tunneled viewer matches on the redacted text, which only Go computes).
func (q *MessageQuery) sqlTextOnly(allowed map[int64]bool) bool {
	if q.Text == "" || len(q.From) > 0 || q.Mentions != "" || allowed != nil || q.Shown != nil {
		return false
	}
	for i := 0; i < len(q.Text); i++ {
		if q.Text[i] >= 0x80 {
			return false
		}
	}
	return true
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// queryTextInSQL answers a text search with LIKE (ASCII case-folded, as the Go match is for an ASCII needle) so only the ids of the
// matches reach Go; the page's rows are read after. ok is false when the Go scan must answer instead: the scan caps would truncate the
// board, a message holds a NUL byte, or the needle has an i or k and a message holds U+0130 or U+212A (which Go's ToLower folds to i and k; LIKE does not).
func (s *Store) queryTextInSQL(ctx context.Context, q *MessageQuery, where []string, args []any, dir string) (*MessageQueryResult, bool, error) {
	w := " WHERE " + strings.Join(where, " AND ")
	var n, bytes int64
	if err := s.reader().QueryRowxContext(ctx, "SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(m.content AS BLOB))), 0) FROM board_messages m"+w, args...).Scan(&n, &bytes); err != nil {
		return nil, false, err
	}
	if n > int64(messageScanRows) || bytes > int64(messageScanBytes) {
		return nil, false, nil
	}
	// Where LIKE and Go's match differ, Go answers: a NUL byte (LIKE stops reading a text at it), and for a needle with an i or k, U+0130
	// and U+212A (Go folds them to i and k; LIKE does not).
	odd := "instr(CAST(m.content AS BLOB), CAST(char(0) AS BLOB)) > 0"
	if strings.ContainsAny(q.Text, "ik") {
		odd += " OR instr(m.content, char(304)) > 0 OR instr(m.content, char(8490)) > 0"
	}
	var differs int
	if err := s.reader().QueryRowxContext(ctx, "SELECT EXISTS(SELECT 1 FROM board_messages m"+w+" AND ("+odd+"))", args...).Scan(&differs); err != nil || differs != 0 {
		return nil, false, err
	}
	likeArgs := append(append([]any{}, args...), "%"+likeEscaper.Replace(q.Text)+"%")
	var ids []int64
	if err := s.reader().SelectContext(ctx, &ids, "SELECT m.id FROM board_messages m"+w+` AND m.content LIKE ? ESCAPE '\' ORDER BY m.id `+dir, likeArgs...); err != nil {
		return nil, false, err
	}
	pg := q.pager()
	for _, id := range ids {
		pg.Add(Message{ID: id})
	}
	byID := make(map[int64]Message, len(pg.Page))
	for i := 0; i < len(pg.Page); i += 500 {
		end := min(i+500, len(pg.Page))
		marks, in := make([]string, 0, end-i), make([]any, 0, end-i)
		for _, m := range pg.Page[i:end] {
			marks, in = append(marks, "?"), append(in, m.ID)
		}
		var rows []Message
		if err := s.reader().SelectContext(ctx, &rows, listMessagesSelect+" WHERE m.id IN ("+strings.Join(marks, ",")+")", in...); err != nil {
			return nil, false, err
		}
		for _, m := range rows {
			byID[m.ID] = m
		}
	}
	for i, m := range pg.Page {
		pg.Page[i] = byID[m.ID]
	}
	res := &MessageQueryResult{}
	q.fill(res, pg)
	return res, true, nil
}

// matches reports whether m passes every filter: the sender, the member it tags, and the text, each as a viewer sees it.
func (q *MessageQuery) matches(m Message, mentionID, mentionTitle string, numbered map[string]bool) bool {
	if len(q.From) > 0 {
		id, title := strings.ToLower(q.shown(m.SubscriberID)), strings.ToLower(q.shown(m.JobTitle))
		ok := false
		for _, f := range q.From {
			ok = ok || f == id || f == title
		}
		if !ok {
			return false
		}
	}
	content := m.Content
	if q.Shown != nil {
		content = q.Shown(content)
	}
	if q.Mentions != "" && !containsExplicitTag(content, mentionID, mentionTitle, numbered) {
		return false
	}
	if q.Text != "" && !textHasFold(content, q.Text) {
		return false
	}
	return true
}
