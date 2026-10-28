package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #9819: the star is a bookmark on an artifact id. The Operator's (the dashboard or the signed command line; through Coral Hub the owner's alone), idempotent, and an agent's token is refused.
func TestStarRouteAndTheMachineListSayWhatIsStarred(t *testing.T) {
	rig := newPruneRig(t)
	a := rig.object("star me", "s1", time.Hour)
	b := rig.object("not me", "s1", time.Hour)
	do := func(method, path string, hdr map[string]string) (int, map[string]any) {
		req, err := http.NewRequest(method, rig.srv.URL+path, nil)
		require.NoError(t, err)
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}
	dash := map[string]string{testDashboardHeader: "1"}

	code, _ := do(http.MethodPut, "/api/artifacts/"+a+"/star", map[string]string{testAgentHeader: "s1"})
	assert.Equal(t, http.StatusForbidden, code, "an agent's token cannot star")
	code, _ = do(http.MethodPut, "/api/artifacts/"+a+"/star", map[string]string{tunnel.ViaHeader: "x"})
	assert.Equal(t, http.StatusForbidden, code, "through the tunnel, a request with no owner stamp cannot")
	code, _ = do(http.MethodPut, "/api/artifacts/"+strings.Repeat("0", 64)+"/star", dash)
	assert.Equal(t, http.StatusNotFound, code, "an id with no object")
	code, _ = do(http.MethodPut, "/api/artifacts/not-an-id/star", dash)
	assert.Equal(t, http.StatusBadRequest, code)

	for i := 0; i < 2; i++ { // idempotent
		code, out := do(http.MethodPut, "/api/artifacts/"+a+"/star", dash)
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, true, out["starred"])
	}
	var n int
	require.NoError(t, rig.h.db.Reader().GetContext(context.Background(), &n, "SELECT COUNT(*) FROM artifact_stars"))
	assert.Equal(t, 1, n)

	list := func(query string) map[string]bool {
		code, out := do(http.MethodGet, "/api/artifacts"+query, dash)
		require.Equal(t, http.StatusOK, code, out)
		got := map[string]bool{}
		for _, row := range out["artifacts"].([]any) {
			m := row.(map[string]any)
			got[m["id"].(string)] = m["starred"].(bool)
		}
		return got
	}
	assert.Equal(t, map[string]bool{a: true, b: false}, list(""))
	assert.Equal(t, map[string]bool{a: true}, list("?starred=true"))
	assert.Equal(t, map[string]bool{b: false}, list("?starred=false"))
	code, _ = do(http.MethodGet, "/api/artifacts?starred=maybe", dash)
	assert.Equal(t, http.StatusBadRequest, code)

	code, out := do(http.MethodDelete, "/api/artifacts/"+a+"/star", dash)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, out["starred"])
	code, _ = do(http.MethodDelete, "/api/artifacts/"+a+"/star", dash)
	assert.Equal(t, http.StatusOK, code, "unstarring what is not starred is fine")
	assert.Equal(t, map[string]bool{a: false, b: false}, list(""))
}

func TestDeletingAnArtifactDropsItsStar(t *testing.T) {
	rig := newPruneRig(t)
	id := rig.object("star then delete", "s1", time.Hour)
	dash := map[string]string{testDashboardHeader: "1"}
	do := func(method, path string) int {
		req, err := http.NewRequest(method, rig.srv.URL+path, nil)
		require.NoError(t, err)
		for k, v := range dash {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		return resp.StatusCode
	}
	require.Equal(t, http.StatusOK, do(http.MethodPut, "/api/artifacts/"+id+"/star"))
	require.Equal(t, http.StatusOK, do(http.MethodDelete, "/api/artifacts/"+id))
	var n int
	require.NoError(t, rig.h.db.Reader().GetContext(context.Background(), &n, "SELECT COUNT(*) FROM artifact_stars WHERE hex = ?", id))
	assert.Zero(t, n, "deleting a starred artifact drops its star")
}
