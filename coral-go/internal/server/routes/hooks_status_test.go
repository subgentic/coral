package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
)

func hooksRevOf(t *testing.T, ss *store.SessionStore, sid string) int {
	t.Helper()
	revs, err := ss.HooksRevs(context.Background())
	require.NoError(t, err)
	return revs[sid]
}

// #3665: the hook set is recorded per session and only ever goes up.
func TestSetHooksRevOnlyRaises(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	sid := "aaaaaaaa-3665-4000-8000-000000000001"
	require.NoError(t, r.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "a", AgentType: "claude", WorkingDir: t.TempDir()}))
	assert.Zero(t, hooksRevOf(t, r.ss, sid), "unknown at first")
	require.NoError(t, r.ss.SetHooksRev(ctx, sid, 2))
	require.NoError(t, r.ss.SetHooksRev(ctx, sid, 3))
	require.NoError(t, r.ss.SetHooksRev(ctx, sid, 2))
	require.NoError(t, r.ss.SetHooksRev(ctx, sid, 0))
	assert.Equal(t, 3, hooksRevOf(t, r.ss, sid), "a lower or missing revision never lowers it")
}

func hooksStatus(t *testing.T, h *SessionsHandler) []hooksAgent {
	t.Helper()
	w := httptest.NewRecorder()
	h.HooksStatus(w, httptest.NewRequest("GET", "/api/system/hooks-status", nil))
	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Current int          `json:"current"`
		Agents  []hooksAgent `json:"agents"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, agent.ClaudeHooksRev, body.Current)
	return body.Agents
}

// The listing: running Claude agents on an older set or not heard from, by team; current ones,
// sleeping ones (a wake loads the current set) and other CLIs are left out. The recorded column
// survives a restart (the in-memory map doesn't).
func TestHooksStatusListsOlderAndUnknownAgents(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	reg := func(sid, name, team, agentType string) {
		t.Helper()
		require.NoError(t, r.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: name, AgentType: agentType, WorkingDir: t.TempDir(), BoardName: &team}))
	}
	reg("aaaaaaaa-3665-4000-8000-00000000000a", "current", "t1", "claude")
	reg("aaaaaaaa-3665-4000-8000-00000000000b", "older", "t1", "claude")
	reg("aaaaaaaa-3665-4000-8000-00000000000c", "norev", "t0", "claude")
	reg("aaaaaaaa-3665-4000-8000-00000000000d", "unknown", "t1", "claude")
	reg("aaaaaaaa-3665-4000-8000-00000000000e", "codex", "t1", "codex")
	reg("aaaaaaaa-3665-4000-8000-00000000000f", "asleep", "t1", "claude")
	require.NoError(t, r.ss.SetHooksRev(ctx, "aaaaaaaa-3665-4000-8000-00000000000a", agent.ClaudeHooksRev))
	require.NoError(t, r.ss.SetHooksRev(ctx, "aaaaaaaa-3665-4000-8000-00000000000b", 2))
	r.h.hooksNoRev.Store("aaaaaaaa-3665-4000-8000-00000000000c", true) // events without a revision
	require.NoError(t, r.ss.SetSessionSleeping(ctx, "aaaaaaaa-3665-4000-8000-00000000000f", true))

	got := hooksStatus(t, r.h)
	var lines []string
	for _, a := range got {
		lines = append(lines, a.Team+"/"+a.Name+":"+a.Status+":"+strconv.Itoa(a.Rev))
	}
	// The revision is there when one is recorded (older: 2); an agent whose events carry none, and one never
	// heard from, have 0, which is what lets the dashboard say which is which.
	assert.Equal(t, []string{"t0/norev:older:0", "t1/older:older:2", "t1/unknown:unknown:0"}, lines)

	// An event with the current revision moves it off the list.
	r.h.hooksRev.Store("aaaaaaaa-3665-4000-8000-00000000000d", agent.ClaudeHooksRev)
	assert.Len(t, hooksStatus(t, r.h), 2)
}

func refreshHooks(t *testing.T, h *SessionsHandler, sid, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/sessions/live/"+sid+"/refresh-hooks", strings.NewReader(body))
	rc := chi.NewRouteContext()
	rc.URLParams.Add("sessionID", sid)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	w := httptest.NewRecorder()
	h.RefreshHooks(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// Resuming one agent on the current hooks: an idle agent is slept and woken (the same session,
// awake again, the current set recorded); a busy one gets 409 unless the Operator confirmed;
// asleep or another CLI is refused.
func TestRefreshHooksResumesAnIdleAgent(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	sid := "aaaaaaaa-3665-4000-8000-000000000011"
	require.NoError(t, r.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "dev", AgentType: "claude", WorkingDir: t.TempDir()}))
	require.NoError(t, r.ss.SetHooksRev(ctx, sid, 2))

	code, out := refreshHooks(t, r.h, sid, "")
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, out["ok"], "%v", out)
	ls, err := r.ss.GetLiveSession(ctx, sid)
	require.NoError(t, err)
	assert.Equal(t, 0, ls.IsSleeping, "awake again, same session")
	assert.Equal(t, agent.ClaudeHooksRev, hooksRevOf(t, r.ss, sid), "the wake launched it with the current set")

	// Busy: a turn is running (its latest event is a prompt).
	id := sid
	_, err = r.h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "dev", SessionID: &id, EventType: "prompt_submit", Summary: "User submitted prompt"})
	require.NoError(t, err)
	code, out = refreshHooks(t, r.h, sid, "")
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "busy", out["code"])
	code, out = refreshHooks(t, r.h, sid, `{"force":true}`)
	assert.Equal(t, http.StatusOK, code, "the Operator confirmed: %v", out)

	require.NoError(t, r.ss.SetSessionSleeping(ctx, sid, true))
	code, out = refreshHooks(t, r.h, sid, "")
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, "sleeping", out["code"])

	codexID := "aaaaaaaa-3665-4000-8000-000000000012"
	require.NoError(t, r.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: codexID, AgentName: "cx", AgentType: "codex", WorkingDir: t.TempDir()}))
	code, _ = refreshHooks(t, r.h, codexID, "")
	assert.Equal(t, http.StatusBadRequest, code, "only Claude has a hook set")
}

// #3685 (Security's SHOULD on #3665): two refresh-hooks at once never sleep and wake the agent
// twice. While one holds the session, every parallel request gets 409 "refreshing"; once it is
// done (whatever its answer) the next one runs.
func TestRefreshHooksParallelRequestsGetRefreshing(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	sid := "aaaaaaaa-3685-4000-8000-000000000001"
	require.NoError(t, r.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "dev", AgentType: "claude", WorkingDir: t.TempDir()}))

	held, release := make(chan struct{}), make(chan struct{})
	var taken atomic.Bool // only the first holder waits: without the lock the others run on and fail
	r.h.onRefreshHeld = func(string) {
		if taken.CompareAndSwap(false, true) {
			close(held)
			<-release
		}
	}
	first := make(chan int, 1)
	go func() {
		code, _ := refreshHooks(t, r.h, sid, "")
		first <- code
	}()
	<-held

	const n = 8
	codes := make(chan string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, out := refreshHooks(t, r.h, sid, `{"force":true}`)
			codes <- fmt.Sprintf("%d %v", code, out["code"])
		}()
	}
	wg.Wait()
	close(codes)
	for c := range codes {
		assert.Equal(t, "409 refreshing", c, "a parallel request, even forced")
	}
	close(release)
	assert.Equal(t, http.StatusOK, <-first, "the first one resumes the agent")

	code, out := refreshHooks(t, r.h, sid, "")
	assert.Equal(t, http.StatusOK, code, "done: the next request runs (%v)", out)
	code, _ = refreshHooks(t, r.h, "aaaaaaaa-3685-4000-8000-00000000dead", "")
	assert.Equal(t, http.StatusNotFound, code)
	code, _ = refreshHooks(t, r.h, "aaaaaaaa-3685-4000-8000-00000000dead", "")
	assert.Equal(t, http.StatusNotFound, code, "an early answer releases the session too")
}

// #6089: running agents of any type whose hook programs are gone from the folder they were started with are listed under "missing", once each, so the dashboard can flag them on their rows.
func TestHooksStatusListsAgentsWhoseHookProgramsAreGone(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	reg := func(sid, name, agentType, dir string, asleep bool) {
		t.Helper()
		team := "t1"
		require.NoError(t, r.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: name, AgentType: agentType, WorkingDir: t.TempDir(), BoardName: &team}))
		if dir != "" {
			require.NoError(t, r.ss.SetHookDir(ctx, sid, dir))
		}
		if asleep {
			require.NoError(t, r.ss.SetSessionSleepingFor(ctx, sid, store.SleepReasonHooksUpdate))
		}
	}
	gone := filepath.Join(t.TempDir(), "Coral.app", "Contents", "MacOS") // the app was replaced: nothing is there
	here := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(here, "coral-hook-agentic-state"), []byte("x"), 0o755))
	reg("bbbbbbbb-6089-4000-8000-00000000000a", "claude-gone", "claude", gone, false)
	reg("bbbbbbbb-6089-4000-8000-00000000000b", "codex-gone", "codex", gone, false)
	reg("bbbbbbbb-6089-4000-8000-00000000000c", "fine", "claude", here, false)
	reg("bbbbbbbb-6089-4000-8000-00000000000d", "nothing-recorded", "codex", "", false)
	reg("bbbbbbbb-6089-4000-8000-00000000000e", "asleep-gone", "claude", gone, true) // a wake starts it with the tools that are there now

	w := httptest.NewRecorder()
	r.h.HooksStatus(w, httptest.NewRequest("GET", "/api/system/hooks-status", nil))
	require.Equal(t, http.StatusOK, w.Code)
	var body struct {
		Missing []hooksAgent `json:"missing"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	var names []string
	for _, a := range body.Missing {
		names = append(names, a.Name)
		assert.Equal(t, "missing", a.Status)
	}
	assert.Equal(t, []string{"claude-gone", "codex-gone"}, names, "awake agents of any type whose tools folder is gone; none that are fine, unrecorded or asleep")
}

