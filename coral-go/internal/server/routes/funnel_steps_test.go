package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/tracking"
)

// What a new agent was first seen doing comes from the list's own reading, by these rules, and nothing is said before it settles.
func TestFunnelAgentStateFromTheListsReading(t *testing.T) {
	cases := []struct {
		name   string
		hasLog bool
		latest string
		age    time.Duration
		in     SessionStateInput
		st     SessionState
		want   string
	}{
		{"gone before any event", true, "", time.Second, SessionStateInput{}, SessionState{Gone: true}, tracking.AgentExitedEarly},
		{"sign-in", true, "", time.Second, SessionStateInput{NeedsLogin: true}, SessionState{}, tracking.AgentWaitingSignin},
		{"trust question", true, "", time.Second, SessionStateInput{StartupPrompt: ptymanager.StartupTrust}, SessionState{}, tracking.AgentWaitingTrust},
		{"another question", true, "", time.Second, SessionStateInput{StartupPrompt: ptymanager.StartupUpdate}, SessionState{}, tracking.AgentWaitingOtherInput},
		{"silent since launch", false, "", time.Minute, SessionStateInput{}, SessionState{NotStarted: true}, tracking.AgentNotStarted},
		{"its first event", true, "prompt_submit", time.Second, SessionStateInput{}, SessionState{}, tracking.AgentReady},
		{"wrote, no question, settled", true, "", 20 * time.Second, SessionStateInput{}, SessionState{}, tracking.AgentReady},
		{"wrote, not settled yet", true, "", 3 * time.Second, SessionStateInput{}, SessionState{}, ""},
		{"nothing yet", false, "", 3 * time.Second, SessionStateInput{}, SessionState{}, ""},
	}
	for _, c := range cases {
		assert.Equal(t, c.want, funnelAgentState(c.hasLog, c.latest, c.age, c.in, c.st), c.name)
	}
}

// The CLI step is a lookup only: found on PATH or in a common place, not found, or found where it cannot be run (a set path that does not resolve).
func TestFunnelCLIStatusIsALookupOnly(t *testing.T) {
	prevLook, prevCommon := cliLookPath, cliCommonPath
	t.Cleanup(func() { cliLookPath, cliCommonPath = prevLook, prevCommon })
	info := agent.GetCLIInfo("claude")
	require.NotNil(t, info)

	cliLookPath = func(name string) (string, error) {
		if name == info.Binary {
			return "/usr/local/bin/" + name, nil
		}
		return "", assert.AnError
	}
	cliCommonPath = func(string) string { return "" }
	assert.Equal(t, tracking.CLIFound, funnelCLIStatus(nil, "claude"))

	cliLookPath = func(string) (string, error) { return "", assert.AnError }
	assert.Equal(t, tracking.CLINotFound, funnelCLIStatus(nil, "claude"))

	cliCommonPath = func(string) string { return "/opt/claude/bin/claude" }
	assert.Equal(t, tracking.CLIFound, funnelCLIStatus(nil, "claude"), "a common place counts as found")

	set := map[string]string{agent.CLIPathSettingKey("claude"): "/nowhere/claude"}
	assert.Equal(t, tracking.CLIUnrunnable, funnelCLIStatus(set, "claude"), "a set path that does not resolve")
}

// The first dashboard load sends one CLI step per tool and, while the welcome items are on, the welcome step; closing items sends one step per item.
func TestFunnelFirstLoadAndWelcomeSteps(t *testing.T) {
	sink := captureAnalytics(t)
	prevLook, prevCommon := cliLookPath, cliCommonPath
	t.Cleanup(func() { cliLookPath, cliCommonPath = prevLook, prevCommon })
	cliLookPath = func(string) (string, error) { return "", assert.AnError }
	cliCommonPath = func(string) string { return "" }

	h := &SystemHandler{} // no settings store: the PATH lookup alone, and no welcome step
	h.FunnelOnDashboardLoaded()
	got := sink.wait(t, tracking.EventFunnelCLIDetected, 4)
	tools := map[string]bool{}
	for _, p := range got {
		tools[p["tool"].(string)] = true
		assert.Equal(t, tracking.CLINotFound, p["status"])
	}
	assert.Equal(t, map[string]bool{"claude": true, "codex": true, "gemini": true, "pi": true}, tools)
	sink.none(t, tracking.EventFunnelWelcomeShown)

	funnelWelcomeSettings(map[string]string{"inbox_welcome_done": "welcome,agent, not-an-item ,C:\\x"})
	funnelWelcomeSettings(map[string]string{"inbox_welcome": "off"})
	done := sink.wait(t, tracking.EventFunnelWelcomeDone, 3)
	steps := map[string]bool{}
	for _, p := range done {
		steps[p["step"].(string)] = true
	}
	assert.Equal(t, map[string]bool{"welcome": true, "agent": true, tracking.WelcomeAllClosed: true}, steps)
	assert.NotContains(t, sink.allRaw(), "not-an-item")
}

// A launch is labelled with the terminal this server runs, not the backend the request names: the dashboard's request says tmux on every launch.
func TestLaunchBackendLabelIsTheServersTerminal(t *testing.T) {
	h := &SessionsHandler{terminal: &ptymanager.PTYSessionTerminal{}}
	for _, requested := range []string{"tmux", "pty", "", "other"} {
		assert.Equal(t, "pty", h.launchBackendLabel(requested), requested)
	}
	h = &SessionsHandler{terminal: &ptymanager.TmuxSessionTerminal{}}
	assert.Equal(t, "tmux", h.launchBackendLabel("pty"))
}
