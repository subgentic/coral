package opencode

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// State is what an opencode session is doing, in Coral's words.
type State string

const (
	StateWorking    State = "working"
	StateIdle       State = "idle" // a turn ended: the person's turn
	StateNeedsInput State = "needs_input"
	StateFailed     State = "failed"
)

// Event is one frame of the server's event stream, reduced to what Coral reads: its type, the session it is for, and a status word when it carries one.
type Event struct {
	Type      string
	SessionID string
	Status    string
}

// maxFrame bounds one event frame: a frame over it is dropped, the stream goes on.
const maxFrame = 1 << 20

// frame is the JSON of a data line: the type and the session id may sit at the top, or under properties/data.
type frame struct {
	Type       string `json:"type"`
	SessionID  string `json:"sessionID"`
	Status     any    `json:"status"`
	Properties *frame `json:"properties"`
	Data       *frame `json:"data"`
}

func (f *frame) status() string {
	switch v := f.Status.(type) {
	case string:
		return v
	case map[string]any:
		if s, ok := v["type"].(string); ok {
			return s
		}
	}
	return ""
}

func parseFrame(sseType, data string) (Event, bool) {
	var f frame
	if json.Unmarshal([]byte(data), &f) != nil {
		return Event{}, false
	}
	e := Event{Type: f.Type, SessionID: f.SessionID, Status: f.status()}
	for _, in := range []*frame{f.Properties, f.Data} {
		if in == nil {
			continue
		}
		if e.Type == "" {
			e.Type = in.Type
		}
		if e.SessionID == "" {
			e.SessionID = in.SessionID
		}
		if e.Status == "" {
			e.Status = in.status()
		}
	}
	if e.Type == "" {
		e.Type = sseType
	}
	return e, e.Type != ""
}

// ParseStream reads a server-sent-events stream and calls fn for each event, until the stream ends or ctx is done. A frame that is not JSON or is too large is skipped; the stream is volatile by design, and
// the caller reconciles from the session after a gap.
func ParseStream(ctx context.Context, r io.Reader, fn func(Event)) error {
	br := bufio.NewReaderSize(r, 64<<10)
	var typ string
	var data []string
	size := 0
	dropped := false // the frame in progress is over maxFrame: it is skipped to its blank line
	flush := func() {
		if len(data) > 0 && !dropped {
			if e, ok := parseFrame(typ, strings.Join(data, "\n")); ok {
				fn(e)
			}
		}
		typ, data, size, dropped = "", nil, 0, false
	}
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line, tooLong, err := readLine(br, maxFrame)
		if tooLong {
			dropped, typ, data = true, "", nil
		}
		switch {
		case tooLong:
		case line == "":
			if err == nil {
				flush()
			}
		case strings.HasPrefix(line, ":"): // a comment: a keep-alive
		case strings.HasPrefix(line, "event:"):
			typ = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			if size += len(line); size > maxFrame {
				dropped, typ, data = true, "", nil
			} else if !dropped {
				data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
		if err != nil {
			flush()
			if err == io.EOF {
				return ctx.Err()
			}
			if ctx.Err() == nil {
				return err
			}
			return ctx.Err()
		}
	}
}

// readLine reads one line without its newline. A line over limit is read to its end and discarded, tooLong says so: the stream goes on at the next line, and no more than limit bytes are ever held.
func readLine(br *bufio.Reader, limit int) (line string, tooLong bool, err error) {
	var buf []byte
	for {
		chunk, e := br.ReadSlice('\n')
		if !tooLong {
			if len(buf)+len(chunk) > limit+1 {
				tooLong, buf = true, nil
			} else {
				buf = append(buf, chunk...)
			}
		}
		if e == bufio.ErrBufferFull {
			continue
		}
		err = e
		break
	}
	return strings.TrimRight(string(buf), "\r\n"), tooLong, err
}

// Events connects to the server's event stream (GET /api/event, or /event on 1.x: EventPath) and calls fn for each event until it ends.
func (c *Client) Events(ctx context.Context, fn func(Event)) error {
	cl := *c.http
	cl.Timeout = 0 // a stream has no end of its own
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + c.events
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(Username, c.password)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := cl.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("opencode: event stream: HTTP %d", resp.StatusCode)
	}
	return ParseStream(ctx, resp.Body, fn)
}

// StateOf is the state an event puts its session in (v2.2.4 sends session.execution.started and .succeeded, with .failed and .interrupted for the rest; session.status and session.idle are read too, for another build), and false for an event that says nothing about it (text and tool frames, steps, replies of other sessions).
func StateOf(e Event) (State, bool) {
	switch e.Type {
	case "session.status":
		switch e.Status {
		case "busy", "working", "running", "retry":
			return StateWorking, true
		case "idle":
			return StateIdle, true
		}
	case "session.idle", "session.execution.succeeded", "session.execution.interrupted":
		return StateIdle, true
	case "session.execution.failed":
		return StateFailed, true
	case "session.execution.started", "permission.replied":
		return StateWorking, true
	case "permission.asked":
		return StateNeedsInput, true
	}
	return "", false
}

// Tracker keeps the state of each session the event stream names. It is the one place a state is decided: Apply an event, State a session; Reset forgets what a gap in the stream made unknown, so the next
// reconcile (a read of the session's own state) is the truth again.
type Tracker struct {
	states map[string]State
}

func NewTracker() *Tracker { return &Tracker{states: map[string]State{}} }

// Apply notes an event; it reports the session and its new state when the event moved it.
func (t *Tracker) Apply(e Event) (session string, to State, moved bool) {
	to, ok := StateOf(e)
	if !ok || !validSessionID(e.SessionID) {
		return "", "", false
	}
	if t.states[e.SessionID] == to {
		return e.SessionID, to, false
	}
	if len(t.states) >= 4096 { // sessions that ended
		t.states = map[string]State{}
	}
	t.states[e.SessionID] = to
	return e.SessionID, to, true
}

// State is what a session was last known to be doing, "" when nothing has been seen.
func (t *Tracker) State(session string) State { return t.states[session] }

// Reset forgets every state: the stream dropped, and events may have been missed.
func (t *Tracker) Reset() { t.states = map[string]State{} }
