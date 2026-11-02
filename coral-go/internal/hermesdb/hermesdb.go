// Package hermesdb reads a Hermes Agent's own session store, $HERMES_HOME/state.db (#11831; checked on Hermes v0.22.5, schema_version 32): a SQLite database in WAL mode, where a session is a row of
// sessions and its turns are rows of messages. Hermes keeps no transcript file.
//
// The database is the agent's: everything in it is untrusted text (a message is whatever the model or a tool said, a title whatever the person typed). The reader therefore opens it read-only (mode=ro and
// query_only: nothing is created, no schema step, no write), only through a folder that resolves to a real one and a state.db that is a regular file and not a link, asks only for rows of the one session id it is
// given (which must be a Hermes id), cuts every text and bounds every read, and answers soft: a schema that lacks a column it needs is ErrSchema, never a panic or a guess. The caller redacts what it shows.
package hermesdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

// ErrNoStore is a home with no state.db (Hermes has not run there yet). ErrSchema is a database whose tables lack a column the reader needs (a newer Hermes changed them).
var (
	ErrNoStore    = errors.New("hermes: no state.db")
	ErrSchema     = errors.New("hermes: state.db has a layout Coral does not read")
	ErrBadID      = errors.New("hermes: not a session id")
	ErrNotRegular = errors.New("hermes: state.db is not a regular file")
)

const (
	// MaxMessages is the most rows one read returns (the newest); MaxText the most bytes of one text kept (a message, a tool's arguments, a title).
	MaxMessages = 5000
	MaxText     = 1 << 20
	// MaxBytes is the most text (content, tool calls, names and ids) one read returns in all: the newest rows are kept until it is reached and the older ones are left out, so a database of large rows is never read
	// whole (a tool that printed megabytes, again and again, #12040). One row can be at most a few MiB (each text is cut at MaxText), well inside it.
	MaxBytes = 16 << 20
	// queryTimeout bounds one read: a database another process holds locked does not hold a poll of the chat.
	queryTimeout = 5 * time.Second
)

var sessionRe = regexp.MustCompile(`^local-[0-9a-f]{64}$`)

// IsSessionID reports whether id is a Hermes session id: local- and exactly 64 lowercase hex digits (the one form `hermes chat` writes, and the only one --resume takes).
func IsSessionID(id string) bool { return sessionRe.MatchString(id) }

// Session is the row of one session, the columns Coral reads.
type Session struct {
	ID           string
	Model        string
	CWD          string
	Title        string
	Source       string
	StartedAt    float64 // epoch seconds
	LastActivity float64 // epoch seconds; 0 when the row has none
	EndedAt      float64 // 0 until the process exits
	MessageCount int
	InputTokens  int64
	OutputTokens int64
}

// Message is the row of one turn: role user, assistant or tool; ToolCalls the assistant's calls as Hermes wrote them (JSON, OpenAI shape); ToolName and ToolCallID on a tool's result.
type Message struct {
	ID           int64
	Role         string
	Content      string
	ToolCalls    string
	ToolName     string
	ToolCallID   string
	At           float64 // epoch seconds
	FinishReason string
}

// DB is an open, read-only view of one state.db.
type DB struct {
	db   *sql.DB
	cols map[string]map[string]bool // table -> column set, from PRAGMA table_info
}

// Path is the state.db a home holds: home resolved (links followed, so a HERMES_HOME that is a link names the folder it points at), then state.db, which must be a regular file and not itself a link.
func Path(home string) (string, error) {
	if home == "" {
		return "", ErrNoStore
	}
	real, err := filepath.EvalSymlinks(home)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrNoStore
		}
		return "", err
	}
	p := filepath.Join(real, "state.db")
	fi, err := os.Lstat(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrNoStore
		}
		return "", err
	}
	if !fi.Mode().IsRegular() {
		return "", ErrNotRegular
	}
	return p, nil
}

// Open opens home's state.db read-only and checks its layout.
func Open(home string) (*DB, error) {
	p, err := Path(home)
	if err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(p), "/"), RawQuery: "mode=ro&_pragma=busy_timeout(3000)&_pragma=query_only(1)&_pragma=trusted_schema(0)"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	d := &DB{db: db, cols: map[string]map[string]bool{}}
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	for table, need := range required {
		have, err := d.columns(ctx, table)
		if err != nil {
			db.Close()
			return nil, err
		}
		for _, c := range need {
			if !have[c] {
				db.Close()
				return nil, fmt.Errorf("%w: %s.%s is missing", ErrSchema, table, c)
			}
		}
		d.cols[table] = have
	}
	return d, nil
}

// required are the columns the reader names, pinned to what Hermes v0.22.5 has (schema_version 32).
var required = map[string][]string{
	"sessions": {"id", "model", "started_at"},
	"messages": {"id", "session_id", "role", "content", "tool_calls", "tool_name", "tool_call_id", "timestamp"},
}

