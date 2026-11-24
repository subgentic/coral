package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/live"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

const liveHub = "11111111-2222-3333-4444-555555555555"

// openLiveHandler is a handler with its gate open (the real one is a const, shut) and a fixed machine id.
func openLiveHandler(h *BoardHandler) *LiveHandler {
	lh := NewLiveHandler(h)
	lh.open = true
	lh.machineID = func() (string, error) { return "machine-1", nil }
	lh.hubLinks = func(context.Context) []HubLinkInfo {
		return []HubLinkInfo{{ID: "lnk-11111111", Label: "Acme Hub", Active: true}}
	}
	return lh
}

type liveCall struct {
	method, path, body string
	id                 string
	fn                 func(*LiveHandler) http.HandlerFunc
}

func liveRoutes() []liveCall {
	return []liveCall{
		{"GET", "/api/live/links", "", "", func(l *LiveHandler) http.HandlerFunc { return l.ListLinks }},
		{"POST", "/api/live/links", `{"hub_link":"` + liveHub + `","team":"team"}`, "", func(l *LiveHandler) http.HandlerFunc { return l.CreateLink }},
		{"PUT", "/api/live/links/L/views", `{}`, "L", func(l *LiveHandler) http.HandlerFunc { return l.SetViews }},
		{"GET", "/api/live/links/L/preview", "", "L", func(l *LiveHandler) http.HandlerFunc { return l.Preview }},
		{"POST", "/api/live/links/L/go-live", `{"hash":"x","read":true}`, "L", func(l *LiveHandler) http.HandlerFunc { return l.GoLive }},
		{"POST", "/api/live/links/L/reconfirm", `{}`, "L", func(l *LiveHandler) http.HandlerFunc { return l.Reconfirm }},
		{"POST", "/api/live/links/L/pause", `{}`, "L", func(l *LiveHandler) http.HandlerFunc { return l.Pause }},
		{"POST", "/api/live/links/L/resume", `{"hash":"x"}`, "L", func(l *LiveHandler) http.HandlerFunc { return l.Resume }},
		{"POST", "/api/live/links/L/stop", `{}`, "L", func(l *LiveHandler) http.HandlerFunc { return l.Stop }},
	}
}

func (c liveCall) do(lh *LiveHandler, body string, mod func(*http.Request)) (int, map[string]any) {
	if body == "" {
		body = c.body
	}
	req := httptest.NewRequest(c.method, c.path, bytes.NewReader([]byte(body)))
	rctx := chi.NewRouteContext()
	if c.id != "" {
		rctx.URLParams.Add("id", c.id)
	}
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	if mod != nil {
		mod(req)
	}
	rec := httptest.NewRecorder()
	c.fn(lh)(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func livePerson(r *http.Request) {
	*r = *r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerDashCookie))
}

func TestLiveRoutesAreClosedWhileTheGateIsShut(t *testing.T) {
	require.False(t, live.Open)
	_, h := setupBoardTestServer(t)
	lh := NewLiveHandler(h)
	for _, c := range liveRoutes() {
		code, out := c.do(lh, "", livePerson)
		assert.Equal(t, http.StatusNotFound, code, c.method+" "+c.path)
		assert.Equal(t, "live_closed", out["error"], c.method+" "+c.path)
	}
	assert.Nil(t, lh.mgr, "a shut gate made no manager and touched no file")
}

// MUST C: all three refusals for every route that widens or acts (an agent token, a Hub-stamped request, a caller that is not a livePerson).
func TestEveryLiveRouteRefusesAnAgentTheHubAndAScript(t *testing.T) {
	_, h := setupBoardTestServer(t)
	lh := openLiveHandler(h)
	agent := func(r *http.Request) {
		livePerson(r)
		r.Header.Set(store.SessionTokenHeader, "some-agent-token")
	}
	hub := func(r *http.Request) {
		livePerson(r)
		r.Header.Set(tunnel.ViaHeader, "1")
	}
	for _, c := range liveRoutes() {
		for name, mod := range map[string]func(*http.Request){"agent token": agent, "through the Hub": hub, "a script (no caller kind)": nil} {
			code, out := c.do(lh, "", mod)
			assert.Equal(t, http.StatusForbidden, code, c.method+" "+c.path+" "+name)
			assert.Equal(t, "operator_only", out["error"], c.method+" "+c.path+" "+name)
		}
	}
	assert.Nil(t, lh.mgr, "a refused caller reached nothing")
}

func TestLiveRoutesNeverGoThroughTheHub(t *testing.T) {
	for _, c := range liveRoutes() {
		assert.Equal(t, tunnel.TierNever, tunnel.Classify(c.method, c.path, ""), c.method+" "+c.path)
	}
}

