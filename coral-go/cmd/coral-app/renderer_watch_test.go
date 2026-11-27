//go:build webview

package main

import (
	"strings"
	"testing"
	"time"
)

func TestRendererWatch_NeverBeforeTheFirstReport(t *testing.T) {
	var r rendererWatch
	if ok, _ := r.due(time.Now().Add(time.Hour)); ok {
		t.Fatal("a page that never reported (the first load) must not be reopened")
	}
}

func TestRendererWatch_DueAfterSilenceWithTheLastPage(t *testing.T) {
	var r rendererWatch
	t0 := time.Unix(1_000_000, 0)
	r.alive(t0, "/agents?x=1#y")
	if ok, _ := r.due(t0.Add(rendererStale - time.Second)); ok {
		t.Fatal("due before rendererStale")
	}
	ok, page := r.due(t0.Add(rendererStale))
	if !ok || page != "/agents?x=1#y" {
		t.Fatalf("due = %v, %q; want true, the last page", ok, page)
	}
	// The clock restarts: a page that does not come back is reopened at most once every rendererStale.
	if ok, _ := r.due(t0.Add(rendererStale + time.Second)); ok {
		t.Fatal("reopened twice within rendererStale")
	}
	if ok, _ := r.due(t0.Add(2 * rendererStale)); !ok {
		t.Fatal("a page still silent after another rendererStale must be reopened again")
	}
}

func TestRendererWatch_ReportsKeepItQuiet(t *testing.T) {
	var r rendererWatch
	t0 := time.Unix(1_000_000, 0)
	for i := 0; i < 100; i++ {
		now := t0.Add(time.Duration(i) * time.Minute) // a hidden page's timers run once a minute
		r.alive(now, "/")
		if ok, _ := r.due(now.Add(59 * time.Second)); ok {
			t.Fatalf("reopened a page that reports every minute (report %d)", i)
		}
	}
}

func TestRendererWatch_LongPageNotKept(t *testing.T) {
	var r rendererWatch
	t0 := time.Unix(1_000_000, 0)
	r.alive(t0, "/inbox")
	r.alive(t0, "/"+strings.Repeat("a", maxAlivePage))
	if _, page := r.due(t0.Add(rendererStale)); page != "/inbox" {
		t.Fatalf("page = %q, want the last page of a sane length", page)
	}
}

func TestRendererWatch_SleepIsNotSilence(t *testing.T) {
	var r rendererWatch
	t0 := time.Unix(1_000_000, 0)
	r.alive(t0, "/")
	calls := 0
	reopen := func(string) { calls++ }
	// The computer slept for an hour: the first tick after waking comes far later than asked.
	woke := t0.Add(time.Hour)
	r.tick(t0.Add(rendererCheckEvery), woke, reopen)
	if calls != 0 {
		t.Fatal("reopened right after a sleep")
	}
	// The page reports again after waking: no reopen.
	r.alive(woke.Add(5*time.Second), "/")
	r.tick(woke, woke.Add(rendererCheckEvery), reopen)
	if calls != 0 {
		t.Fatal("reopened a page that reported after the sleep")
	}
	// A page that never comes back after waking is reopened once rendererStale has passed.
	r.tick(woke.Add(rendererStale), woke.Add(rendererStale+rendererCheckEvery), reopen)
	if calls != 1 {
		t.Fatalf("reopen calls = %d, want 1", calls)
	}
}

func TestAliveScript_UsesOnlyTheGuardedFunction(t *testing.T) {
	if !strings.Contains(aliveScript, "window._coralAlive") || strings.Contains(aliveScript, "__coralNative") {
		t.Fatal("aliveScript must call the page-facing _coralAlive (dashboard origin only), never the native binding")
	}
}
