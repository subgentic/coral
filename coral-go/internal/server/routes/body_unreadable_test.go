package routes

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// cutBody is a request body whose connection was cut: part of it reads, then the read fails (what a client that went away mid-upload gives the server).
func cutBody(part string) io.ReadCloser {
	return io.NopCloser(io.MultiReader(strings.NewReader(part), errReader{io.ErrUnexpectedEOF}))
}

type errReader struct{ err error }

func (e errReader) Read([]byte) (int, error) { return 0, e.err }

func assertUnreadable(t *testing.T, rec *httptest.ResponseRecorder, what string) {
	t.Helper()
	assert.Equal(t, http.StatusBadRequest, rec.Code, what+": "+rec.Body.String())
	assert.Equal(t, "body_unreadable", codeOf(t, rec), what)
	assert.Contains(t, rec.Body.String(), "the request body could not be read", what, "one wording for the code, the observer's (#7261)")
}

// #7204 (QA's #7199 sweep): a request whose body is cut while a layer reads it is a 400 body_unreadable and goes no further: what was read is not put back for a later layer or a handler to take
// for the whole request. Every layer that reads a body ahead of the handlers is covered, so none of them is a refusal no test reaches.
func TestACutBodyIsRefusedByEveryLayerThatReadsIt(t *testing.T) {
	const part = `{"subscriber_id":"Dev","body":"hel`
	reached := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true })
	_, handler := setupBoardTestServer(t)
	for name, mw := range map[string]struct {
		layer http.Handler
		req   func() *http.Request
	}{
		"CanonicalIdentityKeys": {CanonicalIdentityKeys(next), func() *http.Request {
			return httptest.NewRequest("POST", "/api/board/p/messages", nil)
		}},
		"RejectBadIdentities": {RejectBadIdentities(next), func() *http.Request {
			return httptest.NewRequest("POST", "/api/board/p/messages", nil)
		}},
		"RejectOperatorImpersonation": {RejectOperatorImpersonation(next), func() *http.Request {
			r := httptest.NewRequest("POST", "/api/board/p/messages", nil)
			r.Header.Set("User-Agent", "coral-board/1.4") // the agent command line: asked
			return r
		}},
		"TunnelIdentityGuard": {TunnelIdentityGuard(handler.bs, func(*http.Request) bool { return true })(next), func() *http.Request {
			return stamp(httptest.NewRequest("POST", "/api/board/p/tasks", nil)) // a chat post is the guard's own exception; a task write is not
		}},
	} {
		t.Run(name, func(t *testing.T) {
			reached = false
			r := mw.req()
			r.Body = cutBody(part)
			r.ContentLength = -1
			rec := httptest.NewRecorder()
			mw.layer.ServeHTTP(rec, r)
			assertUnreadable(t, rec, name)
			assert.False(t, reached, "the next layer never sees a cut body")
		})
	}
}

// #7204: `coral cloud connect` signs the body, so refuseCloud reads it; a body cut mid-read is 400 body_unreadable, not a partial body put back and a verdict on it (the old code skipped only the MAC
// check and went on to the other refusals with the cut body in place of the request's).
func TestRefuseCloudRefusesACutCommandLineBody(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "c.db"))
	require.NoError(t, err)
	defer db.Close()
	h := NewCloudHandler(store.NewSessionStore(db), t.TempDir())
	h.SetPeerCheck(func(*http.Request) (bool, bool) { return true, true }) // the loopback peer is Coral's own user
	sig := base64.RawURLEncoding.EncodeToString([]byte("not a signature"))
	for name, allow := range map[string]int{"command line only": allowCLI, "dashboard or command line": allowDashboard | allowCLI} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/cloud/connect", nil)
			r.RemoteAddr, r.Host = "127.0.0.1:50000", "127.0.0.1:8420"
			r.Header.Set(cliauth.CLIAuthHeader, sig)
			r.Body = cutBody(`{"url":"https://hub.example/`)
			r.ContentLength = -1
			rec := httptest.NewRecorder()
			assert.True(t, h.refuseCloud(rec, r, allow), "refused")
			assertUnreadable(t, rec, name)
		})
	}
}

// #7204: a claim read that fails is counted "unreadable" (QA's point 2: that outcome had no test). boardClaims' own refusal of a cut body, and the observer's 400 on both paths, are #7195's
// (identity_board_cut_test.go).
func TestACountedClaimThatCouldNotBeReadIsUnreadable(t *testing.T) {
	o := &IdentityObserver{actorClaims: map[string]int64{}, joiningWould: map[string]int64{}}
	r := httptest.NewRequest("POST", "/api/board/p/tasks", nil)
	o.countActor(r, Actor{Kind: ActorToken, Name: "Dev"}, []string{"Dev"}, io.ErrUnexpectedEOF)
	o.countActor(r, Actor{Kind: ActorToken, Name: "Dev"}, []string{"Dev"}, nil)
	var unreadable, match int64
	for key, n := range o.actorClaims {
		switch {
		case strings.Contains(key, " "+claimUnread+" "):
			unreadable += n
		case strings.Contains(key, " "+claimMatch+" "):
			match += n
		}
	}
	assert.EqualValues(t, 1, unreadable, "a read error is the unreadable outcome, whatever the claims it gave: %v", o.actorClaims)
	assert.EqualValues(t, 1, match)
}

// #7261 (Security's #7259 LOW points): refuseCloud answers a body over its 64 KiB limit as 413 body_too_large, as identity_keys.go does for size, and only a read error as 400 body_unreadable; and the
// idempotency layer's read of a cut body carries the same code.
func TestRefuseCloudSeparatesATooLargeBodyFromAnUnreadableOne(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "c.db"))
	require.NoError(t, err)
	defer db.Close()
	h := NewCloudHandler(store.NewSessionStore(db), t.TempDir())
	h.SetPeerCheck(func(*http.Request) (bool, bool) { return true, true })
	sig := base64.RawURLEncoding.EncodeToString([]byte("not a signature"))
	r := httptest.NewRequest("POST", "/api/cloud/connect", strings.NewReader(strings.Repeat("x", 64<<10+1)))
	r.RemoteAddr, r.Host = "127.0.0.1:50000", "127.0.0.1:8420"
	r.Header.Set(cliauth.CLIAuthHeader, sig)
	rec := httptest.NewRecorder()
	assert.True(t, h.refuseCloud(rec, r, allowCLI))
	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
	assert.Equal(t, "body_too_large", codeOf(t, rec))
}

func TestIdempotencyRefusesACutBodyWithTheUnreadableCode(t *testing.T) {
	c, i := newCounting(200), NewIdempotency()
	req := idemReq("/api/sessions/launch", "", "hub-user-1234abcd", idemKey)
	req.Body = cutBody(`{"name":"half`)
	req.ContentLength = -1
	rec := idemDo(i.Wrap(c.handler()), req)
	assertUnreadable(t, rec, "idempotency")
	assert.Zero(t, c.runs.Load(), "the handler never runs for a cut body")
}
