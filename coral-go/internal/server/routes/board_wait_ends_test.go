package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
)

// A wait ends when the agent shows it is not parked (#7765): it posts, claims a task or completes one. An agent woken by a task nudge, working again, kept "waiting for a message from the
// Orchestrator" in the status and the health check until it ran coral-board wait --cancel (Antigravity Tester's #7763 report). The awaited event still resolves the wait as before.
type waitRig struct {
	t   *testing.T
	srv *httptest.Server
	h   *BoardHandler
}

func newWaitRig(t *testing.T) *waitRig {
	t.Helper()
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewBoardHandler(bs)
	t.Cleanup(h.WaitBackground)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			switch a := req.Header.Get("X-Test-Actor"); {
			case strings.HasPrefix(a, "token:"):
				req = withActor(req, Actor{Kind: ActorToken, Name: strings.TrimPrefix(a, "token:")})
			case a == "operator":
				req = withActor(req, Actor{Kind: ActorOperator, Name: "Operator"})
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Post("/api/board/{project}/messages", h.PostMessage)
	r.Post("/api/board/{project}/tasks/claim", h.ClaimTask)
	r.Post("/api/board/{project}/tasks/{taskID}/complete", h.CompleteTaskByID)
	r.Get("/api/board/{project}/waits/poll", h.PollWait)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	was := identityActorEnforced()
	setIdentityActorEnforced(true)
	t.Cleanup(func() { setIdentityActorEnforced(was) })
	ctx := context.Background()
	for _, m := range [][2]string{{"Lead", "Orchestrator"}, {"Worker", "Developer"}, {"Other", "Developer"}} {
		_, err := bs.Subscribe(ctx, "team", m[0], m[1], "claude-"+m[0], nil, "all")
		require.NoError(t, err)
	}
	return &waitRig{t: t, srv: srv, h: h}
}

func (w *waitRig) do(method, path, body, actor string) int {
	w.t.Helper()
	req, err := http.NewRequest(method, w.srv.URL+path, bytes.NewBufferString(body))
	require.NoError(w.t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Test-Actor", actor)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(w.t, err)
	defer resp.Body.Close()
	return resp.StatusCode
}

func (w *waitRig) wait(member, from string) {
	w.t.Helper()
	_, err := w.h.bs.RegisterWait(context.Background(), "team", member, "claude-"+member, "message", from, "", time.Hour)
	require.NoError(w.t, err)
}

func (w *waitRig) parked(member string) bool {
	w.t.Helper()
	got, err := w.h.bs.GetActiveWait(context.Background(), "team", member)
	require.NoError(w.t, err)
	return got != nil
}

func TestAPostByAParkedAgentEndsItsWaitAndNobodyElsesDoes(t *testing.T) {
	w := newWaitRig(t)
	w.wait("Worker", "Lead")
	w.wait("Lead", "Nobody")

	// not its post: the Operator's, another agent's, a Hub's
	assert.Equal(t, 200, w.do("POST", "/api/board/team/messages", `{"content":"from the operator"}`, "operator"))
	assert.Equal(t, 200, w.do("POST", "/api/board/team/messages", `{"subscriber_id":"Other","content":"another agent"}`, "token:Other"))
	assert.True(t, w.parked("Worker"), "the Operator's and another agent's posts do not unpark it")

	// its own: it is awake
	assert.Equal(t, 200, w.do("POST", "/api/board/team/messages", `{"subscriber_id":"Worker","content":"working on it"}`, "token:Worker"))
	assert.False(t, w.parked("Worker"), "an agent that posts is not waiting any more")
	assert.True(t, w.parked("Lead"), "and another agent's wait is untouched")
}

func TestClaimingOrCompletingATaskEndsTheAgentsWait(t *testing.T) {
	w := newWaitRig(t)
	ctx := context.Background()
	first, err := w.h.bs.CreateTask(ctx, "team", "First", "", "medium", "Lead", "Worker")
	require.NoError(t, err)

	w.wait("Worker", "Lead") // woken by a task nudge, not by the Orchestrator's message
	assert.Equal(t, 200, w.do("POST", "/api/board/team/tasks/claim", `{"subscriber_id":"Worker","task_id":`+itoa(first.ID)+`}`, "token:Worker"))
	assert.False(t, w.parked("Worker"), "claiming a task ends the wait")

	w.wait("Worker", "Lead")
	assert.Equal(t, 200, w.do("POST", "/api/board/team/tasks/"+itoa(first.ID)+"/complete", `{"subscriber_id":"Worker","message":"done"}`, "token:Worker"))
	assert.False(t, w.parked("Worker"), "completing one does too")
}

func TestTheAwaitedSendersPostStillResolvesTheWait(t *testing.T) {
	w := newWaitRig(t)
	w.wait("Worker", "Lead")
	w.wait("Lead", "Nobody") // the poster's own wait, on someone else, ends with its post
	got := make(chan map[string]any, 1)
	go func() {
		req, _ := http.NewRequest("GET", w.srv.URL+"/api/board/team/waits/poll?subscriber_id=Worker&timeout=5", nil)
		req.Header.Set("X-Test-Actor", "token:Worker")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			got <- map[string]any{"error": err.Error()}
			return
		}
		defer resp.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&body)
		got <- body
	}()
	time.Sleep(150 * time.Millisecond) // sleep-ok: the poll is now asleep on its wait
	assert.Equal(t, 200, w.do("POST", "/api/board/team/messages", `{"subscriber_id":"Lead","content":"here you go"}`, "token:Lead"))
	select {
	case body := <-got:
		assert.Equal(t, "resolved", body["status"], "the wait on Lead is resolved by Lead's post, as before")
	case <-time.After(6 * time.Second):
		t.Fatal("the poll did not end")
	}
	assert.False(t, w.parked("Lead"), "and Lead, who posted, is not parked on its own wait")
}

// The status never reports "waiting" for an agent that has a task in progress and is working: whatever wait is left, it is not parked.
func TestAnAgentWorkingOnATaskIsNotReportedAsWaiting(t *testing.T) {
	wait := &board.RegisteredWait{WaitType: "message", TargetID: "Orchestrator"}
	tasks := []availabilityTask{{Status: "in_progress"}}
	live := store.LiveSession{AgentType: "claude"}

	var a availableAgent
	a.Tasks = tasks
	classifyAvailability(&a, live, true, true, SessionState{Working: true}, true, wait)
	assert.Equal(t, "busy", a.Availability, "working on its task: busy, whatever wait is left")
	assert.Nil(t, a.WaitingOn)

	var idle availableAgent
	idle.Tasks = tasks
	classifyAvailability(&idle, live, true, true, SessionState{}, true, wait)
	assert.Equal(t, "waiting", idle.Availability, "parked and idle: still waiting, unchanged")
	assert.NotNil(t, idle.WaitingOn)

	var noTask availableAgent
	classifyAvailability(&noTask, live, true, true, SessionState{}, true, wait)
	assert.Equal(t, "waiting", noTask.Availability, "no task in progress: unchanged")
}