func TestTheLiveFlowThroughTheRoutes(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Backend Dev", "backend", "sess-be", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "QA Engineer", "qa", "sess-qa", nil, "all")
	require.NoError(t, err)
	lh := openLiveHandler(h)
	by := map[string]liveCall{}
	for _, c := range liveRoutes() {
		by[c.method+" "+c.path] = c
	}
	list, create := by["GET /api/live/links"], by["POST /api/live/links"]

	code, out := list.do(lh, "", livePerson)
	require.Equal(t, http.StatusOK, code)
	require.Equal(t, []any{}, out["links"], "links is an object with a list, empty at first")

	for _, bad := range []string{`{"hub_link":"https://hub/live#x","team":"team"}`, `{"hub_link":"` + liveHub + `","team":"nope"}`, `{"hub_link":"` + liveHub + `","team":"team","extra":1}`} {
		code, _ = create.do(lh, bad, livePerson)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
	code, out = create.do(lh, "", livePerson)
	require.Equal(t, http.StatusOK, code, "%v", out)
	id := out["id"].(string)
	assert.Equal(t, "draft", out["state"])
	assert.Equal(t, liveHub, out["hub"])
	agents := out["agents"].([]any)
	require.Len(t, agents, 2)
	first := agents[0].(map[string]any)
	assert.Equal(t, "Backend Dev", first["key"])
	assert.Equal(t, false, first["chat"])
	assert.NotContains(t, first, "generation", "the generation stays on the computer")

	call := func(method, tail, body string) (int, map[string]any) {
		var c liveCall
		for _, r := range liveRoutes() {
			if r.method == method && strings.HasSuffix(r.path, tail) {
				c = r
			}
		}
		c.id = id
		return c.do(lh, body, livePerson)
	}
	code, out = call("PUT", "/views", `{"chat_key":"Backend Dev"}`)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "chat_unavailable", out["error"], "chat is the chat slice's")
	code, out = call("PUT", "/views", `{"period_days":120}`)
	assert.Equal(t, "bad_period", out["error"])
	code, out = call("PUT", "/views", `{"hide":{"qa":true}}`)
	assert.Equal(t, http.StatusBadRequest, code, "there is no per-agent hide")
	code, out = call("PUT", "/views", `{"period_days":30,"expires_in":"7d","delay_s":60}`)
	require.Equal(t, http.StatusOK, code, "%v", out)

	code, out = call("GET", "/preview", "")
	require.Equal(t, http.StatusOK, code)
	hash := out["hash"].(string)
	frame := out["frame"].(map[string]any)
	assert.Len(t, frame["agents"], 2)

	code, out = call("POST", "/go-live", `{"hash":"stale","read":true}`)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "bad_hash", out["error"])
	code, out = call("POST", "/go-live", `{"hash":"`+hash+`","read":false}`)
	assert.Equal(t, "not_read", out["error"])
	code, out = call("POST", "/go-live", `{"hash":"`+hash+`","read":true}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "live", out["state"])
	for _, k := range []string{"live_since", "confirmed_at", "reconfirm_due", "pause_at", "notice_at"} {
		assert.NotNil(t, out[k], k)
	}
	assert.Equal(t, "Operator", out["created_by"])
	assert.Equal(t, "7d", out["expires_in"])

	// after go-live a draft edit leaves the live view as it was, and the response says which is which
	code, out = call("PUT", "/views", `{"period_days":10,"expires_in":"24h","delay_s":300}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "7d", out["expires_in"], "the live card reads the approved view")
	assert.EqualValues(t, 60, out["delay_s"])
	draft := out["draft"].(map[string]any)
	assert.Equal(t, "24h", draft["expires_in"], "the draft is its own object")
	assert.EqualValues(t, 300, draft["delay_s"])
	for _, a := range out["agents"].([]any) {
		assert.Equal(t, true, a.(map[string]any)["in_view"])
	}
	_, err = h.bs.Subscribe(ctx, "team", "Late Joiner", "ux", "sess-late", nil, "all")
	require.NoError(t, err)
	_, out = call("PUT", "/views", `{"period_days":10,"expires_in":"24h","delay_s":300}`)
	late := map[string]any{}
	for _, a := range out["agents"].([]any) {
		m := a.(map[string]any)
		late[m["key"].(string)] = m["in_view"]
	}
	assert.Equal(t, false, late["Late Joiner"], "an agent that joined after go-live is not in the live view")
	assert.Equal(t, true, late["Backend Dev"])
	code, out = call("PUT", "/views", `{"period_days":30,"expires_in":"7d","delay_s":60}`)
	require.Equal(t, http.StatusOK, code)

	code, out = call("POST", "/reconfirm", `{}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	code, out = call("POST", "/pause", `{}`)
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, "paused", out["state"])
	assert.Equal(t, "owner", out["paused_reason"])
	code, out = call("POST", "/resume", `{"hash":"stale"}`)
	assert.Equal(t, "bad_hash", out["error"])
	code, out = call("GET", "/preview", "")
	code, out = call("POST", "/resume", `{"hash":"`+out["hash"].(string)+`"}`)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "live", out["state"])
	code, out = call("POST", "/stop", "")
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "stopped", out["state"])

	raw, _ := json.Marshal(out)
	assert.NotContains(t, string(raw), "http", "no route answers a URL")
}

// Security's MUST on #21047: a link is stored with a hash of this computer's machine id (never the id), and a different one, or none, brings a live link back paused.
func TestALiveLinkStoredOnAnotherComputerComesBackPaused(t *testing.T) {
	_, h := setupBoardTestServer(t)
	h.coralDir = t.TempDir()
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Backend Dev", "backend", "sess-be", nil, "all")
	require.NoError(t, err)
	lh := openLiveHandler(h)
	m, err := lh.manager()
	require.NoError(t, err)
	l, err := m.Create(liveHub, "team", "Operator", "lnk-11111111")
	require.NoError(t, err)
	p, err := m.Preview(ctx, l.ID)
	require.NoError(t, err)
	_, err = m.GoLive(ctx, l.ID, p.Hash, true)
	require.NoError(t, err)

	raw, err := os.ReadFile(filepath.Join(h.coralDir, "live_links.json"))
	require.NoError(t, err)
	require.NotContains(t, string(raw), "machine-1", "the machine id itself is never stored")
	require.Contains(t, string(raw), `"computer":"`)

	same := openLiveHandler(h)
	m2, err := same.manager()
	require.NoError(t, err)
	got, _ := m2.Get(l.ID)
	require.Equal(t, live.StateLive, got.State)

	other := openLiveHandler(h)
	other.machineID = func() (string, error) { return "machine-2", nil }
	m3, err := other.manager()
	require.NoError(t, err)
	got, _ = m3.Get(l.ID)
	require.Equal(t, live.StatePaused, got.State)
	require.Equal(t, live.ReasonRestart, got.PausedReason)
}

