package tracking

import (
	"context"
	"testing"
	"time"
)

// fastStall shortens the watch so a test runs in milliseconds, and puts the globals back.
func fastStall(t *testing.T) {
	t.Helper()
	d, p, l, g := stallDelay, stallPoll, stallLookFor, stallGrace
	stallDelay, stallPoll, stallLookFor, stallGrace = 150*time.Millisecond, 10*time.Millisecond, 100*time.Millisecond, 30*time.Second
	dashboardServed.Store(false)
	t.Cleanup(func() {
		stallDelay, stallPoll, stallLookFor, stallGrace = d, p, l, g
		dashboardServed.Store(false)
	})
}

func stalledReasons(c *rawCapture) []string {
	var out []string
	for _, e := range c.named(EventFunnelDashboardStalled) {
		r, _ := e.Properties["reason"].(string)
		out = append(out, r)
	}
	return out
}

func TestStalledNamesTheReasonFromWhatTheFirstStartDidAndWhatWasRequested(t *testing.T) {
	cases := []struct {
		name   string
		open   string
		served bool
		want   string
	}{
		{"link printed", OpenPrintedNoDisplay, false, StallNotOpened},
		{"no browser flag", OpenSkippedNoBrowser, false, StallNotOpened},
		{"background start", OpenBackgroundStart, false, StallNotOpened},
		{"browser asked, no request", OpenBrowser, false, StallOpenedNotServed},
		{"window fell back to browser, no request", OpenNativeFallback, false, StallOpenedNotServed},
		{"window started, no request", OpenNativeWindow, false, StallWindowNoPage},
		{"page requested, never ready", OpenBrowser, true, StallServedNotReady},
		{"window, page requested, never ready", OpenNativeWindow, true, StallServedNotReady},
		{"printed link, opened by hand, never ready", OpenPrintedNoDisplay, true, StallServedNotReady},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newFunnelTracking(t)
			fastStall(t)
			consentKnown.Store(true)
			HoldFunnelStep(EventFunnelDashboardOpen, tc.open)
			if tc.served {
				NoteDashboardPageServed()
			}
			runStallWatch(context.Background(), time.Now())
			waitForAsync()
			got := stalledReasons(c)
			if len(got) != 1 || got[0] != tc.want {
				t.Fatalf("reasons sent = %v, want exactly [%s]", got, tc.want)
			}
			if e := c.named(EventFunnelDashboardStalled)[0]; e.Properties["backend"] != "pty" || e.Properties["reason"] == nil {
				t.Fatalf("missing the common funnel properties: %v", e.Properties)
			}
		})
	}
}

func TestStalledSendsNothingWhenTheDashboardLoadsOrFailsInTime(t *testing.T) {
	for _, step := range []string{EventFunnelDashboardLoaded, EventFunnelDashboardLoadFailed} {
		c, _ := newFunnelTracking(t)
		fastStall(t)
		consentKnown.Store(true)
		HoldFunnelStep(EventFunnelDashboardOpen, OpenBrowser)
		go func() {
			time.Sleep(40 * time.Millisecond)
			if step == EventFunnelDashboardLoaded {
				TrackFunnelStep(step, nil)
			} else {
				TrackFunnelStep(step, map[string]string{"code": "init_failed"})
			}
		}()
		runStallWatch(context.Background(), time.Now())
		waitForAsync()
		if got := stalledReasons(c); len(got) != 0 {
			t.Fatalf("after %s the stall event was sent: %v", step, got)
		}
	}
}

