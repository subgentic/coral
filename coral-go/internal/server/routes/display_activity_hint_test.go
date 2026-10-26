package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

type displayHintTerminal struct {
	*agentTerm
	displayMu sync.Mutex
	readErr   error
	reads     int
	onRead    func()
}

func (s *displayHintTerminal) AgentScreen(ctx context.Context, name, agentType, id string) (string, error) {
	s.displayMu.Lock()
	s.reads++
	err := s.readErr
	onRead := s.onRead
	s.displayMu.Unlock()
	if err != nil {
		return "", err
	}
	screen, err := s.agentTerm.AgentScreen(ctx, name, agentType, id)
	if onRead != nil {
		onRead()
	}
	return screen, err
}
func displayFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "ptymanager", "testdata", "display_activity_hint", "codex-0.163.0", name))
	require.NoError(t, err)
	return string(b)
}
func displayRequest(at time.Time) []store.AgentEvent {
	detail := `{"kind":"permission","call_ids":["inner"]}`
	tool := "Bash"
	return []store.AgentEvent{{EventType: "permission_request", ToolName: &tool, DetailJSON: &detail, CreatedAt: at.Format(time.RFC3339Nano)}}
}
func displayRequestState(events []store.AgentEvent) SessionState {
	in := SessionStateInput{}
	for _, e := range events {
		in.Events = append(in.Events, e.StateEvent())
	}
	return DeriveSessionState(in)
}

func TestDisplayActivityHint7974FreshnessSettleAndEligibility(t *testing.T) {
	_, h, mock, _ := setupSessionsTestServer(t)
	term := &displayHintTerminal{agentTerm: &agentTerm{mockSessionTerminal: mock}}
	h.terminal = term
	stamp := &stampingBackend{stamp: "s1"}
	h.backend = stamp
	working := displayFixture(t, "approved-working.txt")
	term.show(working)
	now := time.Now()
	events := displayRequest(now.Add(-10 * time.Second))
	st := displayRequestState(events)
	hint, at := h.displayActivityHint("codex", "codex-probe", "probe", st, events, now)
	require.Equal(t, "working", hint)
	require.Equal(t, now.UTC().Format(time.RFC3339Nano), at)
	// A read is not retimestamped when reused.
	hint, at = h.displayActivityHint("codex", "codex-probe", "probe", st, events, now.Add(time.Second))
	require.Equal(t, "working", hint)
	require.Equal(t, now.UTC().Format(time.RFC3339Nano), at)
	require.Equal(t, 1, term.reads)
	// The same stamp is no license to reuse beyond TTL. A failed fresh read is attention.
	term.readErr = errors.New("unreadable")
	hint, at = h.displayActivityHint("codex", "codex-probe", "probe", st, events, now.Add(displayHintTTL))
	require.Nil(t, hint)
	require.Nil(t, at)
	require.Equal(t, 2, term.reads)
	term.readErr = nil
	h.displayScreens = displayScreenCache{}
	// A changed stamp invalidates even a young cached positive; the dialog wins.
	term.show(working)
	h.displayActivityHint("codex", "codex-probe", "probe", st, events, now)
	term.show(displayFixture(t, "exec-dialog.txt"))
	stamp.set("s2")
	hint, at = h.displayActivityHint("codex", "codex-probe", "probe", st, events, now.Add(time.Second))
	require.Nil(t, hint)
	require.Nil(t, at)
	term.show(working)
	stamp.set("s3")
	h.displayScreens = displayScreenCache{}
	// Every request starts settle time again, even while WaitingSince is older.
	newer := append(append([]store.AgentEvent{}, events...), displayRequest(now.Add(-time.Second))...)
	hint, at = h.displayActivityHint("codex", "codex-probe", "probe", displayRequestState(newer), newer, now)
	require.Nil(t, hint)
	require.Nil(t, at)
	for _, age := range []time.Duration{0, 2 * time.Second, displayHintSettle - time.Nanosecond} {
		e := displayRequest(now.Add(-age))
		hint, at = h.displayActivityHint("codex", "codex-probe", "probe", displayRequestState(e), e, now)
		require.Nil(t, hint)
		require.Nil(t, at)
	}
	// Long execution is not a reason to ask for attention again while fresh evidence exists.
	hint, _ = h.displayActivityHint("codex", "codex-probe", "probe", st, events, now.Add(10*time.Minute))
	require.Equal(t, "working", hint)
	for _, kind := range []string{"question", "plan", "login", "startup", "elicitation"} {
		t.Run(kind, func(t *testing.T) {
			other := st
			other.WaitingKind = kind
			hint, at = h.displayActivityHint("codex", "codex-probe", "probe", other, events, now)
			require.Nil(t, hint)
			require.Nil(t, at)
		})
	}
	held := st
	held.OwnRequest = false
	hint, _ = h.displayActivityHint("codex", "codex-probe", "probe", held, events, now)
	require.Nil(t, hint)
	question := `{"kind":"question"}`
	beside := append(append([]store.AgentEvent{}, events...), store.AgentEvent{EventType: "permission_request", DetailJSON: &question, CreatedAt: now.Add(-5 * time.Second).Format(time.RFC3339Nano)})
	hint, _ = h.displayActivityHint("codex", "codex-probe", "probe", displayRequestState(beside), beside, now)
	require.Nil(t, hint)
	for _, agentType := range []string{"claude", "gemini", "terminal"} {
		hint, _ = h.displayActivityHint(agentType, "probe", "probe", st, events, now)
		require.Nil(t, hint)
	}
}

