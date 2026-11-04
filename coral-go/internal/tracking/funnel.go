package tracking

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

// The step-by-step new-user funnel (#7455): one event per step from the first start to a first finished task, each sent at most once per install, so a drop-off can be
// placed on one step. Every value is chosen here from a closed list or is a bounded number: never a path, a name, an address, a prompt, screen text or an error message.
const (
	EventFunnelAppStarted          = "funnel_app_started"           // the first start of a Coral program on this install
	EventFunnelStartupFailed       = "funnel_startup_failed"        // the first start that failed, with its class
	EventFunnelEULAShown           = "funnel_eula_shown"            // the Terms were shown
	EventFunnelEULADeclined        = "funnel_eula_declined"         // the Terms were declined (sent only if they are accepted later)
	EventFunnelDashboardOpen       = "funnel_dashboard_open"        // what the first start did about opening the dashboard
	EventFunnelSigninPageShown     = "funnel_signin_page_shown"     // the sign-in page was served to a browser with no session
	EventFunnelSigninLinkRefused   = "funnel_signin_link_refused"   // a sign-in link was refused
	EventFunnelDashboardLoaded     = "funnel_dashboard_loaded"      // the first dashboard page finished loading
	EventFunnelDashboardLoadFailed = "funnel_dashboard_load_failed" // the first dashboard page that could not load
	EventFunnelWelcomeShown        = "funnel_welcome_shown"         // the new-install welcome items were on when the dashboard loaded
	EventFunnelWelcomeDone         = "funnel_welcome_done"          // one welcome item done, read or dismissed (once per item), or all of them hidden
	EventFunnelCLIDetected         = "funnel_cli_detected"          // which agent CLIs this computer has (once per CLI)
	EventFunnelLaunchDialogOpened  = "funnel_launch_dialog_opened"  // the launch dialog was opened
	EventFunnelLaunchClicked       = "funnel_launch_clicked"        // the first launch was asked for
	EventFunnelLaunchFailed        = "funnel_launch_failed"         // the first launch that failed, with its category
	EventFunnelAgentFirstOutput    = "funnel_agent_first_output"    // an agent's terminal first wrote something
	EventFunnelAgentReady          = "funnel_agent_ready"           // what a new agent was first seen doing (once per state)
)

// The funnel's closed vocabularies.
const (
	AppStartCLI        = "cli"              // the coral command
	AppStartTray       = "tray"             // the Coral app (the tray)
	AppStartLauncher   = "launcher"         // launch-coral
	AppStartInstaller  = "installer_launch" // the installer's "Launch Coral"
	EULASurfaceDialog  = "app_dialog"       // the Coral app's own dialog
	EULASurfaceConsole = "terminal"         // the terminal prompt

	StartupPortInUse        = "port_in_use"
	StartupPermissionDenied = "permission_denied"
	StartupOther            = "other"

	OpenBrowser            = "opened"                         // the browser was asked to open the sign-in link
	OpenNativeWindow       = "native_window"                  // the Coral window opened
	OpenNativeFallback     = "native_window_fallback_browser" // the Coral window could not open; the browser was asked instead
	OpenPrintedNoDisplay   = "printed_no_display"             // the link was printed in the terminal: no display, or no browser opener started (WSLg with no xdg-open)
	OpenSkippedNoBrowser   = "skipped_no_browser_flag"        // --no-browser: nothing was opened
	OpenBackgroundStart    = "background_start"               // a start nobody asked for (a login item, an update's relaunch): no window
	OpenServerNotRunning   = "server_not_running"             // the server had not started, so no window
	SigninPageSetup        = "setup"                          // create a password, with a setup code
	SigninPageCreate       = "create"                         // create a password
	SigninPageSignin       = "signin"                         // sign in with the password
	LinkUsedOrExpired      = "used_or_expired"
	LinkOtherUser          = "other_user"
	CLIFound               = "found"
	CLINotFound            = "not_found"
	CLIUnrunnable          = "unrunnable" // found, but it cannot be run from where it is
	AgentReady             = "ready"
	AgentWaitingTrust      = "waiting_trust"
	AgentWaitingSignin     = "waiting_signin"
	AgentWaitingOtherInput = "waiting_other_prompt"
	AgentNotStarted        = "not_started" // silent since it was launched
	AgentExitedEarly       = "exited_early"
	WelcomeAllClosed       = "all_closed" // every item done or hidden: the items went away
	FunnelOther            = "other"
)

// installSeconds bounds secs_since_install: thirty days.
const installSeconds = 30 * 24 * 3600

