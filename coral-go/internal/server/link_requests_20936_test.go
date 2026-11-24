package server

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20936 (design #20901 v4): a second Hub asks to join. These routes are the person at this computer's: never tunneled, never an agent's.

var linkRequestRoutes = [][2]string{
	{"POST", "/api/cloud/link-requests"},
	{"GET", "/api/cloud/link-requests"},
	{"GET", "/api/cloud/link-requests/req-x"},
	{"POST", "/api/cloud/link-requests/req-x/allow"},
	{"POST", "/api/cloud/link-requests/req-x/deny"},
	{"POST", "/api/cloud/link-requests/req-x/finish"},
}

func TestLinkRequestRoutesAreNeverTunneled(t *testing.T) {
	r, _, _, _ := linkedRemoteWithManager(t)
	h := r.srv.Router()
	via := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), "Content-Type": "application/json"}
	for _, rt := range linkRequestRoutes {
		assert.Equal(t, tunnel.TierNever, tunnel.Classify(rt[0], rt[1], ""), rt[0]+" "+rt[1])
		assert.Equal(t, 403, call(h, rt[0], rt[1], `{"hub":"https://hub-c.example.com","cap":"view"}`, via).Code, "never through a Hub: %s %s", rt[0], rt[1])
	}
}

func TestLinkRequestRoutesRefuseAnAgentToken(t *testing.T) {
	srv, ts, _ := strictServer(t, true)
	agentTok, err := srv.db.MintSessionToken(context.Background(), "sid-dev-20936", "claude-dev")
	require.NoError(t, err)
	for _, rt := range linkRequestRoutes {
		req, _ := http.NewRequest(rt[0], ts.URL+rt[1], strings.NewReader(`{"hub":"https://hub-c.example.com","cap":"view"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, agentTok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		assert.Equal(t, http.StatusForbidden, resp.StatusCode, "an agent's token on %s %s", rt[0], rt[1])
	}
}

func TestASecondHubJoinsByRequestAllowAndCode(t *testing.T) {
	r, cs, _, _ := linkedRemoteWithManager(t)
	store.AllowSecondLinkForTest(t)
	_, err := r.db.ExecContext(context.Background(), `INSERT OR REPLACE INTO user_settings (key, value) VALUES ('cloud_max_mode', 'launch')`)
	require.NoError(t, err)
	hub := newStubHub(t)
	js := map[string]string{"Content-Type": "application/json"}
	h := r.srv.Router()

	rec := call(h, "POST", "/api/cloud/link-requests", `{"hub":"`+hub.srv.URL+`","cap":"interact"}`, js)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var made struct {
		ID, Secret string
	}
	var raw map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
	made.ID, _ = raw["request_id"].(string)
	made.Secret, _ = raw["poll_secret"].(string)
	require.NotEmpty(t, made.ID)
	require.NotEmpty(t, made.Secret)
	assert.Zero(t, hub.starts.Load(), "a request asks the Hub for nothing")
	ls, _ := cs.ListLinks(context.Background())
	assert.Len(t, ls, 1, "a request links nothing")

	// The feed (the card) shows the Hub and the access asked, never the secret or a code.
	feed := call(h, "GET", "/api/cloud/link-requests", "", js)
	require.Equal(t, 200, feed.Code, feed.Body.String())
	assert.Contains(t, feed.Body.String(), made.ID)
	assert.Contains(t, feed.Body.String(), hub.srv.URL)
	assert.NotContains(t, feed.Body.String(), made.Secret)

	// Finish before Allow: refused.
	fin := `{"poll_secret":"` + made.Secret + `","code":"12345678"}`
	assert.Equal(t, 409, call(h, "POST", "/api/cloud/link-requests/"+made.ID+"/finish", fin, js).Code)

	// Allow gives the code, once.
	al := call(h, "POST", "/api/cloud/link-requests/"+made.ID+"/allow", `{"cap":"interact"}`, js)
	require.Equal(t, 200, al.Code, al.Body.String())
	code := regexp.MustCompile(`"code":"(\d{8})"`).FindStringSubmatch(al.Body.String())
	require.Len(t, code, 2, al.Body.String())
	assert.Equal(t, 409, call(h, "POST", "/api/cloud/link-requests/"+made.ID+"/allow", `{"cap":"interact"}`, js).Code, "no second code")
	sec := map[string]string{"Content-Type": "application/json", "X-Link-Request-Secret": made.Secret}
	for _, p := range []string{"/api/cloud/link-requests", "/api/cloud/link-requests/" + made.ID} {
		body := call(h, "GET", p, "", sec).Body.String()
		assert.NotContains(t, body, code[1], "the code is in no read: "+p)
	}
	st := call(h, "GET", "/api/cloud/link-requests/"+made.ID, "", sec)
	assert.Contains(t, st.Body.String(), `"allowed"`)

	// A wrong code is refused and counted; the right one starts the existing enroll to the Hub that was allowed.
	wrong := "00000000"
	if wrong == code[1] {
		wrong = "11111111"
	}
	assert.Equal(t, 403, call(h, "POST", "/api/cloud/link-requests/"+made.ID+"/finish", `{"poll_secret":"`+made.Secret+`","code":"`+wrong+`"}`, js).Code)
	assert.Zero(t, hub.starts.Load())
	ok := call(h, "POST", "/api/cloud/link-requests/"+made.ID+"/finish", `{"poll_secret":"`+made.Secret+`","code":"`+code[1]+`"}`, js)
	require.Equal(t, 200, ok.Code, ok.Body.String())
	assert.Contains(t, ok.Body.String(), "ABCD-EFGH", "the Hub's own approval code, as `links add` shows it")
	assert.EqualValues(t, 1, hub.starts.Load())
	// Single use.
	assert.Equal(t, 404, call(h, "POST", "/api/cloud/link-requests/"+made.ID+"/finish", `{"poll_secret":"`+made.Secret+`","code":"`+code[1]+`"}`, js).Code)
	assert.EqualValues(t, 1, hub.starts.Load())
}

func TestDenyAndTheEarlyRefusalsMakeNoCard(t *testing.T) {
	r, _, _, l := linkedRemoteWithManager(t)
	store.AllowSecondLinkForTest(t)
	js := map[string]string{"Content-Type": "application/json"}
	h := r.srv.Router()
	for _, body := range []string{
		`{"hub":"https://hub-c.example.com","cap":"root"}`,
		`{"hub":"https://u:p@hub-c.example.com","cap":"view"}`,
		`{"hub":"` + l.HubOrigin + `","cap":"view"}`, // already linked
		`{"hub":"https://` + strings.Repeat("a", 90) + `.example.com","cap":"view"}`,
	} {
		rec := call(h, "POST", "/api/cloud/link-requests", body, js)
		assert.GreaterOrEqual(t, rec.Code, 400, body)
		assert.Less(t, rec.Code, 500, body)
	}
	feed := call(h, "GET", "/api/cloud/link-requests", "", js)
	assert.NotContains(t, feed.Body.String(), "hub-c")
	assert.Contains(t, feed.Body.String(), `[]`)

	ok := call(h, "POST", "/api/cloud/link-requests", `{"hub":"https://hub-c.example.com","cap":"view"}`, js)
	require.Equal(t, 200, ok.Code, ok.Body.String())
	var m map[string]any
	require.NoError(t, json.Unmarshal(ok.Body.Bytes(), &m))
	id := m["request_id"].(string)
	assert.Equal(t, 200, call(h, "POST", "/api/cloud/link-requests/"+id+"/deny", `{}`, js).Code)
	assert.NotContains(t, call(h, "GET", "/api/cloud/link-requests", "", js).Body.String(), id)
	st := call(h, "GET", "/api/cloud/link-requests/"+id, "", map[string]string{"X-Link-Request-Secret": m["poll_secret"].(string)})
	assert.Contains(t, st.Body.String(), `"denied"`)
	bad := map[string]string{"X-Link-Request-Secret": "wrong"}
	assert.Equal(t, 404, call(h, "GET", "/api/cloud/link-requests/"+id, "", bad).Code, "a wrong secret and an unknown request look the same")
	assert.Equal(t, 404, call(h, "GET", "/api/cloud/link-requests/req-unknown", "", bad).Code)
}
