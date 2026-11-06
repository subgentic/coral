package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/hubowner"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #13757, the Orchestrator's SHOULD: the Markdown editor's save must work through the two real ways a Hub reaches this computer, neither of which carries the browser's Origin, Referer or
// Sec-Fetch-Site (the self-hosted Hub's proxy strips the browser's headers; Coral Hub's tunnel is the connector's request): a genuine owner stamp on an API-key request, and an authentic tunnel
// request from the enrolled owner. The same-origin check stays for the dashboard's own cookie.

// bare is a request as a Hub makes it: loopback, no browser headers at all.
func bare(h http.Handler, method, target, body string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Host = "127.0.0.1:8420"
	req.RemoteAddr = "127.0.0.1:50000"
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestTheMarkdownSaveWorksThroughAStampedProxyAndATunnelledOwnerAndRefusesEverythingElse(t *testing.T) {
	r := newE2ERemote(t, "edit-hub", nil)
	setHome(t, r.dir)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	ctx := t.Context()

	sid := r.launchDirectTerminal(t, r.work)
	name := r.sessionNameFor(sid)
	require.Equal(t, 200, call(h, "POST", "/api/board/team/subscribe", `{"subscriber_id":"Dev","job_title":"Dev","session_name":"`+name+`"}`, js).Code)
	upload := func(content string) string {
		rec := call(h, "POST", "/api/agent/artifacts?session_id="+sid, content, map[string]string{"X-Artifact-Name": "plan.md", "X-Artifact-Media-Type": "text/markdown"})
		require.Equal(t, 201, rec.Code, rec.Body.String())
		var out struct{ Digest string }
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return strings.TrimPrefix(out.Digest, "sha256:")
	}
	v1 := upload("# plan\n")

	editPath := func(opened, expected string) string {
		return "/api/board/team/artifacts/" + opened + "/edit?expected_latest=" + expected
	}
	req := func(opened, expected string) (string, string) { return "POST", editPath(opened, expected) }

	// 1. The self-hosted Hub: the API key and a genuine stamp over method, path and query, and the body; no browser headers.
	secret, err := hubowner.NewSecret()
	require.NoError(t, err)
	require.NoError(t, hubowner.WriteFile(r.cfg.CoralDir(), "edit-hub", secret))
	stamp := func(method, target, body string) map[string]string {
		u, perr := url.Parse(target)
		require.NoError(t, perr)
		s, serr := hubowner.Sign(secret, "edit-hub", method, hubowner.Target(u), []byte(body), time.Now())
		require.NoError(t, serr)
		return map[string]string{"Authorization": "Bearer " + r.key(), hubowner.Header: s, "Content-Type": "text/markdown; charset=utf-8"}
	}
	m, target := req(v1, v1)
	key := map[string]string{"Authorization": "Bearer " + r.key(), "Content-Type": "text/markdown; charset=utf-8"}
	rec := bare(h, m, target, "# plan, edited\n", key)
	assert.Equal(t, 403, rec.Code, "the API key alone is no person: %s", rec.Body.String())
	rec = bare(h, m, target, "# plan, edited\n", stamp(m, target, "another body"))
	assert.Equal(t, 403, rec.Code, "a stamp for other bytes is refused: %s", rec.Body.String())
	rec = bare(h, m, target, "# plan, edited\n", stamp(m, target, "# plan, edited\n"))
	require.Equal(t, 201, rec.Code, "the stamped save goes through with no Origin: %s", rec.Body.String())
	var saved map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &saved))
	assert.EqualValues(t, 2, saved["version"])
	v2, _ := saved["id"].(string)
	rows, aerr := r.srv.boardStore.ListActivity(ctx, board.ActivityFilter{Team: "team", Action: board.ActFileEdit, Limit: 10})
	require.NoError(t, aerr)
	require.Len(t, rows, 1, "the owner's stamped save is one row of the Activity record")
	assert.Equal(t, v2, rows[0].ItemID)
	// NOT asserted: the row's source and actor. activityMetaFor marks only a tunnelled request as a Hub's; a stamped self-hosted-Hub request is recorded as "local" today (reported on #13757 as a follow-up).
	// the signed query is the compare-and-swap: a stamp over ?expected_latest=v1 cannot be replayed for another value, and a stale one is a 409
	m, target = req(v1, v1)
	rec = bare(h, m, target, "# plan, again\n", stamp(m, target, "# plan, again\n"))
	assert.Equal(t, 409, rec.Code, "saved against v1 when v2 is the newest: %s", rec.Body.String())
	m2, target2 := req(v1, v2)
	forged := stamp(m, target, "# plan, again\n") // signed for ?expected_latest=v1
	rec = bare(h, m2, target2, "# plan, again\n", forged)
	assert.Equal(t, 403, rec.Code, "the expected value is bound by the stamp: %s", rec.Body.String())

	// 2. Coral Hub's tunnel: the enrolled owner, an authentic connector request, no browser headers.
	r.srv.cloudHandler.SetLinkedCheck(func() bool { return true })
	cs := store.NewCloudStore(r.db, store.NewRemoteServerStore(r.db, r.cfg.CoralDir()))
	require.NoError(t, cs.Save(ctx, "https://hub.example.invalid", "srv_1", "L", "coralhub_srv_abcd1234_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"))
	pinned, err := cs.PinOwnerUser(ctx, "srv_1", "hub-user-1234abcd")
	require.NoError(t, err)
	require.True(t, pinned)
	require.Equal(t, 200, call(h, "PUT", "/api/cloud/max-mode", `{"mode":"launch"}`, js).Code)
	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd", "Content-Type": "text/markdown; charset=utf-8"}
	grantee := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "hub-user-9999ffff", "Content-Type": "text/markdown; charset=utf-8"}
	m, target = req(v1, v2)
	assert.Equal(t, 403, bare(h, m, target, "# via the tunnel\n", grantee).Code, "a grantee cannot edit")
	rec = bare(h, m, target, "# via the tunnel\n", owner)
	require.Equal(t, 201, rec.Code, "the enrolled owner's tunnelled save goes through with no Origin: %s", rec.Body.String())
	rec = bare(h, "GET", "/api/board/team/artifacts/"+v1+"/edit", "", owner)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"version":3`)

	// 3. Neither a Hub nor the dashboard: a request with no stamp, no tunnel and no cookie of this computer is refused (the same-origin check for a cookie's save is pinned in the route tests).
	m, target = req(v1, v2)
	rec = bare(h, m, target, "# from nowhere\n", map[string]string{"Content-Type": "text/markdown; charset=utf-8"})
	assert.Equal(t, 403, rec.Code, rec.Body.String())
}
