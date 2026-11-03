package routes

import (
	"context"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/ptymanager"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/tracking"
)

// The server's own steps of the new-user funnel (#7455). Each value is decided here, from Coral's own state, never taken from the page or a request.

// funnelCLITools are the agent CLIs the funnel looks for, with the funnel's name for each (agy is the Gemini family's CLI).
var funnelCLITools = []struct{ agentType, tool string }{
	{at.Claude, "claude"}, {at.Codex, "codex"}, {at.Agy, "gemini"}, {at.Pi, "pi"},
}

// FunnelOnDashboardLoaded runs once per process after the first dashboard page loaded (tracking.OnDashboardLoaded): which agent CLIs this computer has,
// and whether the new-install welcome items are on.
func (h *SystemHandler) FunnelOnDashboardLoaded() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var settings map[string]string
	if h.ss != nil {
		settings, _ = h.ss.GetSettingsForCLI(ctx) // unreadable: the PATH lookup alone
	}
	for _, c := range funnelCLITools {
		tracking.TrackCLIDetected(c.tool, funnelCLIStatus(settings, c.agentType))
	}
	if settings != nil && setreg.Enum(settings, "inbox_welcome") == "on" {
		tracking.TrackWelcomeShown()
	}
}

// funnelCLIStatus is whether an agent CLI is there, by lookup only: nothing is run. A path set in Settings that cannot be run, or a CLI in a folder Windows will
// not open, is unrunnable.
func funnelCLIStatus(settings map[string]string, agentType string) string {
	info := agent.GetCLIInfo(agentType)
	if info == nil {
		return tracking.CLINotFound
	}
	if p := agent.ResolveCLIPath(settings, agentType); p != "" {
		resolved, err := cliLookPath(p)
		if err != nil || agent.CheckRunnable(resolved) != nil {
			return tracking.CLIUnrunnable
		}
		return tracking.CLIFound
	}
	resolved, err := cliLookPath(info.Binary)
	if err != nil {
		resolved = cliCommonPath(info.Binary)
	}
	if resolved == "" {
		return tracking.CLINotFound
	}
	if _, bad := agent.UntrustedMountDir(resolved); bad {
		return tracking.CLIUnrunnable
	}
	return tracking.CLIFound
}

// funnelWelcomeSettings reports the welcome items a settings write closed: each id in inbox_welcome_done (checked against the fixed ids by the tracking package),
// and all of them when inbox_welcome goes off.
func funnelWelcomeSettings(values map[string]string) {
	if setreg.Has(values, "inbox_welcome_done") {
		for _, id := range strings.Split(setreg.Raw(values, "inbox_welcome_done"), ",") { // the saved list as written: each id is checked against the fixed ids by the tracking package
			tracking.TrackWelcomeDone(strings.TrimSpace(id))
		}
	}
	if setreg.Raw(values, "inbox_welcome") == "off" { // as written in this write: an unrecognized word is not "off" (Enum would give the default)
		tracking.TrackWelcomeDone(tracking.WelcomeAllClosed)
	}
}

// funnelAgentStep records the first agent's first output and what it was first seen doing, from the list's own reading of the agent (both terminal backends):
// its log's age, its events, the startup screen and sign-in checks. created is the session's start (RFC3339); hasLog says its terminal log exists; latestEvent
// is its newest event type ("" for none). Nothing of the screen or the log is sent: only the closed state and the seconds since launch.
func funnelAgentStep(agentType, created string, hasLog bool, staleness float64, latestEvent string, in SessionStateInput, st SessionState) {
	if agentType == at.Terminal || in.Sleeping || in.Archived || tracking.FunnelReached(tracking.EventFunnelAgentReady+"|"+tracking.AgentReady) {
		return
	}
	start, err := time.Parse(time.RFC3339, created)
	if err != nil {
		return
	}
	age := time.Since(start)
	if hasLog && staleness >= 0 && float64(age/time.Second) > staleness {
		tracking.TrackAgentFirstOutput(agentType, age)
	}
	if state := funnelAgentState(hasLog, latestEvent, age, in, st); state != "" {
		tracking.TrackAgentReady(agentType, state, age)
	}
}

// funnelAgentSettle is how long a new agent that has written something, and shows no question and no sign-in, is given before it counts as ready without an event.
const funnelAgentSettle = 15 * time.Second

func funnelAgentState(hasLog bool, latestEvent string, age time.Duration, in SessionStateInput, st SessionState) string {
	switch {
	case st.Gone && latestEvent == "":
		return tracking.AgentExitedEarly
	case st.NeedsLogin || in.NeedsLogin:
		return tracking.AgentWaitingSignin
	case in.StartupPrompt == ptymanager.StartupTrust:
		return tracking.AgentWaitingTrust
	case in.StartupPrompt != "":
		return tracking.AgentWaitingOtherInput
	case st.NotStarted:
		return tracking.AgentNotStarted
	case latestEvent != "":
		return tracking.AgentReady
	case hasLog && age >= funnelAgentSettle:
		return tracking.AgentReady
	}
	return ""
}