// launchSeconds bounds secs_since_launch: an hour.
const launchSeconds = 3600

var (
	funnelProviderEnu  = enum("claude", "codex", "gemini", "pi", "other")
	funnelCommonSpec   = map[string]propSpec{"backend": backendEnu, "secs_since_install": intRange(0, installSeconds)}
	dashboardFailCodes = []string{"sessions_fetch_http", "sessions_fetch_network", "sessions_fetch_invalid", "status_fetch_http", "status_fetch_network", "status_fetch_invalid", "init_failed"}
	welcomeSteps       = []string{"welcome", "agent", "team", "connect", "asks"}
)

// funnelSpecs are the funnel's own properties, per event. Every funnel event also carries funnelCommonSpec.
var funnelSpecs = map[string]map[string]propSpec{
	EventFunnelAppStarted:          {"source": enum(AppStartCLI, AppStartTray, AppStartLauncher, AppStartInstaller)},
	EventFunnelStartupFailed:       {"class": enum(StartupPortInUse, StartupPermissionDenied, StartupOther)},
	EventFunnelEULAShown:           {"surface": enum(EULASurfaceDialog, EULASurfaceConsole)},
	EventFunnelEULADeclined:        {"surface": enum(EULASurfaceDialog, EULASurfaceConsole)},
	EventFunnelDashboardOpen:       {"result": enum(OpenBrowser, OpenNativeWindow, OpenNativeFallback, OpenPrintedNoDisplay, OpenSkippedNoBrowser, OpenBackgroundStart, OpenServerNotRunning)},
	EventFunnelSigninPageShown:     {"page": enum(SigninPageSetup, SigninPageCreate, SigninPageSignin)},
	EventFunnelSigninLinkRefused:   {"class": enum(LinkUsedOrExpired, LinkOtherUser)},
	EventFunnelDashboardLoaded:     {},
	EventFunnelDashboardLoadFailed: {"code": enum(append(append([]string{}, dashboardFailCodes...), FunnelOther)...)},
	EventFunnelWelcomeShown:        {},
	EventFunnelWelcomeDone:         {"step": enum(append(append([]string{}, welcomeSteps...), WelcomeAllClosed)...)},
	EventFunnelCLIDetected:         {"tool": enum("claude", "codex", "gemini", "pi"), "status": enum(CLIFound, CLINotFound, CLIUnrunnable)},
	EventFunnelLaunchDialogOpened:  {},
	EventFunnelLaunchClicked:       {"kind": kindEnu, "provider": providerEnu},
	EventFunnelLaunchFailed:        {"kind": kindEnu, "provider": providerEnu, "failure_category": failureEnu},
	EventFunnelAgentFirstOutput:    {"provider": funnelProviderEnu, "secs_since_launch": intRange(0, launchSeconds)},
	EventFunnelAgentReady:          {"provider": funnelProviderEnu, "state": enum(AgentReady, AgentWaitingTrust, AgentWaitingSignin, AgentWaitingOtherInput, AgentNotStarted, AgentExitedEarly), "secs_since_launch": intRange(0, launchSeconds)},
}

// funnelMilestones are the earlier one-time events that are steps of the same funnel: they carry the common properties too.
var funnelMilestones = []string{EventEULAAccepted, EventDashboardSignedIn, EventFirstAgentLaunched, EventFirstPromptSubmitted, EventFirstMessageSent, EventFirstAgentReply, EventFirstTaskCompleted}

func init() {
	for name, spec := range funnelSpecs {
		full := map[string]propSpec{}
		for k, v := range spec {
			full[k] = v
		}
		for k, v := range funnelCommonSpec {
			full[k] = v
		}
		eventSpecs[name] = full
	}
	for _, name := range funnelMilestones {
		for k, v := range funnelCommonSpec {
			eventSpecs[name][k] = v
		}
	}
}

// isFunnelEvent reports whether name carries the common funnel properties.
func isFunnelEvent(name string) bool {
	if _, ok := funnelSpecs[name]; ok {
		return true
	}
	for _, m := range funnelMilestones {
		if m == name {
			return true
		}
	}
	return false
}

// ── Common properties ────────────────────────────────────────────────────

var funnelBackend atomic.Value // string: pty, tmux

// SetBackend records the terminal backend this run uses, for the funnel's backend property. Anything but pty or tmux is unknown.
func SetBackend(b string) {
	if b != "pty" && b != "tmux" {
		b = "unknown"
	}
	funnelBackend.Store(b)
}

func backendName() string {
	if v, ok := funnelBackend.Load().(string); ok && v != "" {
		return v
	}
	return "unknown"
}

