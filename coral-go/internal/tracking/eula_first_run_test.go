package tracking

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
)

// freshInstall makes the data folder one that has had no install yet: no .install_id (trackInstall writes it, after startup.Start has already said the Terms were accepted).
func freshInstall(t *testing.T) (*recorder, string) {
	t.Helper()
	rec, dir := newTestTracking(t)
	assert.NoError(t, os.Remove(filepath.Join(dir, ".install_id")))
	installIDMu.Lock()
	cachedInstallID = ""
	installIDMu.Unlock()
	return rec, dir
}

// #16569 (BD's #16568: eula_accepted had never arrived in PostHog, 0 events ever, while the other funnel events did): on a first run the acceptance is said inside startup.Start, before
// TrackInstallAsync has written the install ID, so the send found no ID, failed, and was never tried again (nothing calls TrackEULAAccepted a second time: the acceptance is taken once, and a
// later start is not a first run). The acceptance stays pending and goes out once the install exists.
func TestAnAcceptanceSaidBeforeTheInstallIDExistsIsSentOnceItDoes(t *testing.T) {
	rec, _ := freshInstall(t)
	TrackEULAAccepted(EULASourceDialog)
	waitForAsync()
	assert.Zero(t, rec.count(EventEULAAccepted), "no install ID yet: nothing can be sent for this install")
	TrackInstallAsync() // what the server does right after it starts
	waitForAsync()
	assert.Equal(t, 1, rec.count(EventInstall), rec.names())
	assert.Equal(t, 1, rec.count(EventEULAAccepted), "the acceptance goes out once the install exists: %v", rec.names())
	for _, e := range rec.all() {
		if e.Event == EventEULAAccepted {
			assert.Equal(t, "dialog", e.Properties["source"])
		}
	}
	TrackInstallAsync() // a later start
	waitForAsync()
	assert.Equal(t, 1, rec.count(EventEULAAccepted), "once only: %v", rec.names())
}

// A first run with no network: the acceptance is kept and sent at a later start that reaches PostHog (the stored snapshot keeps its time and its source). The recorder logs refused attempts too, so
// "sent" is counted past the attempts made while PostHog said no.
func TestAnAcceptanceThatCouldNotBeDeliveredIsSentAtALaterStart(t *testing.T) {
	rec, _ := freshInstall(t)
	TrackEULAAccepted(EULASourceHub)
	waitForAsync() // before the install exists, as startup.Start says it
	rec.mu.Lock()
	rec.status = 500
	rec.mu.Unlock()
	TrackInstallAsync()
	waitForAsync()
	attempts := rec.count(EventEULAAccepted) // tried at the install, refused
	rec.mu.Lock()
	rec.status = 200
	rec.mu.Unlock()
	TrackInstallAsync() // the next start
	waitForAsync()
	assert.Greater(t, rec.count(EventEULAAccepted), attempts, "sent at the later start: %v", rec.names())
	after := rec.count(EventEULAAccepted)
	TrackInstallAsync() // and not again
	waitForAsync()
	assert.Equal(t, after, rec.count(EventEULAAccepted), "once delivered it is not sent again")
	for _, e := range rec.all() {
		if e.Event == EventEULAAccepted {
			assert.Equal(t, "hub", e.Properties["source"])
		}
	}
}

// Analytics off: a pending acceptance is dropped, never replayed after a later opt-in.
func TestAPendingAcceptanceIsNotReplayedAfterAnOptOut(t *testing.T) {
	rec, _ := freshInstall(t)
	TrackEULAAccepted(EULASourceDialog)
	waitForAsync()
	SetTelemetryEnabled(false)
	t.Cleanup(func() { SetTelemetryEnabled(true) })
	SetTelemetryEnabled(true)
	TrackInstallAsync()
	waitForAsync()
	assert.Zero(t, rec.count(EventEULAAccepted), "what waited while analytics were switched off is gone: %v", rec.names())
}
