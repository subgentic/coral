package tracking

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/config"
)

// rawCapture keeps every request the sink received whole (URL, headers and body) and the decoded events.
type rawCapture struct {
	mu     sync.Mutex
	status int // what the sink answers (0: 200, and the event is kept)
	raw    []string
	events []capturedEvent
}

func (c *rawCapture) all() []capturedEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]capturedEvent(nil), c.events...)
}

func (c *rawCapture) named(name string) []capturedEvent {
	var out []capturedEvent
	for _, e := range c.all() {
		if e.Event == name {
			out = append(out, e)
		}
	}
	return out
}

func (c *rawCapture) rawText() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(c.raw, "\n")
}

// newFunnelTracking isolates tracking in a temp folder with a known install, its first open an hour ago, and a sink that keeps whole requests.
func newFunnelTracking(t *testing.T) (*rawCapture, string) {
	t.Helper()
	dir := t.TempDir()
	c := &rawCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var hdr []string
		for k, v := range r.Header {
			hdr = append(hdr, k+": "+strings.Join(v, ","))
		}
		var e capturedEvent
		_ = json.Unmarshal(body, &e)
		c.mu.Lock()
		status := c.status
		if status == 0 {
			c.raw = append(c.raw, r.URL.String()+"\n"+strings.Join(hdr, "\n")+"\n"+string(body))
			c.events = append(c.events, e)
		}
		c.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
		}
	}))
	t.Cleanup(srv.Close)
	prevURL, prevKey, prevDir, prevID, prevDelays := posthogURL, config.PostHogKey, coralDir, cachedInstallID, retryDelays
	retryDelays = nil
	posthogURL, config.PostHogKey, coralDir, cachedInstallID = srv.URL, "phc_test_key", dir, "funnel-install"
	installIDOnce.Do(func() {})
	consentKnown.Store(false)
	for _, m := range []*sync.Map{&firedHere, &reachedHere} {
		m.Range(func(k, _ any) bool { m.Delete(k); return true })
	}
	SetTelemetryEnabled(true)
	SetBackend("pty")
	t.Cleanup(func() {
		waitForAsync()
		posthogURL, config.PostHogKey, coralDir, cachedInstallID, retryDelays = prevURL, prevKey, prevDir, prevID, prevDelays
		consentKnown.Store(false)
		funnelBackend.Store("")
	})
	_ = os.WriteFile(filepath.Join(dir, ".install_id"), []byte("funnel-install"), 0o600)
	first := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	data, _ := json.Marshal(milestoneState{FirstOpenAt: first})
	_ = os.WriteFile(filepath.Join(dir, milestonesFileName), data, 0o600)
	return c, dir
}

func keysOf(m map[string]any) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// standardKeys are the properties every event carries.
var standardKeys = map[string]bool{"version": true, "edition": true, "os": true, "arch": true, "platform": true, "schema_version": true, "run_id": true, "entrypoint": true}