// #11107: a Pi agent's hooks are the extension Coral starts it with, and its first hook event is the handshake. A launch is no proof, so the status says so only for an agent Coral launched in this server run
// that has been silent for a minute; it never lists what it cannot be sure of, and it never touches the agent's state.
func TestHooksStatusListsPiAgentsWhoseExtensionNeverReported(t *testing.T) {
	r := newWakeRig(t)
	ctx := context.Background()
	reg := func(sid, name, agentType string) {
		t.Helper()
		team := "t1"
		require.NoError(t, r.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: name, AgentType: agentType, WorkingDir: t.TempDir(), BoardName: &team}))
	}
	const silent, fresh, said, restarted, unknown, asleep, other = "bbbbbbbb-11107-4000-8000-000000000001", "bbbbbbbb-11107-4000-8000-000000000002", "bbbbbbbb-11107-4000-8000-000000000003", "bbbbbbbb-11107-4000-8000-000000000004", "bbbbbbbb-11107-4000-8000-000000000005", "bbbbbbbb-11107-4000-8000-000000000006", "bbbbbbbb-11107-4000-8000-000000000007"
	reg(silent, "silent", "pi")
	reg(fresh, "fresh", "pi")
	reg(said, "said", "pi")
	reg(restarted, "restarted", "pi")
	reg(unknown, "unknown", "pi")
	reg(asleep, "asleep", "pi")
	reg(other, "claude", "claude")
	require.NoError(t, r.ss.SetSessionSleeping(ctx, asleep, true))
	now := time.Now()
	r.h.piLaunchedAt.Store(silent, now.Add(-2*time.Minute))
	r.h.piLaunchedAt.Store(fresh, now.Add(-10*time.Second))
	r.h.piLaunchedAt.Store(said, now.Add(-2*time.Minute))
	r.h.hooksRev.Store(said, agent.PiExtensionRev) // its first event carried the revision
	r.h.piLaunchedAt.Store(restarted, now.Add(-2*time.Minute))
	r.h.piLaunchedAt.Store(asleep, now.Add(-2*time.Minute))
	// unknown: an agent started before this server run has no launch time

	sessions, err := r.ss.GetAllLiveSessions(ctx)
	require.NoError(t, err)
	var names []string
	for _, a := range r.h.piHooksInactive(sessions, now) {
		names = append(names, a.Name+":"+a.Status)
	}
	assert.ElementsMatch(t, []string{"silent:inactive", "restarted:inactive"}, names, "only a Pi agent launched in this server run and silent for a minute; one that said it, one that is fresh, one with no launch time, a sleeping one and another CLI are not listed")

	// A restart or wake starts the clock again and forgets what an earlier run of the session said.
	r.h.hooksRev.Store(restarted, agent.PiExtensionRev)
	r.h.noteLaunchedHooks(ctx, restarted, "pi")
	_, said2 := r.h.hooksRev.Load(restarted)
	assert.False(t, said2, "a launch forgets the earlier handshake: only an event from the new run counts")
	var after []string
	for _, a := range r.h.piHooksInactive(sessions, now.Add(30*time.Second)) {
		after = append(after, a.Name)
	}
	assert.NotContains(t, after, "restarted", "its clock restarted at the launch: not yet a minute")
	var later []string
	for _, a := range r.h.piHooksInactive(sessions, now.Add(2*time.Minute)) {
		later = append(later, a.Name)
	}
	assert.Contains(t, later, "restarted", "a minute after the new launch with no event, it is listed again")

	// The route lists them next to the other statuses.
	req := httptest.NewRequest("GET", "/api/system/hooks-status", nil)
	w := httptest.NewRecorder()
	r.h.HooksStatus(w, req)
	var body struct {
		PiInactive []hooksAgent `json:"pi_inactive"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.NotNil(t, body.PiInactive, "the field is always there (an empty list at none)")
}
