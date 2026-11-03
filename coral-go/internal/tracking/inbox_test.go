package tracking

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// D4 (#7520): at most 50 events per kind and action and 200 in all per install per UTC day; past a cap an action is counted but not sent.
func TestInboxActionsAreCappedPerDay(t *testing.T) {
	c, _ := newFunnelTracking(t)
	for i := 0; i < 60; i++ {
		TrackInboxActioned(InboxReview, "", "approve", "inbox", time.Time{})
	}
	waitForAsync()
	if n := len(c.named(EventInboxItemActioned)); n != inboxCapPerAction {
		t.Fatalf("one kind and action: %d sent, want %d", n, inboxCapPerAction)
	}
	actions := []string{"deny", "ignore", "save", "unsave", "changes"}
	for _, a := range actions {
		for i := 0; i < 60; i++ {
			TrackInboxActioned(InboxReview, "", a, "inbox", time.Time{})
		}
	}
	waitForAsync()
	if n := len(c.named(EventInboxItemActioned)); n != inboxCapPerDay {
		t.Fatalf("in all: %d sent, want %d", n, inboxCapPerDay)
	}
	TrackInboxOpened(map[string]int{InboxAsk: 1})
	waitForAsync()
	if n := len(c.named(EventInboxOpened)); n != 0 {
		t.Fatalf("the day's cap covers the opened events too: %d sent", n)
	}
}

// D2 and C2: the surface is the page's word through the closed list (anything else is other); a kind or action off its list sends nothing and counts
// nothing; an agent wait's kind off its list is other.
func TestInboxValuesComeFromClosedLists(t *testing.T) {
	c, dir := newFunnelTracking(t)
	hostile := []string{`C:\Users\someone`, "secret-board", "someone", "inbox ", "INBOX"}
	for _, h := range hostile {
		TrackInboxActioned(InboxAsk, "", "answer", h, time.Time{})
		TrackInboxActioned(h, "", "answer", "inbox", time.Time{})
		TrackInboxActioned(InboxAsk, "", h, "inbox", time.Time{})
		TrackInboxActioned(InboxAgentWait, h, "answer", "inbox", time.Time{})
	}
	waitForAsync()
	got := c.named(EventInboxItemActioned)
	if len(got) != 2*len(hostile) {
		t.Fatalf("want %d events (hostile surface or sub_kind only), got %d", 2*len(hostile), len(got))
	}
	for _, e := range got {
		if s := e.Properties["surface"]; s != "other" && s != "inbox" {
			t.Errorf("surface %v", s)
		}
		if sk, ok := e.Properties["sub_kind"]; ok && sk != "other" {
			t.Errorf("sub_kind %v", sk)
		}
	}
	raw := c.rawText()
	data, _ := os.ReadFile(filepath.Join(dir, inboxDayFileName))
	for _, h := range hostile[:4] {
		if strings.Contains(raw, h) || strings.Contains(raw, strings.ReplaceAll(h, `\`, `\\`)) {
			t.Errorf("%q reached the sink", h)
		}
		if strings.Contains(string(data), h) || strings.Contains(string(data), strings.ReplaceAll(h, `\`, `\\`)) {
			t.Errorf("%q was written to the counts file", h)
		}
	}
}

// The Inbox's opening goes once per UTC day, with buckets: the total and one event per kind that waits; a kind not on the list is not sent.
func TestInboxOpenedOncePerDayWithBuckets(t *testing.T) {
	c, _ := newFunnelTracking(t)
	TrackInboxOpened(map[string]int{InboxAgentWait: 2, InboxReview: 7, "secret-board": 3})
	TrackInboxOpened(map[string]int{InboxAgentWait: 1})
	waitForAsync()
	opened := c.named(EventInboxOpened)
	if len(opened) != 1 || opened[0].Properties["waiting"] != "6+" {
		t.Fatalf("opened: %+v", opened)
	}
	got := map[string]any{}
	for _, e := range c.named(EventInboxWaiting) {
		got[e.Properties["kind"].(string)] = e.Properties["waiting"]
	}
	if len(got) != 2 || got[InboxAgentWait] != "1-2" || got[InboxReview] != "6+" {
		t.Fatalf("waiting: %+v", got)
	}
	for _, n := range []struct {
		n    int
		want string
	}{{0, "0"}, {1, "1-2"}, {2, "1-2"}, {3, "3-5"}, {5, "3-5"}, {6, "6+"}, {600, "6+"}} {
		if b := InboxBucket(n.n); b != n.want {
			t.Errorf("InboxBucket(%d) = %q", n.n, b)
		}
	}
}

// The seconds to an action are whole seconds from the item's own start, bounded at seven days, and left out past that or when unknown.
func TestInboxSecondsToActionAreBounded(t *testing.T) {
	c, _ := newFunnelTracking(t)
	TrackInboxActioned(InboxProposal, "", "approve", "inbox", time.Now().Add(-90*time.Second))
	TrackInboxActioned(InboxProposal, "", "reject", "inbox", time.Now().Add(-8*24*time.Hour))
	TrackInboxActioned(InboxProposal, "", "approve", "chat", time.Time{})
	waitForAsync()
	var withSecs, without int
	for _, e := range c.named(EventInboxItemActioned) {
		if s, ok := e.Properties["secs_to_action"].(float64); ok {
			withSecs++
			if s < 89 || s > 120 {
				t.Errorf("secs_to_action %v", s)
			}
		} else {
			without++
		}
	}
	if withSecs != 1 || without != 2 {
		t.Fatalf("with %d, without %d", withSecs, without)
	}
}

// With analytics off nothing is sent and nothing is counted.
func TestNoInboxEventWithAnalyticsOff(t *testing.T) {
	c, dir := newFunnelTracking(t)
	SetTelemetryEnabled(false)
	t.Cleanup(func() { SetTelemetryEnabled(true) })
	TrackInboxOpened(map[string]int{InboxAsk: 1})
	TrackInboxActioned(InboxAsk, "", "answer", "inbox", time.Time{})
	waitForAsync()
	if n := len(c.all()); n != 0 {
		t.Fatalf("analytics off, yet %d events", n)
	}
	if _, err := os.Stat(filepath.Join(dir, inboxDayFileName)); err == nil {
		t.Fatal("analytics off, yet the counts were kept")
	}
}

// S5: the Inbox events and every property are in the disclosure.
func TestInboxEventsAreDisclosed(t *testing.T) {
	docs := map[string]EventDoc{}
	for _, d := range AllEvents {
		docs[d.Name] = d
	}
	for _, name := range []string{EventInboxOpened, EventInboxWaiting, EventInboxItemActioned} {
		d, ok := docs[name]
		if !ok {
			t.Fatalf("%s is not disclosed", name)
		}
		for prop := range eventSpecs[name] {
			if !strings.Contains(d.Extra, prop) {
				t.Errorf("%s: property %q is not named in its disclosure row", name, prop)
			}
		}
	}
}