func TestDisplayActivityHint7974PayloadAndAuthorityInvariants(t *testing.T) {
	server, h, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	t.Setenv("CODEX_HOME", t.TempDir())
	sid := uuid.NewString()
	name := "codex-" + sid
	team := "display-test"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "probe", AgentType: "codex", WorkingDir: "/isolated/work", BoardName: &team}))
	mock.addSession(name, "/isolated/work")
	_, err := h.bs.Subscribe(ctx, team, "Probe", "Developer", name, nil, "all")
	require.NoError(t, err)
	term := &displayHintTerminal{agentTerm: &agentTerm{mockSessionTerminal: mock}}
	h.terminal = term
	events := displayRequest(time.Now().Add(-10 * time.Second))
	for _, e := range events {
		e.SessionID = &sid
		e.AgentName = "probe"
		_, err = h.ts.InsertAgentEvent(ctx, &e)
		require.NoError(t, err)
	}
	boardRoute := chi.NewRouter()
	boardRoute.Get("/api/board/{project}/status", h.TeamAvailability)
	var baselineState SessionState
	var baselineGate ptymanager.AgentState
	var baselineBoard map[string]any
	for i, screen := range []string{displayFixture(t, "exec-dialog.txt"), displayFixture(t, "approved-working.txt")} {
		term.show(screen)
		h.displayScreens = displayScreenCache{}
		get := func() map[string]any {
			resp, err := http.Get(server.URL + "/api/sessions/live")
			require.NoError(t, err)
			defer resp.Body.Close()
			var rows []map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&rows))
			for _, r := range rows {
				if r["session_id"] == sid {
					return r
				}
			}
			t.Fatal("missing row")
			return nil
		}
		row := get()
		req := httptest.NewRequest("GET", "/ws/coral", nil)
		ws, err := h.buildSessionListForWS(req)
		require.NoError(t, err)
		var wsRow map[string]any
		for _, r := range ws {
			if r["session_id"] == sid {
				wsRow = r
			}
		}
		require.Equal(t, row["display_activity_hint"], wsRow["display_activity_hint"])
		require.Equal(t, row["display_activity_hint_at"], wsRow["display_activity_hint_at"])
		if i == 0 {
			require.Nil(t, row["display_activity_hint"])
		} else {
			require.Equal(t, "working", row["display_activity_hint"])
		}
		for _, suffix := range []string{"/resolve", "/status"} {
			resp, err := http.Get(server.URL + "/api/sessions/" + sid + suffix)
			require.NoError(t, err)
			var single map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&single))
			resp.Body.Close()
			require.Equal(t, row["display_activity_hint"], single["display_activity_hint"], suffix)
			require.Equal(t, row["display_activity_hint_at"], single["display_activity_hint_at"], suffix)
			require.Equal(t, true, single["waiting_for_input"], suffix)
		}
		require.Equal(t, true, row["waiting_for_input"])
		require.Equal(t, false, row["working"])
		st := h.deriveSingleSessionState(ctx, sid, 0)
		gate, ok := h.gateState(ctx, name, "codex", sid)
		require.True(t, ok)
		require.True(t, st.NeedsInput)
		require.True(t, st.OwnRequest)
		require.Equal(t, ptymanager.StateBlocked, gate.State)
		require.True(t, h.blockedOnBox(ctx, name, "codex", sid))
		rec := httptest.NewRecorder()
		boardRoute.ServeHTTP(rec, httptest.NewRequest("GET", "/api/board/"+team+"/status", nil))
		require.Equal(t, 200, rec.Code)
		var board map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &board))
		delete(board, "observed_at")
		if i == 0 {
			baselineState, baselineGate, baselineBoard = st, gate, board
		} else {
			require.Equal(t, baselineState, st)
			require.Equal(t, baselineGate, gate)
			require.Equal(t, baselineBoard, board)
		}
		// Exercise a real held send in both presentations. The gate, not the hint,
		// decides; cancellation removes the fixture message before the next iteration.
		held, err := h.deliverPersonSend(ctx, name, "codex", sid, "must remain held", false, nil)
		require.NoError(t, err)
		require.NotEmpty(t, held)
		typed, enters := term.counts()
		require.Empty(t, typed)
		require.Zero(t, enters)
		require.NoError(t, h.cancelHeld(name, held, false))
	}
	// A partial feed row must carry the hint lease, even if unchanged, because
	// omission means no hint on the client rather than indefinite stale evidence.
	prev := map[string]any{"session_id": sid, "display_activity_hint": "working", "display_activity_hint_at": "read"}
	curr := map[string]any{"session_id": sid, "display_activity_hint": "working", "display_activity_hint_at": "read", "staleness_seconds": 1}
	delta := fieldDelta(prev, curr)
	require.Equal(t, "working", delta["display_activity_hint"])
	require.Equal(t, "read", delta["display_activity_hint_at"])
}

