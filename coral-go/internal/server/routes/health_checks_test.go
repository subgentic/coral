package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

type fakeCheckTokens struct{ revoked []string }

func (f *fakeCheckTokens) RevokeCheckTokensFor(_ context.Context, project, check string, _ time.Time) error {
	f.revoked = append(f.revoked, project+"/"+check)
	return nil
}

type checksRig struct {
	h    *BoardHandler
	tok  *fakeCheckTokens
	dir  string
	asOp func(*http.Request)
}

func newChecksRig(t *testing.T) *checksRig {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	for _, s := range []struct{ id, title, session string }{{"Orchestrator", "Orchestrator", "claude-orch"}, {"Dev", "Developer", "claude-dev"}} {
		_, err := h.bs.Subscribe(ctx, "team", s.id, s.title, s.session, nil, "all")
		require.NoError(t, err)
	}
	dir := t.TempDir()
	rg := &checksRig{h: h, tok: &fakeCheckTokens{}, dir: dir}
	h.SetCheckTokens(dir, rg.tok)
	return rg
}

func (rg *checksRig) script(t *testing.T) string {
	p := filepath.Join(rg.dir, "check.sh")
	require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\necho '{\"key\":\"a\",\"text\":\"hi\"}'\n"), 0o700))
	return p
}

func checkAsSession(session string) func(*http.Request) {
	return func(r *http.Request) {
		*r = *r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-" + session, SessionName: session}))
	}
}

func (rg *checksRig) call(method, path, body string, name string, mod func(*http.Request), fn http.HandlerFunc) (int, map[string]any) {
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("project", "team")
	if name != "" {
		rctx.URLParams.Add("name", name)
	}
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	if mod != nil {
		mod(req)
	}
	rec := httptest.NewRecorder()
	fn(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestOnlyTheOrchestratorOrTheOperatorManagesChecksAndEachIsPendingAtFirst(t *testing.T) {
	rg := newChecksRig(t)
	body := `{"name":"stale-prs","script":"` + rg.script(t) + `","args":["--max","3"],"dir":"` + rg.dir + `","every":"30m","to":"Dev","acts_as":"Orchestrator"}`
	code, _ := rg.call("POST", "/x", body, "", checkAsSession("claude-dev"), rg.h.AddHealthCheckRoute)
	assert.Equal(t, http.StatusForbidden, code, "a teammate")
	code, out := rg.call("POST", "/x", body, "", checkAsSession("claude-orch"), rg.h.AddHealthCheckRoute)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "pending", out["state"])
	assert.NotEmpty(t, out["record_hash"])
	assert.NotEmpty(t, out["approval_words"])
	code, _ = rg.call("POST", "/x", body, "", checkAsSession("claude-orch"), rg.h.AddHealthCheckRoute)
	assert.Equal(t, http.StatusConflict, code, "the same name twice")
	code, _ = rg.call("POST", "/x", body, "", func(r *http.Request) { r.Header.Set(tunnel.ViaHeader, "1") }, rg.h.AddHealthCheckRoute)
	assert.Equal(t, http.StatusForbidden, code, "through Coral Hub")
}

func TestACheckRefusesWhatCouldReachTheOperatorOrAStranger(t *testing.T) {
	rg := newChecksRig(t)
	s := rg.script(t)
	for name, body := range map[string]string{
		"to the Operator":         `{"name":"a","script":"` + s + `","dir":"` + rg.dir + `","every":"30m","to":"Operator"}`,
		"to a stranger":           `{"name":"b","script":"` + s + `","dir":"` + rg.dir + `","every":"30m","to":"Nobody"}`,
		"acts as the Operator":    `{"name":"c","script":"` + s + `","dir":"` + rg.dir + `","every":"30m","acts_as":"Operator"}`,
		"acts as a stranger":      `{"name":"d","script":"` + s + `","dir":"` + rg.dir + `","every":"30m","acts_as":"Nobody"}`,
		"a script that is a link": `{"name":"e","script":"` + filepath.Join(rg.dir, "nope") + `","dir":"` + rg.dir + `","every":"30m"}`,
		"too often":               `{"name":"f","script":"` + s + `","dir":"` + rg.dir + `","every":"1m"}`,
		"a bad name":              `{"name":"Bad Name","script":"` + s + `","dir":"` + rg.dir + `","every":"30m"}`,
		"a folder that is no dir": `{"name":"g","script":"` + s + `","dir":"` + s + `","every":"30m"}`,
		"a relative folder":       `{"name":"h","script":"` + s + `","dir":"x","every":"30m"}`,
	} {
		code, _ := rg.call("POST", "/x", body, "", checkAsSession("claude-orch"), rg.h.AddHealthCheckRoute)
		assert.Equal(t, http.StatusBadRequest, code, name)
	}
}

func TestPauseChangeAndRemoveEndTheChecksLiveTokensAtOnce(t *testing.T) {
	rg := newChecksRig(t)
	body := `{"name":"stale-prs","script":"` + rg.script(t) + `","dir":"` + rg.dir + `","every":"30m"}`
	code, _ := rg.call("POST", "/x", body, "", checkAsSession("claude-orch"), rg.h.AddHealthCheckRoute)
	require.Equal(t, http.StatusOK, code)
	orch := checkAsSession("claude-orch")

	code, _ = rg.call("POST", "/x", `{"paused":true}`, "stale-prs", orch, rg.h.PauseHealthCheckRoute)
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{"team/stale-prs"}, rg.tok.revoked, "pause")

	rg.tok.revoked = nil
	code, out := rg.call("PUT", "/x", `{"every":"1h"}`, "stale-prs", orch, rg.h.ChangeHealthCheckRoute)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "pending", out["state"], "any change returns it to pending")
	assert.Equal(t, []string{"team/stale-prs"}, rg.tok.revoked, "change")

	rg.tok.revoked = nil
	code, _ = rg.call("DELETE", "/x", "", "stale-prs", orch, rg.h.RemoveHealthCheckRoute)
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, []string{"team/stale-prs"}, rg.tok.revoked, "remove")
	code, _ = rg.call("DELETE", "/x", "", "stale-prs", orch, rg.h.RemoveHealthCheckRoute)
	assert.Equal(t, http.StatusNotFound, code)
}

