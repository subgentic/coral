package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #16000: every Hub-forwarded send is a person's browser (the Hub has no automatic sender), so it is a row, never dropped; the owner stamp attributes it, an agent's tool writes none, and (below) a failed send writes none.
func TestChatSendRowsCoverTheDashboardAndTheHubButNotAgents(t *testing.T) {
	withLabel(t, "hub-user-1234abcd", nil) // this machine is enrolled as that account's
	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"}
	service := map[string]string{tunnel.ViaHeader: cloud.ViaSecret()} // the Hub's own call: authentic tunnel, nobody behind it
	for _, c := range []struct {
		name    string
		kind    string
		hdr     map[string]string
		wantRow bool
		source  string
	}{
		{"this computer's dashboard", callerDashCookie, nil, true, "local"},
		{"the Hub's signed-in owner", callerHub, owner, true, "hub"},
		{"a Hub send with no owner stamp is still the Operator's send, attributed to no one in particular", callerHub, service, true, "hub"},
		{"an agent's tool", callerAgentNoToken, nil, false, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
			require.NoError(t, err)
			t.Cleanup(func() { bs.Close() })
			r := chi.NewRouter()
			r.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
					next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, c.kind)))
				})
			})
			r.Use(ActivityRecorder(bs, nil))
			r.Post("/api/sessions/live/{name}/send", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
			req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/worktree1/send", nil)
			for k, v := range c.hdr {
				req.Header.Set(k, v)
			}
			r.ServeHTTP(httptest.NewRecorder(), req)
			rows, _, err := bs.ActivityPage(context.Background(), board.ActivityFilter{Limit: board.ActivityMaxLimit})
			require.NoError(t, err)
			if !c.wantRow {
				assert.Empty(t, rows)
				return
			}
			require.Len(t, rows, 1)
			assert.Equal(t, board.ActChatSend, rows[0].Action)
			assert.Equal(t, c.source, rows[0].Source)
			assert.NotEmpty(t, rows[0].Actor)
		})
	}
}

// #16000, the Operator's addition: a row of words sent to an agent shows the first line of what was sent, cut and redacted like the other excerpts; an agent's call writes no row.
func TestTheOperatorsSendRowShowsTheFirstLineOfTheWords(t *testing.T) {
	_, handler, terminal, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	id := "33333333-3333-4333-8444-555555555551"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "worktree1", WorkingDir: "/tmp/w1"}))
	terminal.addSession("worktree1", "/tmp/w1")
	terminal.addSession("claude-"+id, "/tmp/w1")
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	send := func(kind, command string) int {
		r := chi.NewRouter()
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind)))
			})
		})
		r.Use(ActivityRecorder(bs, nil))
		r.Post("/api/sessions/live/{name}/send", handler.Send)
		body, _ := json.Marshal(map[string]string{"command": command, "agent_type": "claude", "session_id": id})
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/live/worktree1/send", bytes.NewReader(body)))
		return rec.Code
	}
	require.Equal(t, http.StatusOK, send(callerAgentNoToken, "an agent's words"))
	require.Empty(t, wordRows(t, bs), "an agent's call is no click")
	long := strings.Repeat("x", 300)
	require.Equal(t, http.StatusOK, send(callerDashCookie, "\n  Please rebase on main  \nthen run the tests\n"+long))
	rows := wordRows(t, bs)
	require.Len(t, rows, 1)
	assert.Equal(t, board.ActChatSend, rows[0].Action)
	assert.Equal(t, "worktree1", rows[0].ItemID)
	assert.Equal(t, "Please rebase on main", rows[0].Note, "the first line with text, and nothing of the lines after it")
	require.Equal(t, http.StatusOK, send(callerDashCookie, long))
	rows = wordRows(t, bs)
	require.Len(t, rows, 2)
	assert.LessOrEqual(t, len([]rune(rows[0].Note)), 140, "a long line is cut")
}

// #16000: a send the server refuses (an unknown agent, a 404) is no row; only a 2xx is recorded.
func TestAFailedSendWritesNoActivityRow(t *testing.T) {
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie)))
		})
	})
	r.Use(ActivityRecorder(bs, nil))
	r.Post("/api/sessions/live/{name}/send", func(w http.ResponseWriter, req *http.Request) {
		noteActivity(req, board.ActChatSend, "agent", "worktree1", "", "", "words")
		w.WriteHeader(http.StatusNotFound)
	})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/sessions/live/worktree1/send", nil))
	rows, _, err := bs.ActivityPage(context.Background(), board.ActivityFilter{Limit: board.ActivityMaxLimit})
	require.NoError(t, err)
	assert.Empty(t, rows)
}
