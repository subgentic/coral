package tracking

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/subgentic/coral/internal/safego"
)

// The dashboard-stalled signal (#19088, approved spec): the first start tried to open the dashboard and, three minutes later, no dashboard page had loaded or
// reported a failure. The page cannot say this itself (a page that never runs reports nothing), so the server, which sees both the open and the page requests,
// watches for the silence. Once per install; one fixed reason; nothing of any request.
const EventFunnelDashboardStalled = "funnel_dashboard_stalled"

// The reasons, a closed list.
const (
	StallNotOpened       = "not_opened"        // nothing was opened (the link was printed, --no-browser, a background start, or no server)
	StallOpenedNotServed = "opened_not_served" // a browser was asked to open, but no dashboard page was requested
	StallWindowNoPage    = "window_no_page"    // the Coral window was started, but no dashboard page was requested
	StallServedNotReady  = "served_not_ready"  // a dashboard or sign-in page was requested, but the page never reported ready or failed
)

var (
	stallDelay   = 180 * time.Second // after the first-start open step
	stallPoll    = 2 * time.Second
	stallLookFor = 60 * time.Second // how long a new process waits for the first start's open step
	stallGrace   = 30 * time.Second // an open step this much older than the process is an earlier process's

	dashboardServed atomic.Bool
)

// NoteDashboardPageServed records, in memory only, that the dashboard page was requested. Nothing of the request is kept.
func NoteDashboardPageServed() { dashboardServed.Store(true) }

// stallReason names why the dashboard did not load from what the first start did and whether any page was requested.
func stallReason(openResult string, served bool) string {
	if served {
		return StallServedNotReady
	}
	switch openResult {
	case OpenNativeWindow:
		return StallWindowNoPage
	case OpenBrowser, OpenNativeFallback:
		return StallOpenedNotServed
	}
	return StallNotOpened
}

// stallWG counts the running stall watches. It is separate from asyncWG because a watch lasts until its context ends, so waitForAsync (which a test calls while the server is still up) must not wait for it;
// only the restore ConfigureForTest returns does, after the test has ended the context (#19315).
var stallWG sync.WaitGroup

// WatchDashboardStall starts the watch for this server process. It sends nothing unless this process is the first start's (its open step is recent), analytics is
// on and the Terms are accepted, and nothing if the process (ctx) ends first.
func WatchDashboardStall(ctx context.Context) {
	if !stateDirReady() || !posthogKeyPresent() || !telemetryEnabled() {
		return
	}
	started := time.Now()
	stallWG.Add(1)
	go func() {
		defer safego.Recover("tracking/stall") // the first statement, as safego requires; Done below runs before it, so a panic still releases the restore
		defer stallWG.Done()
		runStallWatch(ctx, started)
	}()
}

func dashOpenStep() (heldStep, bool) {
	milestoneMu.Lock()
	defer milestoneMu.Unlock()
	s := loadMilestones()
	if s.DashOpen == nil {
		return heldStep{}, false
	}
	return *s.DashOpen, true
}

func clearDashOpen() {
	if !stateDirReady() {
		return
	}
	milestoneMu.Lock()
	defer milestoneMu.Unlock()
	s := loadMilestones()
	if s.DashOpen == nil {
		return
	}
	s.DashOpen = nil
	if err := saveMilestones(s); err != nil {
		logDeliveryFailure(EventFunnelDashboardStalled, 0, "open step not cleared: "+err.Error())
	}
}

func dashboardReported() bool {
	return FunnelReached(EventFunnelDashboardLoaded) || FunnelReached(EventFunnelDashboardLoadFailed) || FunnelReached(EventFunnelDashboardStalled)
}

// sleepOrDone waits d, and says false if ctx ended first.
func sleepOrDone(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func runStallWatch(ctx context.Context, started time.Time) {
	var open heldStep
	for deadline := started.Add(stallLookFor); ; {
		if o, ok := dashOpenStep(); ok {
			open = o
			break
		}
		if time.Now().After(deadline) || !sleepOrDone(ctx, stallPoll) {
			return
		}
	}
	at, err := time.Parse(time.RFC3339Nano, open.At)
	if err != nil || at.Before(started.Add(-stallGrace)) { // the open step of an earlier process: a process that ended before the delay sends nothing
		clearDashOpen()
		return
	}
	defer clearDashOpen()
	for time.Now().Before(at.Add(stallDelay)) {
		if dashboardReported() || !sleepOrDone(ctx, stallPoll) {
			return
		}
	}
	if dashboardReported() || !consentKnown.Load() || !posthogKeyPresent() || !telemetryEnabled() {
		return
	}
	served := dashboardServed.Load() || FunnelReached(EventFunnelSigninPageShown)
	TrackFunnelStep(EventFunnelDashboardStalled, map[string]string{"reason": stallReason(open.Value, served)})
}
