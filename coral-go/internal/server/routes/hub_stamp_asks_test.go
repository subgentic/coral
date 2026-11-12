package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/hubowner"
)

// #15749: a question an agent on a remote computer asked the Operator showed an error (not everything could be read) in the self-hosted Hub's Needs you. The list (GET /api/operator-asks) is a person-only
// read that was not signed before generation 9, so the remote refused the owner. With generation 9 the owner reads the question through the Hub and answers it (POST .../messages, signed since generation 2) as the
// Operator, and the question closes. A script with the Hub's key, a forged stamp, a Hub that holds no secret, and a remote that reports an older generation are refused.
func TestTheOwnerAtTheHubReadsAndAnswersARemotesQuestionAndNobodyElseCan(t *testing.T) {
	build := func(gen int, hubSecret string) (*stampWorld, *BoardHandler) {
		h, bs := operatorAsksRig(t)
		ctx := context.Background()
		for _, who := range []string{"Lead", "Operator"} {
			_, err := bs.Subscribe(ctx, "team", who, who, "", nil, "all")
			require.NoError(t, err)
		}
		q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator which of the two designs do we ship?", nil)
		require.NoError(t, err)
		to, err := bs.AskTargets(ctx, "team", "Lead", q.Content)
		require.NoError(t, err)
		require.NoError(t, bs.RecordAsk(ctx, "team", q, to))
		mount := func(rr chi.Router) {
			rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
				writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": gen})
			})
			rr.Get("/api/operator-asks", h.OperatorAsks)
			rr.Post("/api/board/{project}/messages", h.PostMessage)
		}
		return newStampWorldMount(t, hubSecret, integrationSecret, mount), h
	}
	call := func(w *stampWorld, method, path, body string, mutate func(*http.Request)) (int, []byte) {
		req, _ := http.NewRequest(method, w.hub.URL+"/api/remote/ssh-box"+path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		mutate(req)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	list := func(w *stampWorld, mutate func(*http.Request)) (int, []map[string]any) {
		code, b := call(w, "GET", "/api/operator-asks", "", mutate)
		var rows []map[string]any
		if code == http.StatusOK {
			require.NoError(t, json.Unmarshal(b, &rows), string(b))
		}
		return code, rows
	}
	none := func(*http.Request) {}
	key := func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") }
	forged := func(r *http.Request) {
		key(r)
		r.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
	}

	w, _ := build(hubowner.RoutesVersion, integrationSecret)
	*w.cookie = true // the signed-in dashboard session of the Hub's owner
	code, rows := list(w, key)
	assert.Equal(t, http.StatusForbidden, code, "a script with the Hub's key is refused")
	code, _ = list(w, forged)
	assert.Equal(t, http.StatusForbidden, code, "a forged stamp is refused")
	code, rows = list(w, none)
	require.Equal(t, http.StatusOK, code, "the owner at the Hub reads the remote's questions")
	require.Len(t, rows, 1)
	assert.Equal(t, "Lead", rows[0]["asker"])
	assert.Contains(t, rows[0]["text"], "which of the two designs")
	id := int64(rows[0]["id"].(float64))
	// answering is the board post the dashboard already makes, as the Operator, replying to the question
	reply, _ := json.Marshal(map[string]any{"subscriber_id": "Operator", "as": "Operator", "content": "@Lead the second one", "reply_to": id})
	code, b := call(w, "POST", "/api/board/team/messages", string(reply), none)
	require.Equal(t, http.StatusOK, code, "the owner answers the question through the Hub: %s", b)
	code, rows = list(w, none)
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, rows, "the answer closed the question")

	// a Hub that holds no secret signs nothing: the signed-in owner is refused, not let through
	w2, _ := build(hubowner.RoutesVersion, "")
	*w2.cookie = true
	code, _ = list(w2, none)
	assert.Equal(t, http.StatusForbidden, code)

	// a remote from before generation 9 reports it: nothing is signed for it, and the remote refuses (the page says an update is needed)
	w3, _ := build(8, integrationSecret)
	*w3.cookie = true
	code, _ = list(w3, none)
	assert.Equal(t, http.StatusForbidden, code, "an older remote refuses the list")
}