// firstOpenTime is the install's first recorded open, or the zero time.
func firstOpenTime() time.Time {
	if !stateDirReady() {
		return time.Time{}
	}
	milestoneMu.Lock()
	s := loadMilestones()
	milestoneMu.Unlock()
	t, err := time.Parse(time.RFC3339, s.FirstOpenAt)
	if err != nil {
		return time.Time{}
	}
	return t
}

// withFunnelCommon returns props plus the common funnel properties for event, measured at when. The caller's map is not changed.
func withFunnelCommon(event string, props map[string]string, when time.Time) map[string]string {
	if !isFunnelEvent(event) {
		return props
	}
	out := make(map[string]string, len(props)+2)
	for k, v := range props {
		out[k] = v
	}
	out["backend"] = backendName()
	if first := firstOpenTime(); !first.IsZero() {
		secs := int(when.Sub(first) / time.Second)
		if secs < 0 {
			secs = 0
		}
		if secs <= installSeconds {
			out["secs_since_install"] = strconv.Itoa(secs)
		}
	}
	return out
}

// ── Sending once ─────────────────────────────────────────────────────────

// reachedHere remembers, per data folder, the funnel keys this process has seen reached, so a check that runs on every list poll (the agent steps) costs a map lookup.
var reachedHere sync.Map

// FunnelReached reports whether the funnel step key (an event name, or event|value for the steps sent once per value) was reached on this install.
func FunnelReached(key string) bool {
	if _, ok := reachedHere.Load(firedHereKey(key)); ok {
		return true
	}
	if !stateDirReady() {
		return false
	}
	milestoneMu.Lock()
	_, reached := loadMilestones().Reached[key]
	milestoneMu.Unlock()
	if reached {
		reachedHere.Store(firedHereKey(key), true)
	}
	return reached
}

// trackFunnel sends event once per install under key, with props and the common properties. at is the time the step happened (a held step's), or zero for now.
func trackFunnel(key, event string, props map[string]string, at time.Time) {
	if _, done := firedHere.Load(firedHereKey(key)); done {
		return
	}
	gen := telemetryGen.Load()
	asyncGo(func() { sendFunnel(key, event, props, at, gen) })
}

func sendFunnel(key, event string, props map[string]string, at time.Time, gen uint64) {
	sendFunnelStep(key, event, props, at, gen)
}

// sendFunnelStep is sendFunnel, and reports whether a delivery was attempted and failed (the service did not accept it): a held step is then held again.
func sendFunnelStep(key, event string, props map[string]string, at time.Time, gen uint64) (failed bool) {
	when := at
	if when.IsZero() {
		when = time.Now().UTC()
	}
	send, snap := reserveMilestoneAt(key, posthogKeyPresent() && telemetryValid(gen), withFunnelCommon(event, props, when), when.UTC().Format(time.RFC3339Nano))
	reachedHere.Store(firedHereKey(key), true)
	if !send {
		return false
	}
	uid := uuid.NewSHA1(uuid.NameSpaceOID, []byte("coral-funnel|"+getInstallID()+"|"+key+"|"+snap.Timestamp)).String()
	if emitEvent(event, snap.Props, uid, snap.Timestamp, gen) {
		confirmMilestoneSent(key)
		return false
	}
	releaseMilestone(key)
	return true
}

// reholdStep puts a held step back after its send failed (no network on a first start), with its own value and time, so the next flush sends it, under the same
// event id. Not while analytics is off: a step is never kept for a later opt-in.
func reholdStep(event string, h heldStep, gen uint64) {
	if !stateDirReady() || !telemetryValid(gen) {
		return
	}
	milestoneMu.Lock()
	defer milestoneMu.Unlock()
	s := loadMilestones()
	if _, fired := s.Fired[event]; fired {
		return
	}
	if s.Held == nil {
		s.Held = map[string]heldStep{}
	}
	if _, ok := s.Held[event]; !ok {
		s.Held[event] = h
		if err := saveMilestones(s); err != nil {
			logDeliveryFailure(event, 0, "held step not kept after a failed send: "+err.Error())
		}
	}
}

// TrackFunnelStep sends a funnel step once per install. Use it only after the Terms were accepted and the analytics setting was applied (the server's own steps);
// a step that can come before that is held (HoldFunnelStep).
func TrackFunnelStep(event string, props map[string]string) {
	if !funnelPropsValid(event, props) {
		return
	}
	trackFunnel(event, event, props, time.Time{})
}