// Review round 2: explicit fail-closed cases, including a terminal change during
// the read rather than only between two payload builds.
func TestDisplayActivityHint7974ReviewGuards(t *testing.T) {
	_, h, mock, _ := setupSessionsTestServer(t)
	term := &displayHintTerminal{agentTerm: &agentTerm{mockSessionTerminal: mock}}
	h.terminal = term
	stamp := &stampingBackend{stamp: "before"}
	h.backend = stamp
	now := time.Now()
	events := displayRequest(now.Add(-10 * time.Second))
	st := displayRequestState(events)
	working := displayFixture(t, "approved-working.txt")
	term.show(working)
	for name, block := range map[string]func(*SessionState){
		"sleeping":    func(s *SessionState) { s.Sleeping = true },
		"login":       func(s *SessionState) { s.NeedsLogin = true },
		"stuck":       func(s *SessionState) { s.Stuck = true },
		"not started": func(s *SessionState) { s.NotStarted = true },
		"gone":        func(s *SessionState) { s.Gone = true },
	} {
		t.Run(name, func(t *testing.T) {
			state := st
			block(&state)
			hint, at := h.displayActivityHint("codex", "codex-probe", "probe", state, events, now)
			require.Nil(t, hint)
			require.Nil(t, at)
		})
	}
	t.Run("requestless snapshot window", func(t *testing.T) {
		hint, at := h.displayActivityHint("codex", "codex-probe", "probe", st, nil, now)
		require.Nil(t, hint)
		require.Nil(t, at)
	})
	t.Run("request without a valid timestamp", func(t *testing.T) {
		e := displayRequest(now.Add(-time.Hour))
		e[0].CreatedAt = "invalid"
		hint, at := h.displayActivityHint("codex", "codex-probe", "probe", st, e, now)
		require.Nil(t, hint)
		require.Nil(t, at)
	})
	t.Run("foreign notification beside own permission", func(t *testing.T) {
		e := append(append([]store.AgentEvent{}, events...), store.AgentEvent{EventType: "notification", Summary: "An unrelated request needs an answer", CreatedAt: now.Add(-5 * time.Second).Format(time.RFC3339Nano)})
		hint, at := h.displayActivityHint("codex", "codex-probe", "probe", st, e, now)
		require.Nil(t, hint)
		require.Nil(t, at)
	})
	t.Run("output stamp changes while screen is read", func(t *testing.T) {
		h.displayScreens = displayScreenCache{}
		stamp.set("before")
		var changed bool
		term.onRead = func() { stamp.set("after"); changed = true }
		hint, at := h.displayActivityHint("codex", "codex-probe", "probe", st, events, now)
		require.True(t, changed)
		require.Equal(t, 1, term.reads)
		require.Nil(t, hint)
		require.Nil(t, at)
	})
}
