package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/pkg/hubowner"
)

// #15730: the Hub's Activity folder reads each linked computer's own record (GET /api/activity) as the signed-in owner. Before generation 9 that route was not signed, so every remote refused it (403) and the
// folder showed one computer or none. Two remotes, each with its own record: the owner reads both, each answer is that computer's own actions; a script with the Hub's key, a forged stamp and a Hub with no
// secret are refused by both.
func TestTheOwnerAtTheHubReadsTheActivityRecordOfEachOfTwoRemotes(t *testing.T) {
	type remote struct {
		w    *stampWorld
		item string
	}
	build := func(item string) remote {
		_, h := setupBoardTestServer(t)
		require.NoError(t, h.bs.RecordActivity(context.Background(), board.ActivityMeta{Actor: "local", Source: "local", Title: item}, board.ActApprove, "file", item, "", "alpha"))
		mount := func(rr chi.Router) {
			rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": hubowner.RoutesVersion})
			})
			rr.Get("/api/activity", h.ListActivity)
		}
		return remote{w: newStampWorldMount(t, integrationSecret, integrationSecret, mount), item: item}
	}
	a, b := build("from-computer-a"), build("from-computer-b")
	read := func(r remote, mutate func(*http.Request)) (int, map[string]any) {
		req, _ := http.NewRequest("GET", r.w.hub.URL+"/api/remote/ssh-box/api/activity?limit=50", nil)
		mutate(req)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		body, _ := io.ReadAll(resp.Body)
		_ = json.Unmarshal(body, &out)
		return resp.StatusCode, out
	}
	titles := func(out map[string]any) []string {
		var got []string
		for _, x := range out["actions"].([]any) {
			got = append(got, x.(map[string]any)["title"].(string))
		}
		return got
	}

	for _, r := range []remote{a, b} {
		// not signed in: a script with the Hub's key is refused, and a forged stamp is no better
		code, out := read(r, func(q *http.Request) { q.Header.Set("Authorization", "Bearer the-hubs-own-api-key") })
		assert.Equal(t, http.StatusForbidden, code, out)
		code, _ = read(r, func(q *http.Request) {
			q.Header.Set("Authorization", "Bearer the-hubs-own-api-key")
			q.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
		})
		assert.Equal(t, http.StatusForbidden, code)
		*r.w.cookie = true // the signed-in dashboard session of the Hub's owner
		code, out = read(r, func(*http.Request) {})
		require.Equal(t, http.StatusOK, code, "the owner at the Hub reads this computer's record: %v", out)
		assert.Equal(t, []string{r.item}, titles(out), "each computer answers with its own actions and no other's")
	}

	// a Hub that holds no secret signs nothing: the signed-in owner is refused, not let through
	w2 := newStampWorldMount(t, "", integrationSecret, func(rr chi.Router) {
		rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": hubowner.RoutesVersion})
		})
		_, h := setupBoardTestServer(t)
		rr.Get("/api/activity", h.ListActivity)
	})
	*w2.cookie = true
	code, out := read(remote{w: w2}, func(*http.Request) {})
	assert.Equal(t, http.StatusForbidden, code, out)
}