// funnelPropsValid reports whether event is a funnel step and every property given is one of its own, with a value on its list or in its bounds: a step with
// any other value sends nothing (it is never sent without the property, and the value never reaches the milestone file).
func funnelPropsValid(event string, props map[string]string) bool {
	spec, ok := funnelSpecs[event]
	if !ok {
		return false
	}
	typed, _ := sanitizeProps(event, props)
	for k := range props {
		if _, own := spec[k]; !own || typed[k] == nil {
			return false
		}
	}
	return true
}

// trackFunnelPer sends event once per install for each value of the property per (the CLI detected, each agent state, each welcome item).
func trackFunnelPer(event, per string, props map[string]string) {
	v := props[per]
	if v == "" || !funnelPropsValid(event, props) {
		return
	}
	trackFunnel(event+"|"+v, event, props, time.Time{})
}

// ── Held steps (before consent) ──────────────────────────────────────────

// heldSpecs are the steps that can happen before the Terms are accepted or the analytics setting is read, and the one property each carries.
var heldSpecs = map[string]string{
	EventFunnelAppStarted:    "source",
	EventFunnelStartupFailed: "class",
	EventFunnelEULAShown:     "surface",
	EventFunnelEULADeclined:  "surface",
	EventFunnelDashboardOpen: "result",
}

// heldStep is a step kept on disk until it may be sent: its closed-list value and when it happened. Nothing else is stored.
type heldStep struct {
	At    string `json:"at"`
	Value string `json:"value"`
}

// consentKnown is set once this process knows the Terms were accepted and has applied the analytics setting: a step held after that is sent at once.
var consentKnown atomic.Bool

// HoldFunnelStep records a step that may come before consent: on disk, as its value and time only, and only the first time on this install. It is sent by
// FlushHeldFunnel once the Terms are accepted and analytics is on, and deleted if analytics is off then. value must be on the step's closed list, or nothing is held.
func HoldFunnelStep(event, value string) {
	field, ok := heldSpecs[event]
	if !ok || !stateDirReady() {
		return
	}
	if typed, _ := sanitizeProps(event, map[string]string{field: value}); typed[field] == nil {
		return
	}
	milestoneMu.Lock()
	s := loadMilestones()
	_, reached := s.Reached[event]
	_, held := s.Held[event]
	if !reached && !held {
		if s.Held == nil {
			s.Held = map[string]heldStep{}
		}
		s.Held[event] = heldStep{At: nowUTC(), Value: value}
		if err := saveMilestones(s); err != nil {
			logDeliveryFailure(event, 0, "held step not persisted: "+err.Error())
		}
	}
	milestoneMu.Unlock()
	if consentKnown.Load() {
		flushHeld(telemetryGen.Load())
	}
}

// FlushHeldFunnel is called once the Terms are accepted (accepted) and the saved analytics setting is applied. With analytics on, every held step is sent once,
// with the time it happened; with analytics off, they are deleted, so a later switch-on never sends them. Not accepted: nothing is sent and they stay held.
func FlushHeldFunnel(accepted bool) {
	if !accepted {
		return
	}
	consentKnown.Store(true)
	flushHeld(telemetryGen.Load())
}

// DropHeldFunnel deletes every held step (analytics was switched off).
func DropHeldFunnel() {
	if !stateDirReady() {
		return
	}
	milestoneMu.Lock()
	defer milestoneMu.Unlock()
	s := loadMilestones()
	if len(s.Held) == 0 {
		return
	}
	s.Held = nil
	if err := saveMilestones(s); err != nil {
		logDeliveryFailure("held_steps", 0, "held steps not deleted: "+err.Error())
	}
}

func flushHeld(gen uint64) {
	if !stateDirReady() {
		return
	}
	if !(posthogKeyPresent() && telemetryValid(gen)) {
		DropHeldFunnel()
		return
	}
	milestoneMu.Lock()
	s := loadMilestones()
	held := s.Held
	if len(held) > 0 {
		s.Held = nil
		if err := saveMilestones(s); err != nil {
			logDeliveryFailure("held_steps", 0, "held steps not taken: "+err.Error())
			milestoneMu.Unlock()
			return
		}
	}
	milestoneMu.Unlock()
	for event, h := range held {
		field, ok := heldSpecs[event]
		at, err := time.Parse(time.RFC3339Nano, h.At)
		if !ok || err != nil {
			continue
		}
		props := map[string]string{field: h.Value}
		h := h
		asyncGo(func() {
			if sendFunnelStep(event, event, props, at, gen) {
				reholdStep(event, h, gen)
			}
		})
	}
}

