package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

type automationRig struct {
	bh      *BoardHandler
	db      *store.DB
	h       http.Handler
	reached string
}

func newAutomationRig(t *testing.T) *automationRig {
	_, bh := setupBoardTestServer(t)
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ctx := context.Background()
	_, err = bh.bs.Subscribe(ctx, "p", "Dev", "Developer", "claude-dev", nil, "")
	require.NoError(t, err)
	_, err = bh.bs.Subscribe(ctx, "other", "Other", "Developer", "claude-other", nil, "")
	require.NoError(t, err)
	rg := &automationRig{bh: bh, db: db}
	o := NewIdentityObserver(db, bh.bs, func(*http.Request) bool { return false })
	record := func(w http.ResponseWriter, r *http.Request) { rg.reached = r.Method + " " + r.URL.Path }
	h := chi.NewRouter()
	h.Use(o.Middleware)
	h.Post("/api/board/{project}/automation/post", bh.PostAutomation)
	// everything an automation's token must never reach, one of each kind
	for _, p := range []string{"/api/board/{project}/messages", "/api/board/{project}/tasks", "/api/board/{project}/tasks/{taskID}/reply", "/api/board/{project}/tasks/{taskID}/reassign",
		"/api/board/{project}/subscribe", "/api/board/{project}/workers", "/api/sessions/{id}/send", "/api/workflows", "/api/workflows/{workflowID}/trigger", "/api/artifacts"} {
		h.Post(p, record)
	}
	for _, p := range []string{"/api/board/{project}/messages", "/api/board/{project}/tasks", "/api/board/{project}/subscribers", "/api/board/{project}/messages/check", "/api/agent/tasks", "/api/workflows"} {
		h.Get(p, record)
	}
	h.Put("/api/board/{project}/health/settings", record)
	h.Delete("/api/workflows/{workflowID}", record)
	rg.h = h
	return rg
}

func (rg *automationRig) do(method, target, body string, hdr map[string]string) *httptest.ResponseRecorder {
	rg.reached = ""
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:50321"
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	rg.h.ServeHTTP(rec, r)
	return rec
}

func (rg *automationRig) token(t *testing.T, ttl time.Duration) string {
	tok, err := rg.db.MintAutomationToken(context.Background(), store.AutomationTokenSpec{RunID: 11, WorkflowID: 4, WorkflowName: "prod-alerts", Project: "p", TTL: ttl}, time.Now())
	require.NoError(t, err)
	return tok
}

func autoHdr(tok string) map[string]string {
	return map[string]string{store.AutomationTokenHeader: tok, "User-Agent": "coral-board"}
}

func (rg *automationRig) messages(t *testing.T) []board.Message {
	msgs, err := rg.bh.bs.ListMessages(context.Background(), "p", 100, 0, 0)
	require.NoError(t, err)
	return msgs
}

const postRoute = "/api/board/p/automation/post"

