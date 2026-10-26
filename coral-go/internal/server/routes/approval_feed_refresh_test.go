package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

type approvalFeedTerminal struct{ *agentTerm }

func (a *approvalFeedTerminal) RenderedScreen(ctx context.Context, name, kind, id string) (string, error) {
	return a.AgentScreen(ctx, name, kind, id)
}

// Exercise the real answer route and websocket. There is no closing hook and no
// periodic tick in this window: only a confirmed answer can refresh the row.
func TestApprovalFeed8040ConfirmedAnswerPushesFreshEvidence(t *testing.T) {
	for _, age := range []time.Duration{10 * time.Second, time.Second} {
		t.Run(age.String(), func(t *testing.T) {
			t.Setenv("CODEX_HOME", t.TempDir())
			server, h, mock, ss := setupSessionsTestServer(t)
			h.cfg.WSPollInterval = 24 * time.Hour
			ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
			defer cancel()
			sid := uuid.NewString()
			name := "codex-" + sid
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "probe", AgentType: "codex", WorkingDir: "/fixture"}))
			mock.addSession(name, "/fixture")
			term := &approvalFeedTerminal{agentTerm: &agentTerm{mockSessionTerminal: mock}}
			term.show(displayFixture(t, "exec-dialog.txt"))
			h.terminal = term
			requested := time.Now().Add(-age)
			event := displayRequest(requested)[0]
			event.SessionID = &sid
			event.AgentName = "probe"
			_, err := h.ts.InsertAgentEvent(ctx, &event)
			require.NoError(t, err)
			// The initial update caches a negative screen read for an old request. The
			// terminal has no output stamp, so invalidation must not depend on a stamp.
			wsServer := httptest.NewServer(http.HandlerFunc(h.WSCoral))
			defer wsServer.Close()
			conn, _, err := websocket.Dial(ctx, "ws"+wsServer.URL[4:], nil)
			require.NoError(t, err)
			defer conn.CloseNow()
			var initial struct {
				Sessions []map[string]any `json:"sessions"`
			}
			require.NoError(t, wsjson.Read(ctx, conn, &initial))
			var row map[string]any
			for _, r := range initial.Sessions {
				if r["session_id"] == sid {
					row = r
				}
			}
			require.NotNil(t, row)
			require.Equal(t, true, row["waiting_for_input"])
			require.Nil(t, row["display_activity_hint"])
			working := displayFixture(t, "approved-working.txt")
			mock.onRaw = func(string) { term.show(working) }
			answered := time.Now()
			resp, err := http.Post(server.URL+"/api/sessions/live/"+name+"/answer-prompt", "application/json", strings.NewReader(`{"session_id":"`+sid+`","agent_type":"codex","n":1,"label":"Yes, proceed (y)"}`))
			require.NoError(t, err)
			defer resp.Body.Close()
			var body map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
			require.Equal(t, 200, resp.StatusCode, body)
			for {
				var msg struct {
					Changed []map[string]any `json:"changed"`
				}
				readCtx, stop := context.WithTimeout(ctx, 4*time.Second)
				err := wsjson.Read(readCtx, conn, &msg)
				stop()
				require.NoError(t, err, "answer must push without waiting for the periodic feed tick")
				for _, r := range msg.Changed {
					if r["session_id"] != sid || r["display_activity_hint"] != "working" {
						continue
					}
					require.Equal(t, true, row["waiting_for_input"], "the original wait remains authoritative")
					state := h.deriveSingleSessionState(ctx, sid, 0)
					require.True(t, state.NeedsInput)
					require.True(t, state.OwnRequest)
					if age < displayHintSettle {
						require.GreaterOrEqual(t, time.Since(requested), displayHintSettle, "never quiet within request settle")
						require.Less(t, time.Since(answered), displayHintSettle-age+time.Second, "settle is from request, not approval")
					} else {
						require.Less(t, time.Since(answered), time.Second)
					}
					return
				}
			}
		})
	}
}

// A confirmed answer schedules only read attempts. A different, younger request
// appearing before the deferred attempt still gets its own full settle period.
func TestApprovalFeed8040NewRequestStillSettles(t *testing.T) {
	_, h, mock, _ := setupSessionsTestServer(t)
	term := &approvalFeedTerminal{agentTerm: &agentTerm{mockSessionTerminal: mock}}
	h.terminal = term
	term.show(displayFixture(t, "approved-working.txt"))
	sid := uuid.NewString()
	older := displayRequest(time.Now().Add(-displayHintSettle + 200*time.Millisecond))[0]
	older.SessionID = &sid
	_, err := h.ts.InsertAgentEvent(context.Background(), &older)
	require.NoError(t, err)
	kicks, unsubscribe := h.wsKick.subscribe()
	defer unsubscribe()
	h.refreshAfterConfirmedAnswer(context.Background(), "codex", sid)
	<-kicks // immediate read attempt
	newer := displayRequest(time.Now())
	newer[0].SessionID = &sid
	_, err = h.ts.InsertAgentEvent(context.Background(), &newer[0])
	require.NoError(t, err)
	select {
	case <-kicks:
	case <-time.After(time.Second):
		t.Fatal("no deferred read attempt")
	}
	events := append([]store.AgentEvent{older}, newer...)
	hint, at := h.displayActivityHint("codex", "codex-"+sid, sid, displayRequestState(events), events, time.Now())
	require.Nil(t, hint, "the old timer cannot quiet a new dialog")
	require.Nil(t, at)
}

func TestApprovalFeed8040RejectedAnswerDoesNotRefresh(t *testing.T) {
	server, h, mock, ss := setupSessionsTestServer(t)
	sid := uuid.NewString()
	name := "codex-" + sid
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentName: "probe", AgentType: "codex", WorkingDir: "/fixture"}))
	mock.addSession(name, "/fixture")
	term := &approvalFeedTerminal{agentTerm: &agentTerm{mockSessionTerminal: mock}}
	term.show(displayFixture(t, "exec-dialog.txt"))
	h.terminal = term
	kicks, unsubscribe := h.wsKick.subscribe()
	defer unsubscribe()
	resp, err := http.Post(server.URL+"/api/sessions/live/"+name+"/answer-prompt", "application/json", strings.NewReader(`{"session_id":"`+sid+`","agent_type":"codex","n":1,"label":"stale menu label"}`))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 409, resp.StatusCode)
	select {
	case <-kicks:
		t.Fatal("unconfirmed answer kicked the feed")
	default:
	}
}
