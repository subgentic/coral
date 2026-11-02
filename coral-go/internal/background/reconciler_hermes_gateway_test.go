package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #12052 (the Hermes tester's run, three agents at once): one Hermes was refused by its own gateway start ("Another gateway already owns this host", status 75) and left its pane at the shell: a live-looking agent that
// never started. A Hermes agent at its shell with that refusal on the screen, launched a while ago, is marked "failed to start" (hermes_gateway_refused), a fixed reason with a fixed sentence (never the CLI's own text);
// Wake tries again. It only marks.
const hermesRefusal = "Error: Gateway could not start: the gateway exited with status 75 before it could serve:\n  ❌ Another gateway already owns this host: owner unknown (its record is gone)\n     Exactly one gateway per host serves every profile, so this process will not start a\n     second one (it would double-bind this profile's platforms).\ntester@host:~/work$ "

func TestReconciler_AHermesWhoseGatewayWasRefusedIsMarkedFailedToStart(t *testing.T) {
	ss, rt, r := newMissingCLIFixture(t)
	r.now = func() time.Time { return time.Now().Add(2 * time.Minute) } // the preparation of a new home and the gateway take a while before it is refused
	ctx := context.Background()
	registerAwake(t, ss, "hermes", testUUID)
	rt.listed = []AgentInfo{{AgentType: "hermes", SessionID: testUUID}}
	name := FormatSessionName("hermes", testUUID)
	rt.set(name, "bash")
	rt.screens[name] = hermesRefusal

	r.reconcileOnce(ctx)
	assert.True(t, isSleeping(t, ss, testUUID))
	ls, err := ss.GetLiveSession(ctx, testUUID)
	require.NoError(t, err)
	require.NotNil(t, ls.SleepReason)
	assert.Equal(t, store.SleepReasonAgentExited, *ls.SleepReason, "it ended")
	require.NotNil(t, ls.StartFailure)
	assert.Equal(t, store.StartFailureHermesGateway, *ls.StartFailure, "and why, in the fixed code")
	assert.Empty(t, rt.killed)
	assert.Zero(t, rt.sends, "nothing is typed into the terminal")
}

func TestReconciler_TheHermesRefusalIsNotAFailedStartWhenHermesIsRunningOrAnotherAgentOrLongAgo(t *testing.T) {
	for name, tc := range map[string]struct {
		agent, fg string
		now       time.Duration
	}{
		"hermes still running (its CLI is the foreground)": {"hermes", "node", 2 * time.Minute},
		"another agent type printed the same words":        {"claude", "bash", 2 * time.Minute},
		"long after the launch it is an ordinary exit":     {"hermes", "bash", 3 * time.Hour},
	} {
		t.Run(name, func(t *testing.T) {
			ss, rt, r := newMissingCLIFixture(t)
			d := tc.now
			r.now = func() time.Time { return time.Now().Add(d) }
			ctx := context.Background()
			registerAwake(t, ss, tc.agent, testUUID)
			rt.listed = []AgentInfo{{AgentType: tc.agent, SessionID: testUUID}}
			sn := FormatSessionName(tc.agent, testUUID)
			rt.set(sn, tc.fg)
			rt.screens[sn] = hermesRefusal
			r.reconcileOnce(ctx)
			ls, err := ss.GetLiveSession(ctx, testUUID)
			require.NoError(t, err)
			if ls.StartFailure != nil {
				assert.NotEqual(t, store.StartFailureHermesGateway, *ls.StartFailure, name)
			}
		})
	}
}

// Another Hermes error at the shell is not this refusal.
func TestReconciler_AnotherHermesErrorIsNotTheGatewayRefusal(t *testing.T) {
	ss, rt, r := newMissingCLIFixture(t)
	r.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	ctx := context.Background()
	registerAwake(t, ss, "hermes", testUUID)
	rt.listed = []AgentInfo{{AgentType: "hermes", SessionID: testUUID}}
	name := FormatSessionName("hermes", testUUID)
	rt.set(name, "bash")
	rt.screens[name] = "hermes: the model returned an error\ntester@host:~/work$ "
	r.reconcileOnce(ctx)
	ls, err := ss.GetLiveSession(ctx, testUUID)
	require.NoError(t, err)
	if ls.StartFailure != nil {
		assert.NotEqual(t, store.StartFailureHermesGateway, *ls.StartFailure)
	}
}

// #12213: Hermes exited during its first-use setup (a dependency fetch failed): the same mark, with its own fixed reason.
const hermesSetupFailure = "hermes: source-update completion failed: venv: uv sync exited 2\n  cause: Failed to fetch: https://pypi.org/simple/wheel/\nhermes: no dependency environment is committed for this install; run `hermes pm repair`\ntester@host:~/work$ "

func TestReconciler_AHermesThatStoppedInItsFirstUseSetupIsMarkedFailedToStartWithItsOwnReason(t *testing.T) {
	ss, rt, r := newMissingCLIFixture(t)
	r.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	ctx := context.Background()
	registerAwake(t, ss, "hermes", testUUID)
	rt.listed = []AgentInfo{{AgentType: "hermes", SessionID: testUUID}}
	name := FormatSessionName("hermes", testUUID)
	rt.set(name, "bash")
	rt.screens[name] = hermesSetupFailure

	r.reconcileOnce(ctx)
	assert.True(t, isSleeping(t, ss, testUUID))
	ls, err := ss.GetLiveSession(ctx, testUUID)
	require.NoError(t, err)
	require.NotNil(t, ls.SleepReason)
	assert.Equal(t, store.SleepReasonAgentExited, *ls.SleepReason)
	require.NotNil(t, ls.StartFailure)
	assert.Equal(t, store.StartFailureHermesSetup, *ls.StartFailure, "a fixed code, never Hermes's own text")
	assert.Empty(t, rt.killed)
	assert.Zero(t, rt.sends, "nothing is typed into the terminal")
}

func TestReconciler_TheHermesSetupFailureIsNotAFailedStartWhenHermesIsRunningOrAnotherAgentOrLongAgo(t *testing.T) {
	for name, tc := range map[string]struct {
		agent, fg string
		now       time.Duration
	}{
		"hermes still running":                    {"hermes", "node", 2 * time.Minute},
		"another agent type printed the words":    {"claude", "bash", 2 * time.Minute},
		"long after the launch, an ordinary exit": {"hermes", "bash", 3 * time.Hour},
	} {
		t.Run(name, func(t *testing.T) {
			ss, rt, r := newMissingCLIFixture(t)
			d := tc.now
			r.now = func() time.Time { return time.Now().Add(d) }
			ctx := context.Background()
			registerAwake(t, ss, tc.agent, testUUID)
			rt.listed = []AgentInfo{{AgentType: tc.agent, SessionID: testUUID}}
			sn := FormatSessionName(tc.agent, testUUID)
			rt.set(sn, tc.fg)
			rt.screens[sn] = hermesSetupFailure
			r.reconcileOnce(ctx)
			ls, err := ss.GetLiveSession(ctx, testUUID)
			require.NoError(t, err)
			if ls.StartFailure != nil {
				assert.NotEqual(t, store.StartFailureHermesSetup, *ls.StartFailure, name)
			}
		})
	}
}
