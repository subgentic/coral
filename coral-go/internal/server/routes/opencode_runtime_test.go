package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/opencode"
	"github.com/subgentic/coral/internal/store"
)

type fakeOpencode struct {
	state    opencode.State
	at       time.Time
	known    bool
	stopped  []string
	last     opencode.Message
	haveLast bool
	msgs     []opencode.Message
	haveMsgs bool
	used     []string
}

func (f *fakeOpencode) Ensure(context.Context, string, string, string, string) (*opencode.Server, error) {
	return nil, assert.AnError
}
func (f *fakeOpencode) AgentTurn(string) (opencode.State, time.Time, bool) {
	return f.state, f.at, f.known
}
func (f *fakeOpencode) AgentMessages(context.Context, string) ([]opencode.Message, bool, error) {
	return f.msgs, f.haveMsgs, nil
}
func (f *fakeOpencode) UseSession(key, session string) { f.used = append(f.used, key+"="+session) }
func (f *fakeOpencode) AgentLastMessage(string) (opencode.Message, bool) {
	return f.last, f.haveLast
}
func (f *fakeOpencode) Stop(key string) { f.stopped = append(f.stopped, key) }

func TestAnOpencodeAgentsTurnComesFromItsServersEventStream(t *testing.T) {
	now := time.Now()
	for _, tc := range []struct {
		state opencode.State
		want  string
	}{
		{opencode.StateWorking, "prompt_submit"},
		{opencode.StateIdle, "stop"},
		{opencode.StateFailed, "stop"},
		{opencode.StateNeedsInput, "permission_request"},
	} {
		h := &SessionsHandler{opencode: &fakeOpencode{state: tc.state, at: now, known: true}}
		in := &SessionStateInput{}
		h.applyTranscriptState(in, nil, at.Opencode, "name", "sid", "/w")
		require.Len(t, in.Events, 1, "%s", tc.state)
		assert.Equal(t, tc.want, in.Events[0].Type, "%s", tc.state)
	}
}

func TestAnOpencodeAgentWithNoServerOrNoStreamHasNoTurnAndLaunchesNothingWithoutOne(t *testing.T) {
	h := &SessionsHandler{}
	kind, _ := h.opencodeTurn("sid")
	assert.Empty(t, kind)
	h.opencode = &fakeOpencode{known: false}
	kind, _ = h.opencodeTurn("sid")
	assert.Empty(t, kind, "a stream that has named no session says nothing")

	h.opencode = nil
	_, err := h.launchCommand(context.Background(), agent.GetAgent(at.Opencode), agent.LaunchParams{SessionID: "sid"})
	assert.Error(t, err, "no server manager, no launch")
	h.opencode = &fakeOpencode{}
	_, err = h.launchCommand(context.Background(), agent.GetAgent(at.Opencode), agent.LaunchParams{SessionID: "sid"})
	assert.ErrorIs(t, err, assert.AnError, "a server that cannot start is the launch's error")
}

// An opencode agent has one server: every way the agent ends or sleeps stops it (Security's #137718: one process per agent ever started, and the Mac ran out of processes).
func TestEveryWayAnOpencodeAgentEndsOrSleepsStopsItsServer(t *testing.T) {
	post := func(h *SessionsHandler, pattern, path, body string, handler http.HandlerFunc) {
		r := chi.NewRouter()
		r.Use(testIdentity(h.db))
		r.Post(pattern, handler)
		req := httptest.NewRequest("POST", path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(httptest.NewRecorder(), req)
	}
	for name, do := range map[string]func(h *SessionsHandler, id string){
		"sleep": func(h *SessionsHandler, id string) {
			post(h, "/api/sessions/live/{sessionID}/sleep", "/api/sessions/live/"+id+"/sleep", "{}", h.SleepSession)
		},
		"archive": func(h *SessionsHandler, id string) {
			post(h, "/api/sessions/live/{sessionID}/archive", "/api/sessions/live/"+id+"/archive", "{}", h.ArchiveSession)
		},
		"kill": func(h *SessionsHandler, id string) {
			post(h, "/api/sessions/live/{name}/kill", "/api/sessions/live/opencode-agent/kill", `{"agent_type":"opencode","session_id":"`+id+`"}`, h.Kill)
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, h, _, ss := setupSessionsTestServer(t)
			require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid(1), AgentName: "opencode-agent", AgentType: "opencode", WorkingDir: t.TempDir()}))
			rt := &fakeOpencode{}
			h.SetOpencodeRuntime(rt)
			do(h, sid(1))
			assert.Equal(t, []string{sid(1)}, rt.stopped)
		})
	}
}