// ObserveEULADialog wraps a Terms dialog so that showing it and declining it are held as funnel steps (surface is EULASurfaceDialog or EULASurfaceConsole).
func ObserveEULADialog(surface string, show func(text string) bool) func(text string) bool {
	return func(text string) bool {
		HoldFunnelStep(EventFunnelEULAShown, surface)
		ok := show(text)
		if !ok {
			HoldFunnelStep(EventFunnelEULADeclined, surface)
		}
		return ok
	}
}

// addrInUse are the errors a listen returns for a port another program holds (platform files add Windows' own).
var addrInUse []error

// StartupFailureClass names a failed start by its error's type, never its text.
func StartupFailureClass(err error) string {
	if err == nil {
		return StartupOther
	}
	for _, target := range addrInUse {
		if errors.Is(err, target) {
			return StartupPortInUse
		}
	}
	if errors.Is(err, os.ErrPermission) {
		return StartupPermissionDenied
	}
	return StartupOther
}

// ── Steps the server and the page report ────────────────────────────────

// TrackSigninPageShown records the first time the sign-in page was served to a browser with no session, by which page it was. Nothing of the request is sent.
func TrackSigninPageShown(page string) {
	TrackFunnelStep(EventFunnelSigninPageShown, map[string]string{"page": page})
}

// TrackSigninLinkRefused records the first refused sign-in link and why (LinkUsedOrExpired, LinkOtherUser).
func TrackSigninLinkRefused(class string) {
	TrackFunnelStep(EventFunnelSigninLinkRefused, map[string]string{"class": class})
}

// dashboardFailCode is the page's failure code if it is one of the dashboard's own, else "other": the page's word is never passed on as it came.
func dashboardFailCode(code string) string {
	for _, c := range dashboardFailCodes {
		if c == code {
			return c
		}
	}
	return FunnelOther
}

// TrackCLIDetected records, once per CLI, whether this computer has it (tool: claude, codex, gemini or pi; status: CLIFound, CLINotFound or CLIUnrunnable).
func TrackCLIDetected(tool, status string) {
	switch tool {
	case "claude", "codex", "gemini", "pi":
	default:
		return
	}
	trackFunnelPer(EventFunnelCLIDetected, "tool", map[string]string{"tool": tool, "status": status})
}

// TrackWelcomeShown records that the welcome items were on when the dashboard first loaded.
func TrackWelcomeShown() { TrackFunnelStep(EventFunnelWelcomeShown, nil) }

// TrackWelcomeDone records, once per item, a welcome item done, read or dismissed. step is checked against the items' fixed ids (or WelcomeAllClosed).
func TrackWelcomeDone(step string) {
	for _, s := range append(append([]string{}, welcomeSteps...), WelcomeAllClosed) {
		if s == step {
			trackFunnelPer(EventFunnelWelcomeDone, "step", map[string]string{"step": step})
			return
		}
	}
}

// WelcomeSteps returns the welcome items' fixed ids.
func WelcomeSteps() []string { return append([]string{}, welcomeSteps...) }

// FunnelProvider maps an agent type to the funnel's provider list: the Gemini family (gemini, agy, antigravity) is gemini, anything not on the list is other.
func FunnelProvider(agentType string) string {
	switch strings.ToLower(strings.TrimSpace(agentType)) {
	case "", "claude":
		return "claude"
	case "codex":
		return "codex"
	case "gemini", "agy", "antigravity":
		return "gemini"
	case "pi":
		return "pi"
	}
	return "other"
}

func launchSecs(sinceLaunch time.Duration) (string, bool) {
	secs := int(sinceLaunch / time.Second)
	if sinceLaunch < 0 || secs > launchSeconds {
		return "", false
	}
	return strconv.Itoa(secs), true
}

// TrackAgentFirstOutput records the first time an agent's terminal was seen to have written something, and how long after its launch.
func TrackAgentFirstOutput(agentType string, sinceLaunch time.Duration) {
	secs, ok := launchSecs(sinceLaunch)
	if !ok {
		return
	}
	TrackFunnelStep(EventFunnelAgentFirstOutput, map[string]string{"provider": FunnelProvider(agentType), "secs_since_launch": secs})
}

// TrackAgentReady records, once per state, what a new agent was first seen doing: ready for a message, or held by a question its CLI asks at launch.
func TrackAgentReady(agentType, state string, sinceLaunch time.Duration) {
	secs, ok := launchSecs(sinceLaunch)
	if !ok {
		return
	}
	trackFunnelPer(EventFunnelAgentReady, "state", map[string]string{"provider": FunnelProvider(agentType), "state": state, "secs_since_launch": secs})
}
