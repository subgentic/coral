package main

import (
	"io"
	"testing"

	"github.com/subgentic/coral/internal/tracking"
)

// Security's INFO 2 on #306: the first start's dashboard-open step says "opened" only when a browser was asked to open the sign-in link. When no opener
// started (WSLg with no xdg-open) and the link was printed instead, it says "printed_no_display", an existing value, so the census lists do not change.
func TestDashboardOpenStepSaysPrintedWhenNoBrowserOpened(t *testing.T) {
	t.Setenv("DISPLAY", ":0")
	t.Setenv("TMUX", "")
	oldOpen, oldHold := openLogin, holdFunnelStep
	t.Cleanup(func() { openLogin, holdFunnelStep = oldOpen, oldHold })
	for _, tc := range []struct {
		started bool
		want    string
	}{{false, tracking.OpenPrintedNoDisplay}, {true, tracking.OpenBrowser}} {
		var held []string
		holdFunnelStep = func(event, value string) {
			if event != tracking.EventFunnelDashboardOpen {
				t.Errorf("held %q, want %q", event, tracking.EventFunnelDashboardOpen)
			}
			held = append(held, value)
		}
		openLogin = func(string) bool { return tc.started }
		openDashboardAtStart(io.Discard, "http://localhost:8420/?login_token=x")
		if len(held) != 1 || held[0] != tc.want {
			t.Errorf("opener started=%v: held %v, want [%s]", tc.started, held, tc.want)
		}
	}
}