// ownKeys are an event's properties beyond the standard ones.
func ownKeys(e capturedEvent) []string {
	var out []string
	for k := range e.Properties {
		if !standardKeys[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// Each step goes once however often it happens, with the common properties: the backend and the whole seconds since the install's first open.
func TestEachFunnelStepIsSentOnceWithTheCommonProperties(t *testing.T) {
	c, _ := newFunnelTracking(t)
	for i := 0; i < 2; i++ {
		TrackFunnelStep(EventFunnelLaunchDialogOpened, nil)
		TrackSigninPageShown(SigninPageCreate)
		TrackCLIDetected("claude", CLIFound)
		TrackCLIDetected("codex", CLINotFound)
		TrackAgentReady("agy", AgentWaitingTrust, 3*time.Second)
		TrackAgentReady("agy", AgentReady, 9*time.Second)
		waitForAsync()
	}
	if n := len(c.named(EventFunnelLaunchDialogOpened)); n != 1 {
		t.Fatalf("launch dialog step sent %d times, want 1", n)
	}
	if n := len(c.named(EventFunnelCLIDetected)); n != 2 {
		t.Fatalf("CLI step sent %d times, want once per tool (2)", n)
	}
	if n := len(c.named(EventFunnelAgentReady)); n != 2 {
		t.Fatalf("agent ready sent %d times, want once per state (2)", n)
	}
	e := c.named(EventFunnelLaunchDialogOpened)[0]
	if e.Properties["backend"] != "pty" {
		t.Errorf("backend = %v", e.Properties["backend"])
	}
	secs, _ := e.Properties["secs_since_install"].(float64)
	if secs < 3500 || secs > 3700 {
		t.Errorf("secs_since_install = %v, want about an hour", e.Properties["secs_since_install"])
	}
	for _, r := range c.named(EventFunnelAgentReady) {
		if r.Properties["provider"] != "gemini" {
			t.Errorf("agy is the Gemini family: provider = %v", r.Properties["provider"])
		}
	}
}

// C1: what the page reports is taken by name only. Its properties are dropped, and a failure code that is not the dashboard's own becomes "other".
func TestFunnelPageStepsTakeNothingFromThePage(t *testing.T) {
	c, _ := newFunnelTracking(t)
	hostile := `C:\Users\someone\secret-board`
	TrackBrowserEvent(EventFunnelLaunchDialogOpened, map[string]string{"backend": "tmux", "page": hostile, "provider": "claude"})
	TrackBrowserEvent(EventDashboardFailed, map[string]string{"code": hostile})
	waitForAsync()
	opened := c.named(EventFunnelLaunchDialogOpened)
	if len(opened) != 1 {
		t.Fatalf("launch dialog step: %d events", len(opened))
	}
	if got := ownKeys(opened[0]); strings.Join(got, ",") != "backend,secs_since_install" {
		t.Errorf("the page's properties were taken: %v", got)
	}
	if opened[0].Properties["backend"] != "pty" {
		t.Errorf("the backend is the server's, not the page's: %v", opened[0].Properties["backend"])
	}
	failed := c.named(EventFunnelDashboardLoadFailed)
	if len(failed) != 1 || failed[0].Properties["code"] != FunnelOther {
		t.Fatalf("an unknown page code must be sent as other: %+v", failed)
	}
	if n := len(c.named(EventDashboardFailed)); n != 0 {
		t.Errorf("dashboard_failed with an unknown code was sent (%d)", n)
	}
	if strings.Contains(c.rawText(), "secret-board") {
		t.Error("the page's text reached the sink")
	}
}

// C2: every value comes from a closed list in Go. A hostile string (a path, a user name, a board name) gives "other" or no event, and is never written to disk.
func TestHostileValuesGiveOtherOrNoFunnelEvent(t *testing.T) {
	c, dir := newFunnelTracking(t)
	hostile := []string{`C:\Users\someone`, "/home/someone/.coral", "secret-board", "someone", "claude/../x"}
	for _, h := range hostile {
		TrackCLIDetected(h, CLIFound)
		TrackCLIDetected("claude", h)
		TrackWelcomeDone(h)
		TrackAgentReady("claude", h, time.Second)
		TrackSigninPageShown(h)
		TrackSigninLinkRefused(h)
		TrackFunnelStep(EventFunnelLaunchFailed, map[string]string{"kind": KindAgent, "provider": "claude", "failure_category": h})
		HoldFunnelStep(EventFunnelAppStarted, h)
		HoldFunnelStep(EventFunnelStartupFailed, h)
		if got := FunnelProvider(h); got != "other" {
			t.Errorf("FunnelProvider(%q) = %q, want other", h, got)
		}
		if got := StartupFailureClass(errors.New(h + ": address already in use")); got != StartupOther {
			t.Errorf("StartupFailureClass by message text: %q", got)
		}
	}
	waitForAsync()
	if n := len(c.all()); n != 0 {
		t.Fatalf("hostile values sent %d events: %+v", n, c.all())
	}
	data, _ := os.ReadFile(filepath.Join(dir, milestonesFileName))
	for _, h := range hostile {
		if strings.Contains(string(data), h) {
			t.Errorf("%q was written to the milestone file", h)
		}
	}
	if got := StartupFailureClass(&os.PathError{Op: "open", Path: `C:\x`, Err: os.ErrPermission}); got != StartupPermissionDenied {
		t.Errorf("a permission error by type: %q", got)
	}
}

// C3: a held step is stored as its value and time only; it is not sent before acceptance; analytics off at that moment deletes it for good; accepted with
// analytics on sends it once, at the time it happened.
func TestHeldStepsWaitForConsentAndAreDeletedWithAnalyticsOff(t *testing.T) {
	c, dir := newFunnelTracking(t)
	HoldFunnelStep(EventFunnelAppStarted, AppStartCLI)
	HoldFunnelStep(EventFunnelEULAShown, EULASurfaceConsole)
	HoldFunnelStep(EventFunnelEULADeclined, EULASurfaceConsole)
	waitForAsync()

	var s milestoneState
	data, _ := os.ReadFile(filepath.Join(dir, milestonesFileName))
	if err := json.Unmarshal(data, &s); err != nil || len(s.Held) != 3 {
		t.Fatalf("held: %v %+v", err, s.Held)
	}
	var raw map[string]map[string]map[string]any
	_ = json.Unmarshal(data, &raw)
	for step, h := range raw["held"] {
		if got := keysOf(h); strings.Join(got, ",") != "at,value" {
			t.Errorf("held %s stores %v, want only at and value", step, got)
		}
	}

	FlushHeldFunnel(false) // the Terms are not accepted
	waitForAsync()
	if n := len(c.all()); n != 0 {
		t.Fatalf("sent before acceptance: %d", n)
	}

	SetTelemetryEnabled(false)
	FlushHeldFunnel(true) // accepted, analytics off: deleted
	waitForAsync()
	SetTelemetryEnabled(true)
	consentKnown.Store(false)
	FlushHeldFunnel(true)
	waitForAsync()
	if n := len(c.all()); n != 0 {
		t.Fatalf("held steps from an opted-out moment were sent later: %d", n)
	}
	data, _ = os.ReadFile(filepath.Join(dir, milestonesFileName))
	var after milestoneState
	_ = json.Unmarshal(data, &after)
	if len(after.Held) != 0 {
		t.Fatalf("still held after analytics was off: %+v", after.Held)
	}
}

func TestHeldStepsAreSentOnceAfterAcceptanceAtTheirOwnTime(t *testing.T) {
	c, _ := newFunnelTracking(t)
	HoldFunnelStep(EventFunnelAppStarted, AppStartTray)
	HoldFunnelStep(EventFunnelAppStarted, AppStartCLI) // only the first start is kept
	FlushHeldFunnel(true)
	waitForAsync()
	FlushHeldFunnel(true)
	waitForAsync()
	got := c.named(EventFunnelAppStarted)
	if len(got) != 1 || got[0].Properties["source"] != AppStartTray {
		t.Fatalf("want one app start from the tray, got %+v", got)
	}
	// A step held after consent is known goes at once.
	HoldFunnelStep(EventFunnelDashboardOpen, OpenNativeWindow)
	waitForAsync()
	if n := len(c.named(EventFunnelDashboardOpen)); n != 1 {
		t.Fatalf("a step held after consent was not sent: %d", n)
	}
}

// C3: a decline never followed by acceptance is never sent.
func TestADeclineWithoutAcceptanceIsNeverSent(t *testing.T) {
	c, _ := newFunnelTracking(t)
	show := ObserveEULADialog(EULASurfaceDialog, func(string) bool { return false })
	if show("terms") {
		t.Fatal("the dialog said no")
	}
	FlushHeldFunnel(false)
	waitForAsync()
	if n := len(c.all()); n != 0 {
		t.Fatalf("sent with the Terms declined: %d", n)
	}
}

// C4 and S4: the sign-in page step and the agent steps carry only their closed values, the seconds and the common properties.
func TestSigninAndAgentStepsCarryNoRequestOrScreenData(t *testing.T) {
	c, _ := newFunnelTracking(t)
	TrackSigninPageShown(SigninPageSignin)
	TrackSigninLinkRefused(LinkUsedOrExpired)
	TrackAgentFirstOutput("codex", 4*time.Second)
	TrackAgentReady("codex", AgentWaitingSignin, 6*time.Second)
	waitForAsync()
	want := map[string]string{
		EventFunnelSigninPageShown:   "backend,page,secs_since_install",
		EventFunnelSigninLinkRefused: "backend,class,secs_since_install",
		EventFunnelAgentFirstOutput:  "backend,provider,secs_since_install,secs_since_launch",
		EventFunnelAgentReady:        "backend,provider,secs_since_install,secs_since_launch,state",
	}
	for ev, keys := range want {
		got := c.named(ev)
		if len(got) != 1 {
			t.Errorf("%s: %d events", ev, len(got))
			continue
		}
		if k := strings.Join(ownKeys(got[0]), ","); k != keys {
			t.Errorf("%s carries %s, want %s", ev, k, keys)
		}
	}
}

// S1: nothing of this computer or its people reaches the sink anywhere in a request (URL, headers or body): no folder, user, host, board or address.
func TestNoFunnelRequestCarriesNamesPathsOrAddresses(t *testing.T) {
	c, dir := newFunnelTracking(t)
	host, _ := os.Hostname()
	home, _ := os.UserHomeDir()
	seeded := []string{"secret-board", "secret-project", "secret-agent", dir, home, os.TempDir()}
	if host != "" {
		seeded = append(seeded, host)
	}
	if u := os.Getenv("USERNAME"); u != "" {
		seeded = append(seeded, u)
	}
	if u := os.Getenv("USER"); u != "" {
		seeded = append(seeded, u)
	}
	HoldFunnelStep(EventFunnelAppStarted, AppStartCLI)
	HoldFunnelStep(EventFunnelEULAShown, EULASurfaceConsole)
	HoldFunnelStep(EventFunnelStartupFailed, StartupFailureClass(&os.PathError{Op: "open", Path: filepath.Join(dir, "secret-project"), Err: os.ErrPermission}))
	FlushHeldFunnel(true)
	TrackBrowserEvent(EventFunnelLaunchDialogOpened, map[string]string{"board": "secret-board", "path": dir})
	TrackBrowserEvent(EventDashboardFailed, map[string]string{"code": "secret-agent " + dir})
	TrackSigninPageShown(SigninPageSetup)
	TrackCLIDetected("pi", CLIUnrunnable)
	TrackWelcomeDone("agent")
	TrackFunnelStep(EventFunnelLaunchClicked, map[string]string{"kind": KindTeam, "provider": "mixed"})
	TrackFunnelStep(EventFunnelLaunchFailed, map[string]string{"kind": KindAgent, "provider": "claude", "failure_category": FailSpawnFailed})
	TrackAgentFirstOutput("secret-agent", time.Second)
	TrackAgentReady("claude", AgentReady, 20*time.Second)
	waitForAsync()
	if len(c.all()) < 10 {
		t.Fatalf("expected the steps to be sent, got %d", len(c.all()))
	}
	raw := c.rawText()
	for _, s := range seeded {
		if len(s) >= 3 && strings.Contains(strings.ToLower(raw), strings.ToLower(s)) {
			t.Errorf("%q reached the sink", s)
		}
		if strings.Contains(raw, strings.ReplaceAll(s, `\`, `\\`)) && len(s) >= 3 {
			t.Errorf("%q (JSON-escaped) reached the sink", s)
		}
	}
	ipv4 := regexp.MustCompile(`\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`)
	ipv6 := regexp.MustCompile(`(?i)\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}\b`)
	for _, e := range c.all() {
		for k, v := range e.Properties {
			sv, _ := v.(string)
			if strings.ContainsAny(sv, `/\`) {
				t.Errorf("%s.%s has a path separator: %q", e.Event, k, sv)
			}
			if k != "version" && (ipv4.MatchString(sv) || ipv6.MatchString(sv)) {
				t.Errorf("%s.%s looks like an address: %q", e.Event, k, sv)
			}
		}
	}
}

// S5: every event that can be sent is in the disclosure, and every funnel property is named in its row.
func TestEveryFunnelEventAndPropertyIsDisclosed(t *testing.T) {
	docs := map[string]EventDoc{}
	for _, d := range AllEvents {
		docs[d.Name] = d
	}
	for name := range eventSpecs {
		if _, ok := docs[name]; !ok {
			t.Errorf("event %q can be sent but is not in AllEvents", name)
		}
	}
	for name, spec := range funnelSpecs {
		d := docs[name]
		for prop := range spec {
			if !strings.Contains(d.Extra, prop) && !strings.Contains(d.When, prop) {
				t.Errorf("%s: property %q is not named in its disclosure row", name, prop)
			}
		}
		for prop := range funnelCommonSpec {
			if !strings.Contains(d.Extra, prop) {
				t.Errorf("%s: common property %q is not named in its disclosure row", name, prop)
			}
		}
	}
}

// Nothing is sent, held steps included, with analytics off.
func TestNoFunnelStepWithAnalyticsOff(t *testing.T) {
	c, _ := newFunnelTracking(t)
	SetTelemetryEnabled(false)
	t.Cleanup(func() { SetTelemetryEnabled(true) })
	HoldFunnelStep(EventFunnelAppStarted, AppStartCLI)
	FlushHeldFunnel(true)
	TrackFunnelStep(EventFunnelLaunchDialogOpened, nil)
	TrackCLIDetected("claude", CLIFound)
	waitForAsync()
	if n := len(c.all()); n != 0 {
		t.Fatalf("analytics off, yet %d events", n)
	}
}

// A held step whose send fails (no network on a first start) is held again, and the next flush sends it once, at the time it happened.
func TestAHeldStepWhoseSendFailsIsHeldAgain(t *testing.T) {
	c, dir := newFunnelTracking(t)
	HoldFunnelStep(EventFunnelAppStarted, AppStartCLI)
	var held milestoneState
	data, _ := os.ReadFile(filepath.Join(dir, milestonesFileName))
	_ = json.Unmarshal(data, &held)
	at := held.Held[EventFunnelAppStarted].At

	c.mu.Lock()
	c.status = http.StatusServiceUnavailable
	c.mu.Unlock()
	FlushHeldFunnel(true)
	waitForAsync()
	var after milestoneState
	data, _ = os.ReadFile(filepath.Join(dir, milestonesFileName))
	_ = json.Unmarshal(data, &after)
	if h, ok := after.Held[EventFunnelAppStarted]; !ok || h.At != at || h.Value != AppStartCLI {
		t.Fatalf("a step whose send failed must be held again as it was: %+v", after.Held)
	}

	c.mu.Lock()
	c.status = 0
	c.mu.Unlock()
	FlushHeldFunnel(true)
	waitForAsync()
	got := c.named(EventFunnelAppStarted)
	if len(got) != 1 || got[0].Properties["source"] != AppStartCLI {
		t.Fatalf("want the step once after the network came back, got %+v", got)
	}
	FlushHeldFunnel(true)
	waitForAsync()
	if n := len(c.named(EventFunnelAppStarted)); n != 1 {
		t.Fatalf("sent %d times", n)
	}
}