func TestAnOpencodeServerIsKeptOnlyForAnAwakeAgentThatIsThere(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid(1), AgentName: "a", AgentType: "opencode", WorkingDir: t.TempDir()}))
	assert.True(t, h.OpencodeAlive(sid(1)), "an awake agent keeps its server")
	assert.False(t, h.OpencodeAlive(sid(2)), "an agent with no row has no use for one")
	require.NoError(t, ss.SetSessionSleeping(ctx, sid(1), true))
	assert.False(t, h.OpencodeAlive(sid(1)), "a sleeping one neither")
}

func TestAnOpencodeAgentsLastMessageIsWhatItsServerGaveAndIsRedactedLikeAnyOther(t *testing.T) {
	h := &SessionsHandler{opencode: &fakeOpencode{last: opencode.Message{Role: "assistant", Text: "done:\n  the build passed", At: "2026-10-30T22:00:00Z"}, haveLast: true}}
	for _, skip := range []bool{false, true} {
		got := lastMessageRow(h, "sid", "/w", at.Opencode, skip, false)
		require.NotNil(t, got, "skipExpensive=%v", skip)
		assert.Equal(t, "assistant", got["role"])
		assert.Equal(t, "done: the build passed", got["text"], "one line, like every agent's")
	}
	h.opencode = &fakeOpencode{}
	assert.Nil(t, lastMessageRow(h, "sid", "/w", at.Opencode, false, false), "no turn has ended yet: no message")
}

func TestAnOpencodeAgentsChatIsItsServersMessagesInTheShapeTheChatReads(t *testing.T) {
	h := &SessionsHandler{opencode: &fakeOpencode{haveMsgs: true, msgs: []opencode.Message{
		{Role: "user", Text: "fix the build", At: "1761862800000"},
		{Role: "assistant", Text: "done", At: "2026-10-30T22:00:00Z"},
	}}}
	tr := h.opencodeTranscript(context.Background(), "sid")
	require.Equal(t, 2, tr.Total)
	all := tr.All(context.Background())
	assert.Equal(t, "user", all[0]["type"])
	assert.Equal(t, "fix the build", all[0]["content"])
	assert.Equal(t, "2025-10-30T22:20:00Z", all[0]["timestamp"], "epoch milliseconds become a time the chat reads")
	assert.Equal(t, "assistant", all[1]["type"])
	assert.Equal(t, "done", all[1]["text"])
	h.opencode = &fakeOpencode{}
	assert.Equal(t, 0, h.opencodeTranscript(context.Background(), "sid").Total, "no history yet is an empty chat, not an error")
	h.opencode = nil
	assert.Equal(t, 0, h.opencodeTranscript(context.Background(), "sid").Total)
}

func TestAnOpencodeLastMessageIsNotCutBeforeItIsRedacted(t *testing.T) {
	long := strings.Repeat("word ", 200) // 1000 characters
	h := &SessionsHandler{opencode: &fakeOpencode{last: opencode.Message{Role: "assistant", Text: long}, haveLast: true}}
	m, ok := h.opencodeLastMessage("sid")
	require.True(t, ok)
	assert.Equal(t, strings.TrimSpace(long), m.Text, "whole: lastMessageField redacts it and only then shows its first characters")
	got := lastMessageRow(h, "sid", "/w", at.Opencode, true, false)
	assert.Len(t, []rune(got["text"].(string)), 140)
}

func TestAResumedOpencodeAgentIsGivenItsStoredSessionAndOnlyAValidOne(t *testing.T) {
	f := &fakeOpencode{}
	h := &SessionsHandler{opencode: f}
	h.useResumedSession(agent.LaunchParams{SessionID: "sid", ResumeSessionID: "ses_abc123"})
	h.useResumedSession(agent.LaunchParams{SessionID: "sid", ResumeSessionID: "../../etc/passwd"})
	h.useResumedSession(agent.LaunchParams{SessionID: "sid"})
	assert.Equal(t, []string{"sid=ses_abc123"}, f.used, "a fresh agent and an id that is not a session id are not passed on")
}

func TestTheModelOfALaunchIsTheLastValidModelFlag(t *testing.T) {
	for flags, want := range map[string]string{
		"--model openai/gpt-6":                      "openai/gpt-6",
		"-m anthropic/claude-x#high":                "anthropic/claude-x#high",
		"--model=openai/gpt-5 --model openai/gpt-6": "openai/gpt-6",
		"--model $(rm -rf x)":                       "",
		"--model gpt-6":                             "",
		"--model":                                   "",
		"--model-x openai/gpt-6":                    "",
		"":                                          "",
	} {
		assert.Equal(t, want, modelFromFlags(strings.Fields(flags)), flags)
	}
}
