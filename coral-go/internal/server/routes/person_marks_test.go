package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// #10004: the funnel's first message and first reply, worked out from a person's send and the agent's own hook events.

type funnelWatch struct {
	mu       sync.Mutex
	messages []string
	replies  []funnelReply
	wanted   bool
}

type funnelReply struct {
	provider string
	took     time.Duration
	outcome  string
}

func watchFunnel(t *testing.T, wanted bool) *funnelWatch {
	w := &funnelWatch{wanted: wanted}
	oldM, oldR, oldW := funnelFirstMessage, funnelFirstReply, funnelReplyWanted
	funnelFirstMessage = func(via string) { w.mu.Lock(); w.messages = append(w.messages, via); w.mu.Unlock() }
	funnelFirstReply = func(p string, d time.Duration, o string) {
		w.mu.Lock()
		w.replies = append(w.replies, funnelReply{p, d, o})
		w.mu.Unlock()
	}
	funnelReplyWanted = func() bool { return w.wanted }
	t.Cleanup(func() { funnelFirstMessage, funnelFirstReply, funnelReplyWanted = oldM, oldR, oldW })
	return w
}

func (w *funnelWatch) got() ([]string, []funnelReply) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]string(nil), w.messages...), append([]funnelReply(nil), w.replies...)
}

func stopEvent(id int64) *store.AgentEvent { return &store.AgentEvent{ID: id, EventType: "stop"} }

func TestPersonMarkIsTakenByTheFirstLaterStopOnly(t *testing.T) {
	var p personMarks
	now := time.Now()
	p.set("s1", personMark{at: now, base: 10})
	_, ok := p.take("s1", 10)
	assert.False(t, ok, "a stop that is not later than the message's event is an older turn's")
	_, ok = p.take("s1", 7)
	assert.False(t, ok)
	m, ok := p.take("s1", 11)
	assert.True(t, ok)
	assert.Equal(t, now, m.at)
	_, ok = p.take("s1", 12)
	assert.False(t, ok, "used up: one reply per message")
	_, ok = p.take("other", 99)
	assert.False(t, ok, "another session has none")

	p.set("s2", personMark{at: now, base: 0})
	p.set("s2", personMark{at: now.Add(5 * time.Second), base: 3})
	m, _ = p.take("s2", 4)
	assert.Equal(t, now, m.at, "the first message of the turn is the one measured from")
	p.set("s3", personMark{at: now})
	p.clear("s3")
	_, ok = p.take("s3", 5)
	assert.False(t, ok, "a reset or an end clears it")
}

func TestPersonMarksAreBounded(t *testing.T) {
	var p personMarks
	for i := 0; i < maxPersonMarks+50; i++ {
		p.set("s"+string(rune('A'+i%26))+time.Duration(i).String(), personMark{at: time.Now()})
		p.noteEnter("e"+time.Duration(i).String(), time.Now())
	}
	assert.LessOrEqual(t, len(p.marks), maxPersonMarks)
	assert.LessOrEqual(t, len(p.enters), maxPersonMarks)
}

func TestTerminalEnterCountsOnlyJustBeforeAPrompt(t *testing.T) {
	var p personMarks
	now := time.Now()
	p.noteEnter("s", now.Add(-3*time.Second))
	_, ok := p.takeEnter("s", now)
	assert.True(t, ok)
	_, ok = p.takeEnter("s", now)
	assert.False(t, ok, "used up")
	p.noteEnter("s", now.Add(-personMarkWindow-time.Second))
	_, ok = p.takeEnter("s", now)
	assert.False(t, ok, "an Enter long before is not this prompt's")
	p.noteEnter("", now)
	assert.Empty(t, p.enters, "no session, no mark")
}

func TestTheFirstStopAfterAPersonsMessageIsTheReply(t *testing.T) {
	w := watchFunnel(t, true)
	h := &SessionsHandler{}
	ctx := context.Background()
	h.notePersonMessage(ctx, "S", "composer_http", time.Now().Add(-12*time.Second))
	h.noteFunnelEvent(ctx, "S", "claude", "stop", nil, stopEvent(5))
	h.noteFunnelEvent(ctx, "S", "claude", "stop", nil, stopEvent(9))
	msgs, replies := w.got()
	assert.Equal(t, []string{"composer_http"}, msgs)
	require.Len(t, replies, 1, "one reply per mark")
	assert.Equal(t, "claude", replies[0].provider)
	assert.InDelta(t, 12, replies[0].took.Seconds(), 1.5, "measured from the send")
	assert.Equal(t, "ok", replies[0].outcome)
}

func TestAFailedTurnIsAnErrorReplyNeverAnOkOne(t *testing.T) {
	w := watchFunnel(t, true)
	h := &SessionsHandler{}
	ctx := context.Background()
	h.notePersonMessage(ctx, "S", "composer_ws", time.Now().Add(-2*time.Second))
	h.noteFunnelEvent(ctx, "S", "codex", "stop", map[string]any{"failed": true, "error": "rate limited: secret text"}, stopEvent(3))
	_, replies := w.got()
	require.Len(t, replies, 1)
	assert.Equal(t, "error", replies[0].outcome)
	assert.Equal(t, "codex", replies[0].provider)
}

func TestAResetOrEndForgetsAWaitingMessage(t *testing.T) {
	for _, ev := range []string{"session_reset", "session_end"} {
		w := watchFunnel(t, true)
		h := &SessionsHandler{}
		ctx := context.Background()
		h.notePersonMessage(ctx, "S", "composer_http", time.Now())
		h.noteFunnelEvent(ctx, "S", "claude", ev, nil, &store.AgentEvent{ID: 2, EventType: ev})
		h.noteFunnelEvent(ctx, "S", "claude", "stop", nil, stopEvent(3))
		_, replies := w.got()
		assert.Empty(t, replies, ev)
	}
}