func TestStalledIsSentOnceEverAndAnEarlierProcessesOpenStepIsIgnored(t *testing.T) {
	c, _ := newFunnelTracking(t)
	fastStall(t)
	consentKnown.Store(true)
	HoldFunnelStep(EventFunnelDashboardOpen, OpenBrowser)
	runStallWatch(context.Background(), time.Now())
	waitForAsync()
	// A later start: no open step is recorded again, and nothing is sent again.
	runStallWatch(context.Background(), time.Now())
	waitForAsync()
	if got := stalledReasons(c); len(got) != 1 {
		t.Fatalf("sent %d times, want once ever: %v", len(got), got)
	}
	// An open step left by a process that ended before the delay: this process is not that first start, so nothing is sent and the step is cleared.
	c2, _ := newFunnelTracking(t)
	fastStall(t)
	consentKnown.Store(true)
	HoldFunnelStep(EventFunnelDashboardOpen, OpenBrowser)
	runStallWatch(context.Background(), time.Now().Add(10*time.Minute)) // a process that started ten minutes after the step
	waitForAsync()
	if got := stalledReasons(c2); len(got) != 0 {
		t.Fatalf("an earlier process's open step sent %v", got)
	}
	if _, ok := dashOpenStep(); ok {
		t.Fatal("the stale open step was not cleared")
	}
}

func TestStalledSendsNothingBeforeTheTermsOrWithAnalyticsOff(t *testing.T) {
	c, _ := newFunnelTracking(t)
	fastStall(t)
	HoldFunnelStep(EventFunnelDashboardOpen, OpenBrowser) // consent not known: the step is held, not sent
	runStallWatch(context.Background(), time.Now())
	waitForAsync()
	if got := stalledReasons(c); len(got) != 0 {
		t.Fatalf("sent before the Terms were accepted: %v", got)
	}
	// Analytics off: no watch starts at all, and the held step and the open record are both deleted.
	c3, _ := newFunnelTracking(t)
	fastStall(t)
	HoldFunnelStep(EventFunnelDashboardOpen, OpenBrowser)
	SetTelemetryEnabled(false)
	t.Cleanup(func() { SetTelemetryEnabled(true) })
	WatchDashboardStall(context.Background())
	DropHeldFunnel()
	time.Sleep(stallDelay + 100*time.Millisecond)
	waitForAsync()
	if got := stalledReasons(c3); len(got) != 0 {
		t.Fatalf("sent with analytics off: %v", got)
	}
	if _, ok := dashOpenStep(); ok {
		t.Fatal("the open record survived analytics being switched off")
	}
}

func TestStalledReasonIsAClosedList(t *testing.T) {
	for _, bad := range []string{"", "other", "C:\\Users\\x", "not_opened ", "SERVED_NOT_READY"} {
		if funnelPropsValid(EventFunnelDashboardStalled, map[string]string{"reason": bad}) {
			t.Fatalf("reason %q was accepted", bad)
		}
	}
	if funnelPropsValid(EventFunnelDashboardStalled, map[string]string{"reason": StallNotOpened, "path": "/x"}) {
		t.Fatal("an extra property was accepted")
	}
	for _, ok := range []string{StallNotOpened, StallOpenedNotServed, StallWindowNoPage, StallServedNotReady} {
		if !funnelPropsValid(EventFunnelDashboardStalled, map[string]string{"reason": ok}) {
			t.Fatalf("reason %q refused", ok)
		}
	}
}

// The watch ends with the server: a cancelled ctx stops it in the wait for the open step and in the wait for the delay, and nothing is sent.
func TestStalledWatchEndsWithItsCtxAndSendsNothing(t *testing.T) {
	for _, tc := range []struct {
		name string
		open bool
	}{{"waiting for the open step", false}, {"waiting out the delay", true}} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newFunnelTracking(t)
			fastStall(t)
			consentKnown.Store(true)
			stallDelay, stallLookFor = time.Hour, time.Hour // only the ctx can end the watch in time
			if tc.open {
				HoldFunnelStep(EventFunnelDashboardOpen, OpenBrowser)
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() { defer close(done); runStallWatch(ctx, time.Now()) }()
			time.Sleep(50 * time.Millisecond) // let it reach its sleep
			cancel()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("the watch kept running after its ctx was cancelled")
			}
			waitForAsync()
			if got := stalledReasons(c); len(got) != 0 {
				t.Fatalf("a cancelled watch sent %v", got)
			}
		})
	}
}
