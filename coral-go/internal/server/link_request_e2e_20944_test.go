package server

import (
	"context"
	"encoding/json"
	"regexp"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #20944, #20901 slice 5: two self-hosted Hubs join a Coral already linked to Hub A, each with its own request key, Allow and 8-digit code. Each becomes its own link (own LinkID, the cap that was Allowed), the card
// names the key that asked, a revoked key's Hub cannot ask, and Hub A keeps working throughout.
func TestTwoMoreHubsJoinByKeyAllowAndCode(t *testing.T) {
	ctx := context.Background()
	r, cs, _, a := linkedRemoteWithManager(t)
	store.AllowSecondLinkForTest(t)
	_, err := r.db.ExecContext(ctx, `INSERT OR REPLACE INTO user_settings (key, value) VALUES ('cloud_max_mode', 'launch')`)
	require.NoError(t, err)
	h := r.srv.Router()
	js := map[string]string{"Content-Type": "application/json"}
	readA := func() int {
		return call(h, "GET", "/api/health", "", map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: a.LinkID}).Code
	}
	require.Equal(t, 200, readA())

	keysOf := map[string][2]string{}
	join := func(name, serverID, asked, given string) *store.CloudLink {
		hub, starts := approvingHub(t, serverID, name)
		kid, key := makeKeyForTest(t, h, name)
		keysOf[name] = [2]string{kid, key}
		kj := map[string]string{"Content-Type": "application/json", linkKeyHeader: key}
		rec := call(h, "POST", "/api/cloud/link-requests", `{"hub":"`+hub.URL+`","cap":"`+asked+`"}`, kj)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		var made map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &made))
		id, _ := made["request_id"].(string)
		secret, _ := made["poll_secret"].(string)
		assert.Contains(t, call(h, "GET", "/api/cloud/link-requests", "", js).Body.String(), `"via":"`+name+`"`)
		al := call(h, "POST", "/api/cloud/link-requests/"+id+"/allow", `{"cap":"`+given+`"}`, js)
		require.Equal(t, 200, al.Code, al.Body.String())
		code := regexp.MustCompile(`"code":"(\d{8})"`).FindStringSubmatch(al.Body.String())
		require.Len(t, code, 2)
		fin := call(h, "POST", "/api/cloud/link-requests/"+id+"/finish", `{"poll_secret":"`+secret+`","code":"`+code[1]+`"}`, kj)
		require.Equal(t, 200, fin.Code, fin.Body.String())
		require.EqualValues(t, 1, starts.Load())
		var l *store.CloudLink
		require.Eventually(t, func() bool { l, _ = cs.LinkByOrigin(ctx, hub.URL); return l != nil }, 10*time.Second, 20*time.Millisecond, name+" is linked once its Hub approves")
		return l
	}
	b := join("Hub B", "srv_bbbb2222", "launch", "interact")
	c := join("Hub C", "srv_cccc3333", "view", "view")
	assert.NotEqual(t, a.LinkID, b.LinkID)
	assert.NotEqual(t, b.LinkID, c.LinkID)
	assert.Equal(t, "interact", b.MaxMode, "Hub B got the lower access that was Allowed, not what it asked")
	assert.Equal(t, "view", c.MaxMode)
	ls, _ := cs.ListLinks(ctx)
	assert.Len(t, ls, 3)
	assert.Equal(t, 200, readA(), "Hub A keeps working")
	for _, l := range []*store.CloudLink{b, c} {
		assert.Equal(t, 200, call(h, "GET", "/api/health", "", map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.LinkHeader: l.LinkID}).Code)
	}

	// A revoked key's Hub cannot ask again; the other key still can.
	require.Equal(t, 200, call(h, "DELETE", "/api/cloud/link-keys/"+keysOf["Hub B"][0], "", js).Code)
	body := `{"hub":"https://hub-e.example.com","cap":"view"}`
	assert.Equal(t, 401, call(h, "POST", "/api/cloud/link-requests", body, map[string]string{"Content-Type": "application/json", linkKeyHeader: keysOf["Hub B"][1]}).Code)
	assert.Equal(t, 200, call(h, "POST", "/api/cloud/link-requests", body, map[string]string{"Content-Type": "application/json", linkKeyHeader: keysOf["Hub C"][1]}).Code)
}
