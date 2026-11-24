package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20944 (design #20901 v5 to v7): a self-hosted Hub's request key. It reaches create, status and finish of its own join request and nothing else.

const linkKeyHeader = "X-Link-Request-Key"

var linkKeyRoutes = [][2]string{
	{"POST", "/api/cloud/link-keys"},
	{"GET", "/api/cloud/link-keys"},
	{"DELETE", "/api/cloud/link-keys/lk-x"},
}

func TestLinkKeyRoutesAreNeverTunneledOrAnAgents(t *testing.T) {
	r, _, _, _ := linkedRemoteWithManager(t)
	h := r.srv.Router()
	via := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	for _, rt := range linkKeyRoutes {
		assert.Equal(t, tunnel.TierNever, tunnel.Classify(rt[0], rt[1], ""), rt[0]+" "+rt[1])
		assert.Equal(t, 403, call(h, rt[0], rt[1], `{"name":"Hub C"}`, via).Code, "never through a Hub: %s %s", rt[0], rt[1])
	}
	srv, ts, _ := strictServer(t, true)
	tok, err := srv.db.MintSessionToken(context.Background(), "sid-dev-20944", "claude-dev")
	require.NoError(t, err)
	for _, rt := range linkKeyRoutes {
		req, _ := http.NewRequest(rt[0], ts.URL+rt[1], strings.NewReader(`{"name":"Hub C"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		assert.Equal(t, http.StatusForbidden, resp.StatusCode, "an agent's token on %s %s", rt[0], rt[1])
	}
}

func makeKeyForTest(t *testing.T, h http.Handler, name string) (id, key string) {
	t.Helper()
	rec := call(h, "POST", "/api/cloud/link-keys", `{"name":"`+name+`"}`, map[string]string{"Content-Type": "application/json"})
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	id, _ = out["id"].(string)
	key, _ = out["key"].(string)
	require.NotEmpty(t, id)
	require.True(t, strings.HasPrefix(key, "lrk_"), key)
	return id, key
}

func TestTheKeyIsShownOnceAndListedWithoutIt(t *testing.T) {
	r, _, _, _ := linkedRemoteWithManager(t)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	id, key := makeKeyForTest(t, h, "Hub C")
	list := call(h, "GET", "/api/cloud/link-keys", "", js)
	require.Equal(t, 200, list.Code, list.Body.String())
	assert.Contains(t, list.Body.String(), "Hub C")
	assert.Contains(t, list.Body.String(), id)
	assert.NotContains(t, list.Body.String(), key)
	assert.NotContains(t, list.Body.String(), strings.TrimPrefix(key, "lrk_"))
	assert.Equal(t, 400, call(h, "POST", "/api/cloud/link-keys", `{"name":""}`, js).Code)
	assert.Equal(t, 200, call(h, "DELETE", "/api/cloud/link-keys/"+id, "", js).Code)
	assert.Equal(t, 404, call(h, "DELETE", "/api/cloud/link-keys/"+id, "", js).Code)
}

func TestAKeyMakesPollsAndFinishesItsOwnJoinAndCannotAllowIt(t *testing.T) {
	r, cs, _, _ := linkedRemoteWithManager(t)
	store.AllowSecondLinkForTest(t)
	_, err := r.db.ExecContext(context.Background(), `INSERT OR REPLACE INTO user_settings (key, value) VALUES ('cloud_max_mode', 'launch')`)
	require.NoError(t, err)
	hub := newStubHub(t)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	_, key := makeKeyForTest(t, h, "Hub C")
	kj := map[string]string{"Content-Type": "application/json", linkKeyHeader: key}

	rec := call(h, "POST", "/api/cloud/link-requests", `{"hub":"`+hub.srv.URL+`","cap":"view"}`, kj)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var made map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &made))
	id, _ := made["request_id"].(string)
	secret, _ := made["poll_secret"].(string)
	feed := call(h, "GET", "/api/cloud/link-requests", "", js)
	assert.Contains(t, feed.Body.String(), `"via":"Hub C"`, "the card says which key asked")

	kp := map[string]string{"Content-Type": "application/json", linkKeyHeader: key, "X-Link-Request-Secret": secret}
	assert.Contains(t, call(h, "GET", "/api/cloud/link-requests/"+id, "", kp).Body.String(), "pending")

	// The key cannot Allow, Deny, read the feed or learn the code.
	for _, rt := range [][2]string{{"POST", "/api/cloud/link-requests/" + id + "/allow"}, {"POST", "/api/cloud/link-requests/" + id + "/deny"}, {"GET", "/api/cloud/link-requests"}} {
		rec := call(h, rt[0], rt[1], `{"cap":"view"}`, kj)
		assert.Equal(t, 403, rec.Code, rt[0]+" "+rt[1])
		assert.Contains(t, rec.Body.String(), "link_key_scope")
	}
	al := call(h, "POST", "/api/cloud/link-requests/"+id+"/allow", `{"cap":"view"}`, js)
	require.Equal(t, 200, al.Code, al.Body.String())
	code := regexp.MustCompile(`"code":"(\d{8})"`).FindStringSubmatch(al.Body.String())
	require.Len(t, code, 2)
	assert.NotContains(t, call(h, "GET", "/api/cloud/link-requests/"+id, "", kp).Body.String(), code[1])
	ok := call(h, "POST", "/api/cloud/link-requests/"+id+"/finish", `{"poll_secret":"`+secret+`","code":"`+code[1]+`"}`, kj)
	require.Equal(t, 200, ok.Code, ok.Body.String())
	assert.EqualValues(t, 1, hub.starts.Load())
	ls, _ := cs.ListLinks(context.Background())
	assert.Len(t, ls, 1, "the Hub's own approval makes the link, as with `links add`")
}

func TestAKeyReachesNothingElseAndABadOneReachesNothing(t *testing.T) {
	r, _, _, _ := linkedRemoteWithManager(t)
	h := r.srv.Router()
	id, key := makeKeyForTest(t, h, "Hub C")
	allowed := map[string]bool{"POST /api/cloud/link-requests": true, "GET /api/cloud/link-requests/{id}": true, "POST /api/cloud/link-requests/{id}/finish": true}
	kj := map[string]string{"Content-Type": "application/json", linkKeyHeader: key}
	n := 0
	require.NoError(t, chi.Walk(h.(chi.Routes), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if allowed[method+" "+route] {
			return nil
		}
		path := regexp.MustCompile(`\{[^}]*\}`).ReplaceAllString(route, "x")
		rec := call(h, method, path, `{}`, kj)
		assert.Equal(t, 403, rec.Code, "%s %s must refuse a request key", method, route)
		assert.Contains(t, rec.Body.String(), "link_key_scope", "%s %s", method, route)
		n++
		return nil
	}))
	assert.Greater(t, n, 100, "the walk covered the routes")

	// A key sent with any other credential, a wrong key, and a revoked key are refused on the routes it may call.
	body := `{"hub":"https://hub-c.example.com","cap":"view"}`
	for name, hdr := range map[string]map[string]string{
		"wrong key":      {"Content-Type": "application/json", linkKeyHeader: key + "0"},
		"not a key":      {"Content-Type": "application/json", linkKeyHeader: "hello"},
		"key and bearer": {"Content-Type": "application/json", linkKeyHeader: key, "Authorization": "Bearer abc"},
		"key and agent":  {"Content-Type": "application/json", linkKeyHeader: key, store.SessionTokenHeader: "tok"},
		"key and a Hub":  {"Content-Type": "application/json", linkKeyHeader: key, tunnel.ViaHeader: cloud.ViaSecret()},
	} {
		rec := call(h, "POST", "/api/cloud/link-requests", body, hdr)
		assert.Contains(t, []int{401, 403}, rec.Code, name)
	}
	require.Equal(t, 200, call(h, "DELETE", "/api/cloud/link-keys/"+id, "", map[string]string{"Content-Type": "application/json"}).Code)
	assert.Equal(t, 401, call(h, "POST", "/api/cloud/link-requests", body, kj).Code, "a revoked key")
}

// #20959: the key that made a request is the only key that finishes it; another key with the right secret and code gets the same 404 as an unknown request, and the real key still finishes.
func TestAnotherKeyCannotFinishARequestEvenWithItsSecretAndCode(t *testing.T) {
	r, _, _, _ := linkedRemoteWithManager(t)
	store.AllowSecondLinkForTest(t)
	_, err := r.db.ExecContext(context.Background(), `INSERT OR REPLACE INTO user_settings (key, value) VALUES ('cloud_max_mode', 'launch')`)
	require.NoError(t, err)
	hub := newStubHub(t)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	_, key1 := makeKeyForTest(t, h, "Hub C")
	_, key2 := makeKeyForTest(t, h, "Hub D")
	k1 := map[string]string{"Content-Type": "application/json", linkKeyHeader: key1}
	k2 := map[string]string{"Content-Type": "application/json", linkKeyHeader: key2}
	rec := call(h, "POST", "/api/cloud/link-requests", `{"hub":"`+hub.srv.URL+`","cap":"view"}`, k1)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var made map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &made))
	id, _ := made["request_id"].(string)
	secret, _ := made["poll_secret"].(string)
	al := call(h, "POST", "/api/cloud/link-requests/"+id+"/allow", `{"cap":"view"}`, js)
	require.Equal(t, 200, al.Code, al.Body.String())
	code := regexp.MustCompile(`"code":"(\d{8})"`).FindStringSubmatch(al.Body.String())
	require.Len(t, code, 2)
	body := `{"poll_secret":"` + secret + `","code":"` + code[1] + `"}`
	assert.Equal(t, 404, call(h, "POST", "/api/cloud/link-requests/"+id+"/finish", body, k2).Code, "the other key")
	assert.EqualValues(t, 0, hub.starts.Load(), "nothing was enrolled")
	assert.Equal(t, 200, call(h, "POST", "/api/cloud/link-requests/"+id+"/finish", body, k1).Code, "the key that asked still finishes")
}

// #20959 (Security INFO 8): making and revoking a request key is in the Operator-actions log with the key's name and who did it, never the key.
func TestMakingAndRevokingAKeyIsInTheOperatorActionsLog(t *testing.T) {
	r, _, _, _ := linkedRemoteWithManager(t)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	id, key := makeKeyForTest(t, h, "Hub C")
	require.Equal(t, 200, call(h, "DELETE", "/api/cloud/link-keys/"+id, "", js).Code)
	ctx := context.Background()
	made, err := r.srv.boardStore.ListActivity(ctx, board.ActivityFilter{Action: board.ActLinkKeyMake, Limit: 10})
	require.NoError(t, err)
	require.Len(t, made, 1)
	assert.Equal(t, id, made[0].ItemID)
	assert.Equal(t, "Hub C", made[0].Title, "the key's name")
	assert.Equal(t, "local", made[0].Actor)
	assert.NotEmpty(t, made[0].Note, "who made it: the caller")
	gone, err := r.srv.boardStore.ListActivity(ctx, board.ActivityFilter{Action: board.ActLinkKeyRevoke, Limit: 10})
	require.NoError(t, err)
	require.Len(t, gone, 1)
	assert.Equal(t, id, gone[0].ItemID)
	assert.Equal(t, "Hub C", gone[0].Title, "the name survives the revoke")
	all, _ := r.srv.boardStore.ListActivity(ctx, board.ActivityFilter{Limit: 50})
	for _, a := range all {
		assert.NotContains(t, a.Note+a.Title+a.ItemID, strings.TrimPrefix(key, "lrk_"), "never the key")
	}
}

// QA2's SHOULD on #20944: a key sent twice, and a good key sent through a Hub, are refused on a call a key may make (removing either check left every test green).
func TestAKeySentTwiceOrThroughAHubIsRefused(t *testing.T) {
	r, _, _, _ := linkedRemoteWithManager(t)
	h := r.srv.Router()
	_, key := makeKeyForTest(t, h, "Hub C")
	_, other := makeKeyForTest(t, h, "Hub D")
	send := func(mut func(*http.Request)) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/cloud/link-requests/lr-none", nil)
		req.Host = "127.0.0.1:8420"
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.RemoteAddr = "127.0.0.1:50000"
		req.Header.Set(linkKeyHeader, key)
		mut(req)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	assert.Equal(t, 404, send(func(*http.Request) {}).Code, "the control: one good key on a call it may make reaches the handler")
	rec := send(func(req *http.Request) { req.Header.Add(linkKeyHeader, key) })
	assert.Equal(t, 403, rec.Code, "the same key twice")
	assert.Contains(t, rec.Body.String(), "link_key_scope")
	rec = send(func(req *http.Request) { req.Header.Add(linkKeyHeader, other) })
	assert.Equal(t, 403, rec.Code, "two different good keys")
	rec = send(func(req *http.Request) { req.Header.Set(tunnel.ViaHeader, cloud.ViaSecret()) })
	assert.Equal(t, 403, rec.Code, "through a Hub (the route classifier refuses it first; the identity layer's own check is a second wall)")
}