// Condition 6: a link is made through one of this computer's own active Hub links: the one named, the only one there is, or it is refused.
func TestCreateNeedsOneOfThisComputersActiveHubLinks(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Backend Dev", "backend", "sess-be", nil, "all")
	require.NoError(t, err)
	lh := openLiveHandler(h)
	var create liveCall
	for _, c := range liveRoutes() {
		if c.method == "POST" && c.path == "/api/live/links" {
			create = c
		}
	}
	body := func(via string) string {
		if via == "" {
			return `{"hub_link":"` + liveHub + `","team":"team"}`
		}
		return `{"hub_link":"` + liveHub + `","team":"team","via":"` + via + `"}`
	}
	lh.hubLinks = func(context.Context) []HubLinkInfo { return nil }
	code, out := create.do(lh, body(""), livePerson)
	require.Equal(t, http.StatusBadRequest, code)
	require.Equal(t, "bad_via", out["error"], "no active Hub link")
	lh.hubLinks = func(context.Context) []HubLinkInfo {
		return []HubLinkInfo{{ID: "lnk-aaaaaaaa", Active: true}, {ID: "lnk-bbbbbbbb", Active: true}}
	}
	code, out = create.do(lh, body(""), livePerson)
	require.Equal(t, "bad_via", out["error"], "two to pick from: the person names one")
	code, out = create.do(lh, body("lnk-cccccccc"), livePerson)
	require.Equal(t, "bad_via", out["error"], "not one of this computer's links")
	code, out = create.do(lh, body("lnk-bbbbbbbb"), livePerson)
	require.Equal(t, http.StatusOK, code, "%v", out)
}

// #21073: a link returns the Hub link it pushes through: id, the name the person gave it (never a URL), and whether it is active now.
func TestALinkReturnsTheHubLinkItUsesWithItsNameNeverAURL(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Backend Dev", "backend", "sess-be", nil, "all")
	require.NoError(t, err)
	lh := openLiveHandler(h)
	var create, list liveCall
	for _, c := range liveRoutes() {
		switch c.method + " " + c.path {
		case "POST /api/live/links":
			create = c
		case "GET /api/live/links":
			list = c
		}
	}
	code, out := create.do(lh, `{"hub_link":"`+liveHub+`","team":"team"}`, livePerson)
	require.Equal(t, http.StatusOK, code, "%v", out)
	require.Equal(t, map[string]any{"id": "lnk-11111111", "name": "Acme Hub", "active": true}, out["via"])

	lh.hubLinks = func(context.Context) []HubLinkInfo { // renamed to a URL, and paused
		return []HubLinkInfo{{ID: "lnk-11111111", Label: "https://hub.example/x?k=secret", Active: false}}
	}
	_, out = list.do(lh, "", livePerson)
	via := out["links"].([]any)[0].(map[string]any)["via"]
	require.Equal(t, map[string]any{"id": "lnk-11111111", "name": "", "active": false}, via)

	lh.hubLinks = func(context.Context) []HubLinkInfo { return nil } // gone
	_, out = list.do(lh, "", livePerson)
	require.Equal(t, map[string]any{"id": "lnk-11111111", "name": "", "active": false}, out["links"].([]any)[0].(map[string]any)["via"])
}