func TestAChangeNeverSkipsTheOperatorsApproval(t *testing.T) {
	rg := newChecksRig(t)
	body := `{"name":"stale-prs","script":"` + rg.script(t) + `","dir":"` + rg.dir + `","every":"30m"}`
	rg.call("POST", "/x", body, "", checkAsSession("claude-orch"), rg.h.AddHealthCheckRoute)
	c, err := rg.h.bs.GetHealthCheck(context.Background(), "team", "stale-prs")
	require.NoError(t, err)
	require.NoError(t, rg.h.bs.ApproveHealthCheck(context.Background(), "team", "stale-prs", "Operator", c.RecordHash(), time.Now()))
	// resume of a paused check whose record changed is pending, never approved
	rg.call("POST", "/x", `{"paused":true}`, "stale-prs", checkAsSession("claude-orch"), rg.h.PauseHealthCheckRoute)
	_, out := rg.call("PUT", "/x", `{"may_write":true}`, "stale-prs", checkAsSession("claude-orch"), rg.h.ChangeHealthCheckRoute)
	assert.Equal(t, "pending", out["state"], "turning may-write on needs a new approval")
	code, out := rg.call("POST", "/x", `{"paused":false}`, "stale-prs", checkAsSession("claude-orch"), rg.h.PauseHealthCheckRoute)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, "pending", out["state"])
}

func TestTheChecksRoutesAreNeverThroughCoralHub(t *testing.T) {
	for _, c := range [][2]string{{"GET", "/api/board/team/health/checks"}, {"POST", "/api/board/team/health/checks"}, {"PUT", "/api/board/team/health/checks/x"}, {"POST", "/api/board/team/health/checks/x/pause"}, {"DELETE", "/api/board/team/health/checks/x"}} {
		assert.Equal(t, tunnel.TierNever, tunnel.Classify(c[0], c[1], ""), c[0]+" "+c[1])
	}
}

func TestARefusedChangeWritesNothing(t *testing.T) {
	rg := newChecksRig(t)
	body := `{"name":"stale-prs","script":"` + rg.script(t) + `","dir":"` + rg.dir + `","every":"30m"}`
	rg.call("POST", "/x", body, "", checkAsSession("claude-orch"), rg.h.AddHealthCheckRoute)
	ctx := context.Background()
	c, err := rg.h.bs.GetHealthCheck(ctx, "team", "stale-prs")
	require.NoError(t, err)
	require.NoError(t, rg.h.bs.ApproveHealthCheck(ctx, "team", "stale-prs", "Operator", c.RecordHash(), time.Now()))
	code, _ := rg.call("PUT", "/x", `{"may_write":true,"to":"Operator"}`, "stale-prs", checkAsSession("claude-orch"), rg.h.ChangeHealthCheckRoute)
	assert.Equal(t, http.StatusBadRequest, code)
	after, err := rg.h.bs.GetHealthCheck(ctx, "team", "stale-prs")
	require.NoError(t, err)
	assert.Equal(t, c.RecordHash(), after.RecordHash(), "a refused change leaves the stored record as it was")
	assert.Equal(t, "approved", after.State, "and its approval stands")
}
