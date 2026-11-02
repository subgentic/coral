package routes

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

const (
	emptyBoxScreen = "──────────────────────────────────────────────────────────────────────\n❯ \n──────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on\n"
	draftBoxScreen = "──────────────────────────────────────────────────────────────────────\n❯ half a sentence\n──────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on\n"
)

// autoSleepTerm is the mock terminal with a screen to read and a process to name (this test process: a tree that uses no CPU between two looks).
type autoSleepTerm struct {
	*mockSessionTerminal
	screen string
	killed []string // the session ids whose terminal was killed without ending the session
}

func (a *autoSleepTerm) KillSessionOnly(ctx context.Context, name, agentType, sessionID string) error {
	a.killed = append(a.killed, sessionID)
	return a.mockSessionTerminal.KillSessionOnly(ctx, name, agentType, sessionID)
}

func (a *autoSleepTerm) AgentScreen(context.Context, string, string, string) (string, error) {
	return a.screen, nil
}
func (a *autoSleepTerm) PanePID(context.Context, string, string, string) (int, error) {
	return os.Getpid(), nil
}

type sleepRig struct {
	h    *SessionsHandler
	term *autoSleepTerm
	ss   *store.SessionStore
	sid  string
	name string
	ctx  context.Context
}

// newSleepRig: one awake Claude agent on a team, whose last event ended a turn just now; a pass at `now + 2h` finds it idle for two hours.
func newSleepRig(t *testing.T) *sleepRig {
	t.Helper()
	_, h, mock, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team := "autosleep"
	sid := uuid.NewString()
	name := naming.SessionName("claude", sid)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "dev", AgentType: "claude", BoardName: &team, WorkingDir: "/tmp"}))
	_, err := h.bs.Subscribe(ctx, team, "dev", "Developer", name, nil, "all")
	require.NoError(t, err)
	mock.addSession(name, "/tmp")
	_, err = h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "dev", SessionID: &sid, EventType: "stop"})
	require.NoError(t, err)
	term := &autoSleepTerm{mockSessionTerminal: mock, screen: emptyBoxScreen}
	h.terminal = term
	return &sleepRig{h: h, term: term, ss: ss, sid: sid, name: name, ctx: ctx}
}

// two passes a minute apart, two hours after the agent's last event: the first takes the process baseline, the second may sleep it
func (r *sleepRig) pass(t *testing.T) *store.LiveSession {
	t.Helper()
	at := time.Now().Add(2 * time.Hour)
	r.h.autoSleepPass(r.ctx, at)
	r.h.autoSleepPass(r.ctx, at.Add(time.Minute))
	ls, err := r.ss.GetLiveSession(r.ctx, r.sid)
	require.NoError(t, err)
	return ls
}

func TestAutoSleepPassSleepsAnIdleAgent(t *testing.T) {
	r := newSleepRig(t)
	ls := r.pass(t)
	assert.Equal(t, 1, ls.IsSleeping, "idle for two hours with nothing in the way: asleep")
	require.NotNil(t, ls.SleepReason)
	assert.Equal(t, store.SleepReasonIdle, *ls.SleepReason)
	st, err := r.ss.AutoSleepStateOf(r.ctx, r.sid)
	require.NoError(t, err)
	assert.NotZero(t, st.SleptAt)
	assert.Equal(t, []string{r.sid}, r.term.killed, "its terminal was killed once")
}

func TestAutoSleepPassFirstLookOnlyTakesTheBaseline(t *testing.T) {
	r := newSleepRig(t)
	r.h.autoSleepPass(r.ctx, time.Now().Add(2*time.Hour))
	ls, _ := r.ss.GetLiveSession(r.ctx, r.sid)
	assert.Equal(t, 0, ls.IsSleeping, "the first look has no earlier CPU reading to compare with: busy")
}

func TestAutoSleepPassLeavesAwakeWhatItMust(t *testing.T) {
	for name, tc := range map[string]struct {
		prep func(t *testing.T, r *sleepRig)
	}{
		"a draft in the box":         {func(t *testing.T, r *sleepRig) { r.term.screen = draftBoxScreen }},
		"an unreadable blank screen": {func(t *testing.T, r *sleepRig) { r.term.screen = "" }},
		"the setting off": {func(t *testing.T, r *sleepRig) {
			require.NoError(t, r.ss.SetSetting(r.ctx, "auto_sleep", "false"))
		}},
		"the agent opted out": {func(t *testing.T, r *sleepRig) { require.NoError(t, r.ss.SetAutoSleepOff(r.ctx, r.sid, true)) }},
		"a claimed task": {func(t *testing.T, r *sleepRig) {
			_, err := r.h.bs.CreateTask(r.ctx, "autosleep", "Do the thing", "", "high", "lead", "dev")
			require.NoError(t, err)
			_, err = r.h.bs.ClaimTask(r.ctx, "autosleep", "dev")
			require.NoError(t, err)
		}},
		"a board wait": {func(t *testing.T, r *sleepRig) {
			_, err := r.h.bs.RegisterWait(r.ctx, "autosleep", "dev", r.name, "message", "", "waiting for a message", 10*time.Minute)
			require.NoError(t, err)
		}},
		"the idle minutes not reached": {func(t *testing.T, r *sleepRig) {
			require.NoError(t, r.ss.SetSetting(r.ctx, "auto_sleep_idle_minutes", "1440"))
		}},
	} {
		t.Run(name, func(t *testing.T) {
			r := newSleepRig(t)
			tc.prep(t, r)
			ls := r.pass(t)
			assert.Equal(t, 0, ls.IsSleeping, name)
		})
	}
}
