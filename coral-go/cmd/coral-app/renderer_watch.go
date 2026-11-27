//go:build webview

package main

import (
	"runtime"
	"sync"
	"time"
)

// A WebView2 window whose page process is gone shows a white body under the title bar, or an error page, and stays that way:
// the page's own health check (nativeAppScript) cannot run without the page, and webview_go exposes neither WebView2's
// ProcessFailed event nor its controller. So the page reports that it is alive (aliveScript, through the token-guarded
// _coralAlive), and the app opens the dashboard again when those reports stop for rendererStale. A new navigation starts a
// new page process. A page process can die when the computer runs short of memory; the new one may fail too, so the
// watch tries again every rendererStale until a page answers.
const (
	rendererStale      = 150 * time.Second // more than twice the 1-minute floor Chromium throttles a hidden page's timers to
	rendererCheckEvery = 15 * time.Second
	maxAlivePage       = 2048 // the longest page address kept from a report
)

// rendererWatchOn is where the watch runs. Windows only: the white window is a WebView2 report, and macOS can hold a hidden
// app's timers far longer than a minute (App Nap), which would reload a healthy page and lose what the person was typing.
var rendererWatchOn = runtime.GOOS == "windows"

// aliveScript reports every 5 s that the page is alive, with the page it shows (path, query and hash), so the app can reopen it.
// _coralAlive exists only on the dashboard's origin (apptoken.ShimScript): an error page or another site never reports.
const aliveScript = `(function(){
	function beat() { try { if (window._coralAlive) window._coralAlive(location.pathname + location.search + location.hash); } catch (e) {} }
	beat();
	setInterval(beat, 5000);
})();`

// rendererWatch keeps the time of the page's last report and decides when the page has been silent too long.
type rendererWatch struct {
	mu    sync.Mutex
	last  time.Time
	page  string
	armed bool // a page has reported at least once: the first load is never cut short
}

// alive records a report from the page.
func (r *rendererWatch) alive(now time.Time, page string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.last, r.armed = now, true
	if len(page) <= maxAlivePage {
		r.page = page
	}
}

// due reports whether the page has been silent for rendererStale, and gives the last page it showed. A true answer restarts
// the clock, so a page that does not come back is opened again at most once every rendererStale.
func (r *rendererWatch) due(now time.Time) (bool, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.armed || now.Sub(r.last) < rendererStale {
		return false, ""
	}
	r.last = now
	return true, r.page
}

// woke restarts the clock after the computer slept (or this process was stopped): the page could not report then either, and it
// gets a full rendererStale to report again before it counts as gone.
func (r *rendererWatch) woke(now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.last = now
}

// run checks the watch every rendererCheckEvery and calls reopen with the last page when it is due. A tick that comes far later
// than asked (sleep, hibernation) is not a silent page. It returns when stop is closed.
func (r *rendererWatch) run(stop <-chan struct{}, reopen func(page string)) {
	t := time.NewTicker(rendererCheckEvery)
	defer t.Stop()
	prev := time.Now()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			now := time.Now()
			r.tick(prev, now, reopen)
			prev = now
		}
	}
}

// tick is one check: prev is the time of the check before.
func (r *rendererWatch) tick(prev, now time.Time, reopen func(page string)) {
	if now.Sub(prev) > 4*rendererCheckEvery {
		r.woke(now)
		return
	}
	if ok, page := r.due(now); ok {
		reopen(page)
	}
}
