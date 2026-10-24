package routes

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// cutBoardBody reads its prefix, then fails as a cut tunnel stream does (io.ErrUnexpectedEOF), never with a clean EOF.
type cutBoardBody struct {
	prefix string
	done   bool
}

func (c *cutBoardBody) Read(p []byte) (int, error) {
	if c.done {
		return 0, io.ErrUnexpectedEOF
	}
	n := copy(p, c.prefix)
	c.prefix = c.prefix[n:]
	if c.prefix == "" {
		c.done = true
	}
	return n, nil
}
func (c *cutBoardBody) Close() error { return nil }

const boardCutPrefix = `{"subscriber_id":"Dev","content":"half of a mes`

// #7187: boardClaims put back what it had read whatever the error was, so a body cut short reached the handler as a clean EOF. It now refuses, and what it hands on still ends in the error.
func TestBoardClaimsRefusesACutBodyAndHandsOnTheCutToo(t *testing.T) {
	req := httptest.NewRequest("POST", "/api/board/p/messages", &cutBoardBody{prefix: boardCutPrefix})
	claims, err := boardClaims(req)
	assert.Nil(t, claims)
	require.ErrorIs(t, err, errBoardBodyUnreadable)
	got, rerr := io.ReadAll(req.Body)
	assert.Equal(t, boardCutPrefix, string(got), "what arrived is still handed on")
	assert.True(t, errors.Is(rerr, io.ErrUnexpectedEOF), "and the cut after it: %v", rerr)

	// A whole body is unchanged.
	whole := httptest.NewRequest("POST", "/api/board/p/messages", io.NopCloser(&wholeBoardBody{s: `{"subscriber_id":"Dev","content":"hi"}`}))
	claims, err = boardClaims(whole)
	require.NoError(t, err)
	assert.Equal(t, []string{"Dev"}, claims["subscriber_id"])
	b, rerr := io.ReadAll(whole.Body)
	assert.NoError(t, rerr)
	assert.Equal(t, `{"subscriber_id":"Dev","content":"hi"}`, string(b))
}

type wholeBoardBody struct {
	s string
	n int
}

func (w *wholeBoardBody) Read(p []byte) (int, error) {
	if w.n >= len(w.s) {
		return 0, io.EOF
	}
	n := copy(p, w.s[w.n:])
	w.n += n
	return n, nil
}

// Through the identity layer: a cut body is a 400 and no handler runs, with a session token (checkBoard) and without one (the actor path).
func TestACutBoardBodyIsRefusedByTheIdentityLayerAndReachesNoHandler(t *testing.T) {
	_, bh := setupBoardTestServer(t)
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	defer db.Close()
	ctx := context.Background()
	_, err = bh.bs.Subscribe(ctx, "p", "Dev", "Developer", "claude-dev", nil, "")
	require.NoError(t, err)
	token, err := db.MintSessionToken(ctx, "sid-dev", "claude-dev")
	require.NoError(t, err)
	o := NewIdentityObserver(db, bh.bs, func(*http.Request) bool { return false })
	reached := 0
	var lastErr error
	h := o.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		_, lastErr = io.ReadAll(r.Body)
	}))
	do := func(body io.ReadCloser, withToken bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/board/p/messages", body)
		if withToken {
			req.Header.Set(store.SessionTokenHeader, token)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	for _, withToken := range []bool{true, false} {
		rec := do(&cutBoardBody{prefix: boardCutPrefix}, withToken)
		assert.Equal(t, http.StatusBadRequest, rec.Code, "token: %v: %s", withToken, rec.Body.String())
		assert.Contains(t, rec.Body.String(), "body_unreadable")
		assert.Zero(t, reached, "token: %v: no handler runs for a cut body", withToken)
	}
	rec := do(io.NopCloser(&wholeBoardBody{s: `{"subscriber_id":"Dev","content":"hi"}`}), true)
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, 1, reached, "a whole body still goes through")
	assert.NoError(t, lastErr)
}

// The front of the chain already answers a cut body: CanonicalIdentityKeys reads every board body first and refuses on any read error, so a cut body never reaches boardClaims through the router.
func TestCanonicalIdentityKeysRefusesACutBoardBody(t *testing.T) {
	reached := 0
	h := CanonicalIdentityKeys(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached++ }))
	for _, path := range []string{"/api/board/p/messages", "/api/board/p/tasks", "/api/agent/tasks"} {
		req := httptest.NewRequest("POST", path, &cutBoardBody{prefix: boardCutPrefix})
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		assert.Equal(t, http.StatusBadRequest, rec.Code, path)
	}
	assert.Zero(t, reached)
}