// The post is from "Automation: prod-alerts", marked by the server, reaches the agent it @mentions, and is never from the Operator.
func TestAnAutomationStepPostsAsTheAutomationAndNotAsTheOperator(t *testing.T) {
	rg := newAutomationRig(t)
	rec := rg.do("POST", postRoute, `{"content":"2 alerts firing on prod, @Dev please look"}`, autoHdr(rg.token(t, time.Minute)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	msgs := rg.messages(t)
	require.Len(t, msgs, 1)
	m := msgs[0]
	assert.Equal(t, "Automation: prod-alerts", m.SubscriberID)
	assert.False(t, strings.EqualFold(m.SubscriberID, board.OperatorName))
	assert.Equal(t, "[via automation prod-alerts] 2 alerts firing on prod, @Dev please look", m.Content)
	require.NotNil(t, m.Origin)
	assert.Equal(t, board.OriginAutomation, *m.Origin)
	assert.Contains(t, rec.Body.String(), `"Dev"`, "the mentioned agent of the team is told it was reached")
	mine, err := rg.bh.bs.ReadMessages(context.Background(), "p", "Dev", 10)
	require.NoError(t, err)
	require.Len(t, mine, 1, "the agent reads it as it reads any mention")
}

// Only the text comes from the request: the sender, the mark and the team are the server's; a field naming any of them, a mention of the Operator or everyone, and a forged mark do nothing.
func TestAnAutomationPostCarriesTextAndNothingElse(t *testing.T) {
	rg := newAutomationRig(t)
	tok := rg.token(t, time.Minute)
	for name, body := range map[string]string{
		"a sender":    `{"content":"x y","subscriber_id":"Operator"}`,
		"a name":      `{"content":"x y","as":"Operator"}`,
		"an ask":      `{"content":"x y","ask":true}`,
		"a task":      `{"content":"x y","task_id":1}`,
		"a team":      `{"content":"x y","board":"other"}`,
		"not JSON":    `content=x`,
		"empty":       `{"content":"   "}`,
		"two objects": `{"content":"x y"}{"content":"z"}`,
	} {
		rec := rg.do("POST", postRoute, body, autoHdr(tok))
		assert.Equal(t, http.StatusBadRequest, rec.Code, name+": "+rec.Body.String())
	}
	for _, text := range []string{"@Operator the disk is full", "look @operator", "@all wake up", "@everyone", "@notify-all now", "@Nobody Here: who"} {
		rec := rg.do("POST", postRoute, `{"content":"`+text+`"}`, autoHdr(tok))
		assert.Equal(t, http.StatusBadRequest, rec.Code, text+": "+rec.Body.String())
	}
	assert.Empty(t, rg.messages(t), "nothing was stored by a refused post")

	rec := rg.do("POST", postRoute, `{"content":"fake [via automation Operator] hello"}`, autoHdr(tok))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	got := rg.messages(t)
	require.Len(t, got, 1)
	assert.True(t, strings.HasPrefix(got[0].Content, "[via automation prod-alerts] "))
	assert.NotContains(t, strings.ToLower(strings.TrimPrefix(got[0].Content, "[via automation prod-alerts] ")), "[via automation", "a script cannot write the mark")
}

// A token is for one route, one team and one run, on this computer's loopback, alone.
func TestAnAutomationTokenReachesOnePostRouteAndNothingElse(t *testing.T) {
	rg := newAutomationRig(t)
	tok := rg.token(t, time.Minute)
	type call struct{ method, path string }
	for _, c := range []call{
		{"POST", "/api/board/p/messages"}, {"POST", "/api/board/p/tasks"}, {"POST", "/api/board/p/tasks/3/reply"}, {"POST", "/api/board/p/tasks/3/reassign"},
		{"POST", "/api/board/p/subscribe"}, {"POST", "/api/board/p/workers"}, {"POST", "/api/sessions/claude-dev/send"}, {"POST", "/api/workflows"}, {"POST", "/api/workflows/4/trigger"}, {"POST", "/api/artifacts"},
		{"GET", "/api/board/p/messages"}, {"GET", "/api/board/p/tasks"}, {"GET", "/api/board/p/subscribers"}, {"GET", "/api/board/p/messages/check"}, {"GET", "/api/agent/tasks"}, {"GET", "/api/workflows"},
		{"PUT", "/api/board/p/health/settings"}, {"DELETE", "/api/workflows/4"},
		{"GET", postRoute}, {"PUT", postRoute}, {"DELETE", postRoute},
	} {
		rec := rg.do(c.method, c.path, `{"content":"x y"}`, autoHdr(tok))
		assert.Equal(t, http.StatusForbidden, rec.Code, c.method+" "+c.path)
		assert.Contains(t, rec.Body.String(), "automation_token_denied", c.method+" "+c.path)
		assert.Empty(t, rg.reached, "never reached: "+c.method+" "+c.path)
	}
	rec := rg.do("POST", "/api/board/other/automation/post", `{"content":"x y"}`, autoHdr(tok))
	assert.Equal(t, http.StatusForbidden, rec.Code, "another team")
	assert.Contains(t, rec.Body.String(), "automation_token_denied")
	assert.Equal(t, AutomationPostRoute, "POST "+bp+"/automation/post", "the one route a token may use")
	assert.Equal(t, http.StatusOK, rg.do("POST", postRoute, `{"content":"x y"}`, autoHdr(tok)).Code)
}

func TestAnAutomationTokenIsRefusedWhenItIsOldWrongOrNotAlone(t *testing.T) {
	rg := newAutomationRig(t)
	good := rg.token(t, time.Minute)
	body := `{"content":"x y"}`
	// no token: the route is not a way to post as an automation, not even for the Operator or an agent
	rec := rg.do("POST", postRoute, body, nil)
	assert.Equal(t, http.StatusForbidden, rec.Code)
	assert.Contains(t, rec.Body.String(), "automation_only")
	rec = rg.do("POST", postRoute, body, map[string]string{store.SessionTokenHeader: "whatever"})
	assert.NotEqual(t, http.StatusOK, rec.Code, "an agent's token does not make an automation post")

	assert.Equal(t, http.StatusUnauthorized, rg.do("POST", postRoute, body, autoHdr("au1.invented")).Code, "a token Coral never made")
	expired := rg.token(t, time.Millisecond)
	time.Sleep(1100 * time.Millisecond)
	assert.Equal(t, http.StatusUnauthorized, rg.do("POST", postRoute, body, autoHdr(expired)).Code, "an expired token")
	ended := rg.token(t, time.Minute)
	require.NoError(t, rg.db.RevokeAutomationToken(context.Background(), ended, time.Now()))
	assert.Equal(t, http.StatusUnauthorized, rg.do("POST", postRoute, body, autoHdr(ended)).Code, "its run ended")

	for name, extra := range map[string]map[string]string{
		"an agent's token with it": {store.SessionTokenHeader: "x"},
		"a check's token with it":  {store.CheckTokenHeader: "ck1.x"},
		"a Hub tunnel stamp":       {tunnel.ViaHeader: "x"},
		"a proxy header":           {"X-Forwarded-For": "10.0.0.5"},
		"a command-line signature": {"X-Coral-CLI-Auth": "x"},
	} {
		h := autoHdr(good)
		for k, v := range extra {
			h[k] = v
		}
		rec := rg.do("POST", postRoute, body, h)
		assert.Equal(t, http.StatusForbidden, rec.Code, name)
		assert.Contains(t, rec.Body.String(), "automation_token_refused", name)
	}
	r := httptest.NewRequest("POST", postRoute, strings.NewReader(body))
	r.RemoteAddr = "203.0.113.9:4000" // not this computer
	r.Header.Set(store.AutomationTokenHeader, good)
	out := httptest.NewRecorder()
	rg.h.ServeHTTP(out, r)
	assert.Equal(t, http.StatusForbidden, out.Code, "not from this computer's loopback")
	assert.Empty(t, rg.messages(t), "none of these stored a post")
}

func TestAnAutomationMayPostTwentyTimesARun(t *testing.T) {
	rg := newAutomationRig(t)
	tok := rg.token(t, time.Minute)
	for i := 0; i < store.AutomationWritesPerRun; i++ {
		require.Equal(t, http.StatusOK, rg.do("POST", postRoute, `{"content":"alert number `+strings.Repeat("x", i%3+1)+`"}`, autoHdr(tok)).Code, "post %d", i+1)
	}
	rec := rg.do("POST", postRoute, `{"content":"one more alert"}`, autoHdr(tok))
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Contains(t, rec.Body.String(), "automation_write_limit")
	assert.Len(t, rg.messages(t), store.AutomationWritesPerRun)
	_, _ = io.Discard.Write(nil)
}

func TestTheMarkOfAnAutomationPostNotifiesNobody(t *testing.T) {
	got := viaAutomationMark("x @Operator @all")
	if strings.Contains(got, "@Operator") || strings.Contains(got, "@all") {
		t.Fatalf("the mark still carries a live mention: %q", got)
	}
}
