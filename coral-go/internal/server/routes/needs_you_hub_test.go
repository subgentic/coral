package routes

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #15380 B: a self-hosted Hub's GET /api/needs-you also reads each computer's own and merges them, for the owner's real sign-in session only.

func asDashSession(r *http.Request) *http.Request { return asPerson(r) } // callerDashCookie: a real sign-in session

func asBrowserNoCookie(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerDashNoCookie))
}

type fakeFleet struct {
	answers map[string]func(w http.ResponseWriter, r *http.Request)
	calls   atomic.Int32
	asked   map[string]string
}

func (f *fakeFleet) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.calls.Add(1)
	id := chi.URLParam(r, "server")
	if f.asked != nil {
		f.asked[id] = r.URL.Path + "?" + r.URL.RawQuery
	}
	fn := f.answers[id]
	if fn == nil {
		http.Error(w, `{"error":"unknown server"}`, http.StatusNotFound)
		return
	}
	fn(w, r)
}

func okJSON(body string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}
}

func hubRig(t *testing.T, fleet *fakeFleet, machines ...store.RemoteServer) *BoardHandler {
	h, _ := operatorAsksRig(t)
	h.SetNeedsYouAgents(func(*http.Request) ([]NeedsYouItem, error) {
		return []NeedsYouItem{{Kind: "agent", From: "Local", Line: "wants to run", Team: "team", ID: "agent:s1", At: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)}}, nil
	})
	h.SetNeedsYouRemotes(&NeedsYouRemotes{List: func(context.Context) ([]store.RemoteServer, error) { return machines, nil }, Proxy: fleet})
	return h
}

func TestHubNeedsYouMergesComputersQualifiesIdsAndSumsCounts(t *testing.T) {
	fleet := &fakeFleet{asked: map[string]string{}, answers: map[string]func(http.ResponseWriter, *http.Request){
		"lab": okJSON(`{"count":3,"counts":{"agent":2,"question":1,"bogus":9},"items":[
		  {"kind":"agent","from":"Dev‮","line":"a\u0007b @all ` + strings.Repeat("x", 400) + `","team":"t","id":"agent:z","at":"2026-11-10T12:00:00Z","goal_title":"G‮1","extra":"dropped","link":"https://evil.example"},
		  {"kind":"nonsense","line":"x","id":"q:9"},
		  {"kind":"question","from":"Lead","line":"ok?","team":"t","id":"ask:5","at":"2026-11-10T12:01:00Z","goal_id":-4,"task_id":7}]}`),
	}}
	h := hubRig(t, fleet,
		store.RemoteServer{ID: "lab", Label: "Lab‮", Status: "online"},
		store.RemoteServer{ID: "attic", Label: "Attic", Status: "offline"})
	code, out := readNeedsYou(t, h, "", asDashSession)
	require.Equal(t, http.StatusOK, code, out)
	assert.EqualValues(t, 1+3, out["count"], "the Hub's own one plus the computer's counts; an unknown kind in counts is dropped")
	counts := out["counts"].(map[string]any)
	assert.EqualValues(t, 3, counts["agent"])
	assert.EqualValues(t, 1, counts["question"])
	assert.NotContains(t, counts, "bogus")
	var lab map[string]any
	for _, it := range needsYouItems(out) {
		if it["server"] == "lab" {
			if it["kind"] == "agent" {
				lab = it
			}
			assert.True(t, strings.HasPrefix(it["id"].(string), "lab/"), "the id is the Hub's own id for the computer, then the computer's: %v", it["id"])
			assert.NotContains(t, it, "link")
			assert.NotContains(t, it, "extra")
		}
		assert.NotEqual(t, "nonsense", it["kind"])
	}
	require.NotNil(t, lab)
	assert.Equal(t, "lab/agent:z", lab["id"])
	for _, f := range []string{"from", "line", "goal_title"} {
		s, _ := lab[f].(string)
		assert.NotContains(t, s, "‮", f)
		assert.NotContains(t, s, "\u0007", f)
		assert.LessOrEqual(t, len([]rune(s)), needsYouLineMax, f)
	}
	for _, it := range needsYouItems(out) {
		if it["id"] == "lab/ask:5" {
			assert.NotContains(t, it, "goal_id", "a negative number is not an id")
			assert.EqualValues(t, 7, it["task_id"])
		}
	}
	machines := out["machines"].([]any)
	require.Len(t, machines, 2)
	assert.Equal(t, map[string]any{"id": "attic", "label": "Attic", "status": "offline"}, machines[0])
	lm := machines[1].(map[string]any)
	assert.Equal(t, "ok", lm["status"])
	assert.NotContains(t, lm["label"], "‮")
	assert.Contains(t, out["not_included"], "unreachable_machines", "an offline computer is named")
	assert.Equal(t, "/api/remote/lab/api/needs-you?limit=50", fleet.asked["lab"])
	assert.NotContains(t, fleet.asked, "attic", "an offline computer is not asked")
}

