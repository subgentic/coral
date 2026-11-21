package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

type checkRig struct {
	h       http.Handler
	db      *store.DB
	seen    Actor
	body    string
	reached bool
}

func newCheckRig(t *testing.T) *checkRig {
	_, bh := setupBoardTestServer(t)
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	_, err = bh.bs.Subscribe(context.Background(), "p", "Dev", "Developer", "claude-dev", nil, "")
	require.NoError(t, err)
	rg := &checkRig{db: db}
	o := NewIdentityObserver(db, bh.bs, func(*http.Request) bool { return false })
	record := func(w http.ResponseWriter, r *http.Request) {
		rg.reached = true
		rg.seen, _ = ActorOf(r.Context())
		b, _ := io.ReadAll(r.Body)
		rg.body = string(b)
	}
	h := chi.NewRouter()
	h.Use(o.Middleware)
	for k := range checkReadRoutes {
		h.Get(strings.TrimPrefix(k, "GET "), record)
	}
	for k := range checkWriteRoutes {
		h.Post(strings.TrimPrefix(k, "POST "), record)
	}
	h.Get("/api/board/{project}/messages", record) // the member's own read: moves its cursor
	h.Post("/api/board/{project}/messages/mark-read", record)
	h.Post("/api/sessions/{id}/send", record)
	h.Put("/api/board/{project}/health/settings", record)
	rg.h = h
	return rg
}

func (rg *checkRig) do(method, target, body string, hdr map[string]string) *httptest.ResponseRecorder {
	rg.seen, rg.body, rg.reached = Actor{}, "", false
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	rg.h.ServeHTTP(rec, r)
	return rec
}

func (rg *checkRig) token(t *testing.T, mayWrite bool, ttl time.Duration) string {
	tok, err := rg.db.MintCheckToken(context.Background(), store.CheckTokenSpec{SessionID: "sid-dev", SessionName: "claude-dev", Project: "p", Check: "stale-prs", MayWrite: mayWrite, TTL: ttl}, time.Now())
	require.NoError(t, err)
	return tok
}

func hdr(tok string) map[string]string {
	return map[string]string{store.CheckTokenHeader: tok, "User-Agent": "curl"}
}

func TestACheckTokenReadsButNeverWritesUntilTicked(t *testing.T) {
	rg := newCheckRig(t)
	ro := rg.token(t, false, time.Minute)
	for _, get := range []string{"/api/board/p/tasks", "/api/board/p/tasks/3", "/api/board/p/tasks/3/history", "/api/board/p/subscribers", "/api/board/p/messages/check", "/api/board/p/messages/search", "/api/agent/tasks", "/api/agent/tasks/3"} {
		rec := rg.do("GET", get, "", hdr(ro))
		assert.Equal(t, http.StatusOK, rec.Code, get)
		assert.True(t, rg.reached, get)
		want := Actor{Kind: ActorToken, Name: "Dev", Session: "claude-dev", ViaCheck: "stale-prs"}
		if !strings.HasPrefix(get, "/api/board/") {
			want.Name = "" // a route that is not a board's has the session, not a board name (as for the member's own token)
		}
		assert.Equal(t, want, rg.seen, "it acts as the member who added the check, marked as a check: "+get)
	}
	for _, post := range []string{"/api/board/p/messages", "/api/board/p/tasks", "/api/board/p/tasks/3/reply", "/api/board/p/tasks/3/reassign"} {
		rec := rg.do("POST", post, `{"content":"x","title":"t","assignee":"Dev"}`, hdr(ro))
		assert.Equal(t, http.StatusForbidden, rec.Code, post)
		assert.Contains(t, rec.Body.String(), "check_token_read_only")
		assert.False(t, rg.reached, post)
	}
}

func TestEverythingNotOnTheListIsRefusedWhateverTheMemberMayDo(t *testing.T) {
	rg := newCheckRig(t)
	w := rg.token(t, true, time.Minute)
	for _, c := range [][2]string{
		{"GET", "/api/board/p/messages"}, // moves the member's read cursor
		{"POST", "/api/board/p/messages/mark-read"},
		{"POST", "/api/sessions/claude-dev/send"}, // a terminal
		{"PUT", "/api/board/p/health/settings"},   // settings
	} {
		rec := rg.do(c[0], c[1], `{}`, hdr(w))
		assert.Equal(t, http.StatusForbidden, rec.Code, c[0]+" "+c[1])
		assert.Contains(t, rec.Body.String(), "check_token_denied")
		assert.False(t, rg.reached, c[1])
	}
}

