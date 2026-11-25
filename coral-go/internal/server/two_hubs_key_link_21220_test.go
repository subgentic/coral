package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// asPerson sends a join call as the dashboard of the person at the hub does (a same-origin browser request on that computer).
func asPerson(t *testing.T, h *e2eHub, method, path string, body any) (int, []byte) {
	t.Helper()
	var b []byte
	if body != nil {
		b, _ = json.Marshal(body)
	}
	req, err := http.NewRequest(method, h.ts.URL+path, bytes.NewReader(b))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	return h.send(req)
}

// joinFromHub is a self-hosted Hub's whole join of the key world's computer with key: the person at the hub starts it, the person at the computer Allows (at given), the person at the hub types
// the code. It returns the hub's own address as the computer knows it.
func joinFromHub(t *testing.T, w *keyLinkWorld, h *e2eHub, serverID, key, asked, given string) {
	t.Helper()
	code, b := asPerson(t, h, "POST", "/api/servers/join", map[string]any{"id": serverID, "label": "Box", "url": w.r.url(), "cap": asked, "allow_private": true, "key": key})
	require.Equal(t, 200, code, string(b))
	var started map[string]string
	require.NoError(t, json.Unmarshal(b, &started))
	join := started["join"]
	require.NotEmpty(t, join)
	assert.NotContains(t, string(b), key, "the key is never in a reply")
	code, b = asPerson(t, h, "GET", "/api/servers/join/"+join, nil)
	require.Equal(t, 200, code, string(b))
	assert.JSONEq(t, `{"state":"pending"}`, string(b))

	// at the computer: the person sees this hub's request and Allows it
	feed := call(w.h, "GET", "/api/cloud/link-requests", "", nil)
	require.Equal(t, 200, feed.Code, feed.Body.String())
	var reqs struct {
		Requests []struct{ ID, Hub string } `json:"requests"`
	}
	require.NoError(t, json.Unmarshal(feed.Body.Bytes(), &reqs))
	id := ""
	for _, r := range reqs.Requests {
		if r.Hub == h.ts.URL {
			id = r.ID
		}
	}
	require.NotEmpty(t, id, "the computer's person sees the request under the hub's own address: %s", feed.Body.String())
	al := call(w.h, "POST", "/api/cloud/link-requests/"+id+"/allow", `{"cap":"`+given+`"}`, map[string]string{"Content-Type": "application/json"})
	require.Equal(t, 200, al.Code, al.Body.String())
	m := regexp.MustCompile(`"code":"(\d{8})"`).FindStringSubmatch(al.Body.String())
	require.Len(t, m, 2)

	code, b = asPerson(t, h, "GET", "/api/servers/join/"+join, nil)
	require.Equal(t, 200, code, string(b))
	assert.JSONEq(t, `{"state":"allowed"}`, string(b))
	wrong := "00000000"
	if m[1] == wrong {
		wrong = "11111111"
	}
	code, b = asPerson(t, h, "POST", "/api/servers/join/"+join+"/code", map[string]string{"code": wrong})
	assert.Equal(t, 403, code, "a wrong code: %s", b)
	code, b = asPerson(t, h, "POST", "/api/servers/join/"+join+"/code", map[string]string{"code": m[1]})
	require.Equal(t, 201, code, string(b))
	assert.Contains(t, string(b), `"key_kind":"link"`)
	assert.NotContains(t, string(b), key)
}

// #21220, the task's own test: one Coral, two self-hosted Hubs (each its own data folder), both join it with their own request key at their own level, both reach it through their proxy at that
// level; revoking one Hub's key ends that Hub's reach and leaves the other's. No request either Hub sent carried a request key as Authorization.
func TestTwoSelfHostedHubsJoinOneComputerByKeyAndRevokingOneLeavesTheOther(t *testing.T) {
	env := newE2EEnv(t)
	w := newKeyLinkWorld(t)
	hubA := newE2EHub(t, env, "", true)
	hubB := newE2EHub(t, env, "", true)
	keyA, kA := makeKeyForTest(t, w.h, "Hub A")
	_, kB := makeKeyForTest(t, w.h, "Hub B")

	// a key the computer never Allowed reaches nothing through a hub: refused at the start, before any join
	code, _ := asPerson(t, hubA, "POST", "/api/servers/join", map[string]any{"id": "box", "url": w.r.url(), "cap": "view", "allow_private": true, "key": "lrk_00000000_" + strings.Repeat("0", 32)})
	assert.Equal(t, 502, code, "a wrong key")
	code, _ = hubA.do("POST", "/api/servers/join", map[string]any{"id": "box", "url": w.r.url(), "cap": "view", "allow_private": true, "key": kA})
	assert.Equal(t, 403, code, "a call that is not the person at the hub (no browser) starts no join")

	joinFromHub(t, w, hubA, "box", kA, "view", "view")
	joinFromHub(t, w, hubB, "box", kB, "launch", "interact")

	reach := func(h *e2eHub) int { c, _ := h.do("GET", "/api/remote/box/api/sessions/live", nil); return c }
	require.Eventually(t, func() bool { return reach(hubA) == 200 }, 10*time.Second, 50*time.Millisecond, "hub A reaches the computer")
	require.Eventually(t, func() bool { return reach(hubB) == 200 }, 10*time.Second, 50*time.Millisecond, "hub B reaches the computer")
	c, _ := hubA.do("GET", "/api/remote/box/api/settings", nil)
	assert.Equal(t, 403, c, "an Operator-only route of the computer is no Hub's")

	// revoke hub A's key at the computer: hub A is refused, hub B is not
	require.Equal(t, 200, call(w.h, "DELETE", "/api/cloud/link-keys/"+keyA, "", map[string]string{"Content-Type": "application/json"}).Code)
	require.Eventually(t, func() bool { return reach(hubA) != 200 }, 5*time.Second, 50*time.Millisecond, "hub A's reach ends with its key")
	assert.Equal(t, 200, reach(hubB), "hub B's link is untouched")

	w.r.mu.Lock()
	defer w.r.mu.Unlock()
	for _, r := range w.r.reqs {
		assert.NotContains(t, r.Auth, "lrk_", "a request key is never sent as Authorization: %s %s", r.Method, r.Path)
	}
}