func TestHubNeedsYouOneFailingComputerNeverFailsTheRead(t *testing.T) {
	big := strings.Repeat(`{"kind":"agent","line":"x","id":"a:1"},`, 20000)
	fleet := &fakeFleet{answers: map[string]func(http.ResponseWriter, *http.Request){
		"ok":   okJSON(`{"counts":{"wait":1},"items":[{"kind":"wait","line":"w","team":"t","id":"w:1","at":"2026-11-10T12:00:00Z"}]}`),
		"e500": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", 500) },
		"gone": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no route", 404) },
		"huge": okJSON(`{"counts":{"agent":1},"items":[` + big + `{"kind":"agent","id":"a:2"}]}`),
		"junk": okJSON(`not json`),
		"slow": func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() },
	}}
	var ms []store.RemoteServer
	for _, id := range []string{"ok", "e500", "gone", "huge", "junk", "slow"} {
		ms = append(ms, store.RemoteServer{ID: id, Label: id, Status: "online"})
	}
	h := hubRig(t, fleet, ms...)
	start := time.Now()
	code, out := readNeedsYou(t, h, "", asDashSession)
	require.Equal(t, http.StatusOK, code, out)
	assert.Less(t, time.Since(start), hubNeedsTotalDeadline+2*time.Second, "the slow computer is cut off")
	assert.EqualValues(t, 1+1, out["count"], "only the computer that answered adds to the count")
	st := map[string]string{}
	for _, m := range out["machines"].([]any) {
		mm := m.(map[string]any)
		st[mm["id"].(string)] = mm["status"].(string)
	}
	assert.Equal(t, map[string]string{"ok": "ok", "e500": "failed", "gone": "failed", "huge": "failed", "junk": "failed", "slow": "failed"}, st)
	assert.Contains(t, out["not_included"], "unreachable_machines")
}

func TestHubNeedsYouIsForTheRealSessionOnly(t *testing.T) {
	fleet := &fakeFleet{answers: map[string]func(http.ResponseWriter, *http.Request){"lab": okJSON(`{"counts":{"agent":5},"items":[]}`)}}
	h := hubRig(t, fleet, store.RemoteServer{ID: "lab", Label: "Lab", Status: "online"})
	// this computer's own browser with sign-in off (a person, but no session): the Hub's own answer, and no call to a computer
	code, out := readNeedsYou(t, h, "", asBrowserNoCookie)
	require.Equal(t, http.StatusOK, code)
	assert.EqualValues(t, 1, out["count"])
	assert.NotContains(t, out, "machines")
	code, _ = readNeedsYou(t, h, "", nil) // no caller kind: not a person, refused as before
	assert.Equal(t, http.StatusForbidden, code)
	// a later page of a read (a cursor) is the Hub's own too
	_, out = readNeedsYou(t, h, "?after=2026-11-10T12:00:00Z", asDashSession)
	assert.NotContains(t, out, "machines")
	assert.EqualValues(t, 0, fleet.calls.Load(), "no remote call was made for any of them")
	// the real session does read
	_, out = readNeedsYou(t, h, "", asDashSession)
	assert.EqualValues(t, 6, out["count"])
	assert.EqualValues(t, 1, fleet.calls.Load())
}

func TestHubNeedsYouKeepsAMergedAnswerForAFewSeconds(t *testing.T) {
	fleet := &fakeFleet{answers: map[string]func(http.ResponseWriter, *http.Request){"lab": okJSON(`{"counts":{"agent":1},"items":[]}`)}}
	h := hubRig(t, fleet, store.RemoteServer{ID: "lab", Label: "Lab", Status: "online"})
	readNeedsYou(t, h, "", asDashSession)
	readNeedsYou(t, h, "", asDashSession)
	assert.EqualValues(t, 1, fleet.calls.Load(), "the second read inside the window asks no computer")
	h.needsYouRemotes.Forget()
	readNeedsYou(t, h, "", asDashSession)
	assert.EqualValues(t, 2, fleet.calls.Load(), "Forget (sign-out, a computer removed) drops what was kept")
}

func TestNonHubNeedsYouIsUnchanged(t *testing.T) {
	h, _ := operatorAsksRig(t)
	h.SetNeedsYouAgents(func(*http.Request) ([]NeedsYouItem, error) { return nil, nil })
	code, out := readNeedsYou(t, h, "", asDashSession)
	require.Equal(t, http.StatusOK, code)
	assert.NotContains(t, out, "machines")
}
