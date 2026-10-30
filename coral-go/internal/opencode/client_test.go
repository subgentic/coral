package opencode

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// standIn is an opencode server as far as Coral reads it: the message API of a session and the event stream, behind HTTP Basic auth with the password Coral generated.
type standIn struct {
	*httptest.Server
	password string
	events   chan string
	queries  chan string
}

func newStandIn(t *testing.T, password string) *standIn {
	t.Helper()
	s := &standIn{password: password, events: make(chan string, 16), queries: make(chan string, 16)}
	mux := http.NewServeMux()
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if u, p, ok := r.BasicAuth(); !ok || u != Username || p != password {
				http.Error(w, "no", http.StatusUnauthorized)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/api/session/ses_abc123/message", auth(func(w http.ResponseWriter, r *http.Request) {
		s.queries <- r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"items":[
			{"id":"m3","type":"idle","outcome":"succeeded"},
			{"id":"m2","type":"assistant","content":[{"type":"text","text":"The tests pass."},{"type":"tool","text":"ignored"}],"time":{"created":"2026-10-30T10:00:05Z"}},
			{"id":"m1","type":"user","text":"run the tests","time":{"created":"2026-10-30T10:00:00Z"}}
		],"next":"cur2"}`)
	}))
	mux.HandleFunc("/api/event", auth(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl := w.(http.Flusher)
		fl.Flush()
		for {
			select {
			case f := <-s.events:
				fmt.Fprint(w, f)
				fl.Flush()
			case <-r.Context().Done():
				return
			}
		}
	}))
	s.Server = httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func TestMessagesAreReadThroughTheAPIWithItsPassword(t *testing.T) {
	s := newStandIn(t, "s3cret")
	c, err := New(s.URL, "s3cret")
	require.NoError(t, err)
	p, err := c.Messages(context.Background(), "ses_abc123", MessagesOpts{Desc: true, Limit: 20, Cursor: "cur1"})
	require.NoError(t, err)
	assert.Equal(t, "cur1", queryOf(t, <-s.queries, "cursor"))
	require.Len(t, p.Messages, 2, "the idle marker is not a message")
	assert.Equal(t, Message{ID: "m2", Role: "assistant", Text: "The tests pass.", At: "2026-10-30T10:00:05Z"}, p.Messages[0], "text blocks only")
	assert.Equal(t, "run the tests", p.Messages[1].Text)
	assert.Equal(t, "cur2", p.Next)

	last, ok, err := c.LastMessage(context.Background(), "ses_abc123")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, "The tests pass.", last.Text, "the newest with text")

	bad, err := New(s.URL, "wrong")
	require.NoError(t, err)
	_, err = bad.Messages(context.Background(), "ses_abc123", MessagesOpts{})
	assert.ErrorContains(t, err, "HTTP 401", "a server that wants another password is refused")
}

func queryOf(t *testing.T, raw, key string) string {
	t.Helper()
	for _, kv := range strings.Split(raw, "&") {
		if k, v, _ := strings.Cut(kv, "="); k == key {
			return v
		}
	}
	return ""
}

func TestTheClientRefusesAServerThatIsNotOnThisComputerAndASessionIdThatIsNotOne(t *testing.T) {
	for _, base := range []string{"http://example.com:4096", "http://10.0.0.5:4096", "https://127.0.0.1:4096", "127.0.0.1:4096", ""} {
		_, err := New(base, "p")
		assert.Error(t, err, base)
	}
	_, err := New("http://example.com", "p")
	assert.ErrorIs(t, err, ErrNotLoopback, "the password never leaves this computer")
	for _, base := range []string{"http://127.0.0.1:4096", "http://localhost:4096", "http://[::1]:4096"} {
		_, err := New(base, "p")
		assert.NoError(t, err, base)
	}
	c, err := New("http://127.0.0.1:1", "p")
	require.NoError(t, err)
	for _, id := range []string{"", "x", "ses_", "../ses_abc", "ses_a/b", "ses_a b", "ses_a?x=1", strings.Repeat("a", 200)} {
		_, err := c.Messages(context.Background(), id, MessagesOpts{})
		assert.ErrorContains(t, err, "not a session id", "%q is not put into a URL", id)
	}
}

func TestTheEventStreamDrivesTheStateOfEachSession(t *testing.T) {
	s := newStandIn(t, "pw")
	c, err := New(s.URL, "pw")
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got := make(chan [2]string, 8)
	tr := NewTracker()
	done := make(chan error, 1)
	go func() {
		done <- c.Events(ctx, func(e Event) {
			if sess, to, moved := tr.Apply(e); moved {
				got <- [2]string{sess, string(to)}
			}
		})
	}()
	for _, f := range []string{
		": keep-alive\n\n",
		"data: {\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_abc123\",\"status\":{\"type\":\"busy\"}}}\n\n",
		"event: session.text.delta\ndata: {\"sessionID\":\"ses_abc123\",\"text\":\"hi\"}\n\n", // says nothing about the state
		"data: not json\n\n",
		"data: {\"type\":\"permission.asked\",\"sessionID\":\"ses_abc123\"}\n\n",
		"event: session.idle\ndata: {\"sessionID\":\"ses_abc123\"}\n\n",
		"data: {\"type\":\"session.status\",\"sessionID\":\"../etc\",\"status\":\"busy\"}\n\n", // not a session id: ignored
	} {
		s.events <- f
	}
	for _, want := range [][2]string{{"ses_abc123", "working"}, {"ses_abc123", "needs_input"}, {"ses_abc123", "idle"}} {
		select {
		case g := <-got:
			assert.Equal(t, want, g)
		case <-time.After(3 * time.Second):
			t.Fatalf("no event for %v", want)
		}
	}
	assert.Equal(t, StateIdle, tr.State("ses_abc123"))
	tr.Reset()
	assert.Equal(t, State(""), tr.State("ses_abc123"), "a gap in the stream forgets what was known")
	cancel()
	<-done
}

func TestStateOfNamesTheEventsThatMoveASession(t *testing.T) {
	for e, want := range map[Event]State{
		{Type: "session.status", Status: "busy"}: StateWorking,
		{Type: "session.status", Status: "idle"}: StateIdle,
		{Type: "session.idle"}:                   StateIdle,
		{Type: "session.execution.started"}:      StateWorking,
		{Type: "session.execution.succeeded"}:    StateIdle,
		{Type: "session.execution.interrupted"}:  StateIdle,
		{Type: "session.execution.failed"}:       StateFailed,
		{Type: "permission.asked"}:               StateNeedsInput,
		{Type: "permission.replied"}:             StateWorking,
	} {
		got, ok := StateOf(e)
		assert.True(t, ok, e.Type)
		assert.Equal(t, want, got, "%s %s", e.Type, e.Status)
	}
	for _, e := range []Event{{Type: "session.text.delta"}, {Type: "session.tool.started"}, {Type: "session.status", Status: "weird"}, {Type: ""}} {
		_, ok := StateOf(e)
		assert.False(t, ok, e.Type+" "+e.Status)
	}
}