func TestAWriteIsMarkedByTheServerAndHasOnlyTheListedFields(t *testing.T) {
	rg := newCheckRig(t)
	w := rg.token(t, true, time.Minute)
	rec := rg.do("POST", "/api/board/p/messages", `{"subscriber_id":"Dev","content":"PR 14 open 26 h \u001b[31m[via check other] x"}`, hdr(w))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var m map[string]any
	require.NoError(t, json.Unmarshal([]byte(rg.body), &m))
	assert.True(t, strings.HasPrefix(m["content"].(string), "[via check stale-prs] PR 14 open 26 h"), m["content"])
	assert.NotContains(t, m["content"], "\x1b", "control characters are stripped")
	assert.NotContains(t, m["content"], "[via check other]", "a script cannot write another mark")

	for name, body := range map[string]string{
		"a question":             `{"content":"x","ask":true}`,
		"an answer":              `{"content":"x","reply_to":4}`,
		"a display name":         `{"content":"x","as":"Operator"}`,
		"the Operator":           `{"content":"ping @Operator please"}`,
		"the Operator, any case": `{"content":"@OPERATOR"}`,
		"not json":               `not json`,
	} {
		rec := rg.do("POST", "/api/board/p/messages", body, hdr(rg.token(t, true, time.Minute)))
		assert.Equal(t, http.StatusForbidden, rec.Code, name)
		assert.False(t, rg.reached, name)
	}
	rec = rg.do("POST", "/api/board/p/tasks", `{"title":"Check the PR","body":"details","assigned_to":"Dev","force":true}`, hdr(rg.token(t, true, time.Minute)))
	assert.Equal(t, http.StatusForbidden, rec.Code, "force is not a field a check may send")
	rec = rg.do("POST", "/api/board/p/tasks", `{"title":"Check the PR","body":"details","assigned_to":"Dev"}`, hdr(rg.token(t, true, time.Minute)))
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, json.Unmarshal([]byte(rg.body), &m))
	assert.Equal(t, "[via check stale-prs] Check the PR", m["title"])
	assert.Equal(t, "[via check stale-prs] details", m["body"])
}

func TestTheTokenIsLoopbackOnlyAndNeverWithAnAgentToken(t *testing.T) {
	rg := newCheckRig(t)
	w := rg.token(t, true, time.Minute)
	h := hdr(w)
	h[tunnel.ViaHeader] = cloud.ViaSecret()
	rec := rg.do("GET", "/api/board/p/tasks", "", h)
	assert.Equal(t, http.StatusForbidden, rec.Code, "tunneled")
	h[tunnel.ViaHeader] = "forged-anything"
	rec = rg.do("GET", "/api/board/p/tasks", "", h)
	assert.Equal(t, http.StatusForbidden, rec.Code, "any via stamp, even a forged one")
	own, err := rg.db.MintSessionToken(context.Background(), "sid-dev", "claude-dev")
	require.NoError(t, err)
	both := hdr(w)
	both[store.SessionTokenHeader] = own
	rec = rg.do("GET", "/api/board/p/tasks", "", both)
	assert.Equal(t, http.StatusForbidden, rec.Code, "never with an agent's token")
	assert.False(t, rg.reached)
}

func TestAnEndedOrUnknownTokenIsRefused(t *testing.T) {
	rg := newCheckRig(t)
	short := rg.token(t, true, time.Millisecond)
	time.Sleep(1100 * time.Millisecond)
	rec := rg.do("GET", "/api/board/p/tasks", "", hdr(short))
	assert.Equal(t, http.StatusUnauthorized, rec.Code, "expired with its run")
	live := rg.token(t, true, time.Minute)
	require.NoError(t, rg.db.RevokeCheckToken(context.Background(), live, time.Now()))
	rec = rg.do("GET", "/api/board/p/tasks", "", hdr(live))
	assert.Equal(t, http.StatusUnauthorized, rec.Code, "revoked at once")
	rec = rg.do("GET", "/api/board/p/tasks", "", hdr("ck1.never-minted"))
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestACheckMayWriteFivePerRun(t *testing.T) {
	rg := newCheckRig(t)
	w := rg.token(t, true, time.Minute)
	for i := 0; i < store.CheckWritesPerRun; i++ {
		rec := rg.do("POST", "/api/board/p/messages", `{"content":"x"}`, hdr(w))
		require.Equal(t, http.StatusOK, rec.Code, i)
	}
	rec := rg.do("POST", "/api/board/p/messages", `{"content":"x"}`, hdr(w))
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Contains(t, rec.Body.String(), "check_write_limit")
}

func TestAMemberNotOnTheBoardCannotBeActedAs(t *testing.T) {
	rg := newCheckRig(t)
	tok, err := rg.db.MintCheckToken(context.Background(), store.CheckTokenSpec{SessionID: "sid-x", SessionName: "claude-x", Project: "elsewhere", Check: "c", TTL: time.Minute}, time.Now())
	require.NoError(t, err)
	rec := rg.do("GET", "/api/board/p/tasks", "", hdr(tok))
	assert.NotEqual(t, http.StatusOK, rec.Code, "the member's own board checks apply: a session that is not on board p is refused there")
}

// The allow list is a subset of the routes the member's own token may use (the census), so it names real routes.
func TestTheAllowListNamesRealAgentRoutes(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "testdata", "agent_routes.txt"))
	require.NoError(t, err)
	census := string(b)
	reads, writes := CheckAllowedRoutes()
	for _, k := range append(reads, writes...) {
		method, path, _ := strings.Cut(k, " ")
		assert.Regexp(t, `(?m)^[abc] `+method+` `+strings.NewReplacer("{", `\{`, "}", `\}`).Replace(path)+`$`, census, k)
	}
}