func TestNothingIsMarkedOnceTheReplyHasBeenCounted(t *testing.T) {
	w := watchFunnel(t, false)
	h := &SessionsHandler{}
	ctx := context.Background()
	h.notePersonMessage(ctx, "S", "composer_http", time.Now())
	h.noteFunnelEvent(ctx, "S", "claude", "stop", nil, stopEvent(3))
	msgs, replies := w.got()
	assert.Equal(t, []string{"composer_http"}, msgs, "the first message is still reported (it is once per install on its own)")
	assert.Empty(t, replies)
	assert.Empty(t, h.person.marks, "and no mark is kept for an install that has nothing left to count")
}

func TestATerminalPromptIsThePersonsOnlyWithAnEnterJustBefore(t *testing.T) {
	w := watchFunnel(t, true)
	h := &SessionsHandler{}
	ctx := context.Background()
	// An agent's own prompt_submit (a board nudge, a held message typed by Coral): no Enter in the terminal view, so nobody typed it.
	h.noteFunnelEvent(ctx, "S", "claude", "prompt_submit", nil, &store.AgentEvent{ID: 1, EventType: "prompt_submit"})
	h.noteFunnelEvent(ctx, "S", "claude", "stop", nil, stopEvent(2))
	msgs, replies := w.got()
	assert.Empty(t, msgs)
	assert.Empty(t, replies)
	// A person pressed Enter in the terminal view, and the agent took a prompt.
	h.person.noteEnter("S", time.Now().Add(-time.Second))
	h.noteFunnelEvent(ctx, "S", "claude", "prompt_submit", nil, &store.AgentEvent{ID: 3, EventType: "prompt_submit"})
	h.noteFunnelEvent(ctx, "S", "claude", "stop", nil, stopEvent(4))
	msgs, replies = w.got()
	assert.Equal(t, []string{"terminal"}, msgs)
	assert.Len(t, replies, 1)
}

// The dashboard's own HTTP send, through the real handler: a person's message that the agent took is the first message, and the agent's next stop is the first reply.
func TestADashboardSendIsTheFirstMessageAndItsStopTheFirstReply(t *testing.T) {
	w := watchFunnel(t, true)
	_, handler, mock, ss := setupSessionsTestServer(t)
	sid := "eeeeeeee-4587-4000-8000-000000010004"
	agentType := "codex"
	name := naming.SessionName(agentType, sid)
	mock.addSession(name, "/tmp/project")
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: agentType, AgentName: "chat", WorkingDir: "/tmp/project"}))
	event := func(typ string) *store.AgentEvent {
		e, err := handler.ts.InsertAgentEvent(context.Background(), &store.AgentEvent{AgentName: name, SessionID: &sid, EventType: typ, Summary: typ})
		require.NoError(t, err)
		return e
	}
	event("stop") // an earlier turn
	term := &agentTerm{mockSessionTerminal: mock}
	handler.terminal = term
	handler.sendGate.set(func(tm *humanSendTimings) {
		tm.ReadyWait, tm.PollEvery, tm.EnterWait, tm.ConfirmWait, tm.SlowCommandWait = 400*time.Millisecond, 5*time.Millisecond, 30*time.Millisecond, 80*time.Millisecond, 400*time.Millisecond
	})
	term.show(codexReady(t, ""))
	term.onType = func(text string) { event("prompt_submit") } // the agent takes the prompt
	r := chi.NewRouter()
	r.Post("/api/sessions/live/{name}/send", handler.Send)
	b, _ := json.Marshal(map[string]any{"command": "hello", "agent_type": agentType, "session_id": sid})
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/send", bytes.NewReader(b))
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	msgs, replies := w.got()
	assert.Equal(t, []string{"composer_http"}, msgs)
	assert.Empty(t, replies, "no turn has ended yet")
	// The agent's own hook posts the stop that ends the turn.
	stop := event("stop")
	handler.noteFunnelEvent(context.Background(), sid, agentType, "stop", nil, stop)
	_, replies = w.got()
	require.Len(t, replies, 1)
	assert.Equal(t, "codex", replies[0].provider)
	assert.Equal(t, "ok", replies[0].outcome)
	assert.Less(t, replies[0].took, 10*time.Second)
}

// Typing in the terminal view: the socket notes only THAT an Enter was pressed (a time per session), never what was typed, and plain keystrokes note nothing.
type enterBackend struct{ ptymanager.TerminalBackend }

func (enterBackend) SendInput(terminalinput.Origin, string, []byte) error { return nil }

func TestTheTerminalSocketNotesAnEnterAndNeverWhatWasTyped(t *testing.T) {
	h := &SessionsHandler{backend: enterBackend{}}
	ts := &terminalStream{h: h, ctx: context.Background(), name: "n", agentType: "claude", sessionID: "S"}
	ts.handleFrame(terminalFrame{Type: "terminal_input", Data: "hello"})
	assert.Empty(t, h.person.enters, "keystrokes without an Enter note nothing")
	ts.handleFrame(terminalFrame{Type: "terminal_input", Data: "my secret prompt\r"})
	require.Len(t, h.person.enters, 1)
	_, ok := h.person.enters["S"]
	assert.True(t, ok)
	ts2 := &terminalStream{h: h, ctx: context.Background(), name: "n2", agentType: "claude", sessionID: "T"}
	ts2.handleFrame(terminalFrame{Type: "terminal_input", Data: "line\n"})
	_, ok = h.person.enters["T"]
	assert.True(t, ok, "a newline counts as Enter too")
}