func (d *DB) columns(ctx context.Context, table string) (map[string]bool, error) {
	rows, err := d.db.QueryContext(ctx, "PRAGMA table_info("+table+")") // table is one of the constants above
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	have := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			return nil, err
		}
		have[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(have) == 0 {
		return nil, fmt.Errorf("%w: no table %s", ErrSchema, table)
	}
	return have, nil
}

// Close closes the database.
func (d *DB) Close() error { return d.db.Close() }

// cut is s cut to MaxText bytes at a rune boundary.
func cut(s string) string {
	if len(s) <= MaxText {
		return s
	}
	n := MaxText
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// optional is the column's name when the table has it, else the literal NULL (a column newer or older Hermes versions may lack).
func (d *DB) optional(table, col string) string {
	if d.cols[table][col] {
		return col
	}
	return "NULL"
}

// Session reads the row of session id; ok is false when there is none. id must be a Hermes id.
func (d *DB) Session(ctx context.Context, id string) (s Session, ok bool, err error) {
	if !IsSessionID(id) {
		return s, false, ErrBadID
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	q := fmt.Sprintf("SELECT id, model, %s, %s, %s, started_at, %s, %s, %s, %s, %s FROM sessions WHERE id = ?",
		d.optional("sessions", "cwd"), d.optional("sessions", "title"), d.optional("sessions", "source"),
		d.optional("sessions", "last_activity_at"), d.optional("sessions", "ended_at"), d.optional("sessions", "message_count"),
		d.optional("sessions", "input_tokens"), d.optional("sessions", "output_tokens"))
	var model, cwd, title, source sql.NullString
	var started, last, ended sql.NullFloat64
	var count, in, out sql.NullInt64
	err = d.db.QueryRowContext(ctx, q, id).Scan(&s.ID, &model, &cwd, &title, &source, &started, &last, &ended, &count, &in, &out)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, false, nil
	}
	if err != nil {
		return Session{}, false, err
	}
	s.Model, s.CWD, s.Title, s.Source = cut(model.String), cut(cwd.String), cut(title.String), cut(source.String)
	s.StartedAt, s.LastActivity, s.EndedAt = started.Float64, last.Float64, ended.Float64
	s.MessageCount, s.InputTokens, s.OutputTokens = int(count.Int64), in.Int64, out.Int64
	return s, true, nil
}

// Messages reads the newest limit rows (at most MaxMessages) of session id with an id above afterID, oldest first, and at most MaxBytes of text in all (the newest rows are kept, the older left out). Only rows of
// that session: the query names it, and a row whose own session_id differs is never returned. A row Hermes marked inactive (active = 0, a turn it dropped from the conversation) is left out when the table has the
// column. Each text is cut inside SQLite (a few bytes past MaxText, then at a rune boundary here), so one huge cell is never loaded whole.
func (d *DB) Messages(ctx context.Context, id string, afterID int64, limit int) ([]Message, error) {
	if !IsSessionID(id) {
		return nil, ErrBadID
	}
	if limit <= 0 || limit > MaxMessages {
		limit = MaxMessages
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	active := ""
	if d.cols["messages"]["active"] {
		active = " AND COALESCE(active, 1) <> 0"
	}
	part := func(col string) string { return fmt.Sprintf("substr(CAST(%s AS BLOB), 1, %d)", col, MaxText+4) } // bytes, not characters: bounded whatever the text is
	q := fmt.Sprintf(`SELECT id, substr(role, 1, 64), %s, %s, %s, %s, timestamp, %s FROM messages WHERE session_id = ? AND id > ?%s ORDER BY id DESC LIMIT ?`,
		part("content"), part("tool_calls"), part("tool_name"), part("tool_call_id"), part(d.optional("messages", "finish_reason")), active)
	rows, err := d.db.QueryContext(ctx, q, id, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message // newest first while reading
	bytes := 0
	for rows.Next() {
		var m Message
		var content, calls, name, callID, finish []byte
		var ts sql.NullFloat64
		if err := rows.Scan(&m.ID, &m.Role, &content, &calls, &name, &callID, &ts, &finish); err != nil {
			return nil, err
		}
		m.Content, m.ToolCalls, m.ToolName, m.ToolCallID, m.FinishReason = cut(string(content)), cut(string(calls)), cut(string(name)), cut(string(callID)), cut(string(finish))
		m.At = ts.Float64
		bytes += len(m.Content) + len(m.ToolCalls) + len(m.ToolName) + len(m.ToolCallID) + len(m.FinishReason)
		if bytes > MaxBytes && len(out) > 0 {
			break // the older rows do not fit: the newest are what a chat and a search want
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 { // oldest first, as callers read them
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}
