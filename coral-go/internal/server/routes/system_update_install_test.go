package routes

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/internal/updater/trigger"
)

// The local "Install update" (#166): a person at this computer only, no body, Windows only, and the server quits only once the updater is running.
func TestInstallUpdateIsLocalPersonOnly(t *testing.T) {
	old := updateInstallPlatform
	updateInstallPlatform = true
	t.Cleanup(func() { updateInstallPlatform = old })

	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "c.db"))
	require.NoError(t, err)
	defer db.Close()
	h := NewCloudHandler(store.NewSessionStore(db), t.TempDir())
	peer := [2]bool{true, true}
	h.SetPeerCheck(func(*http.Request) (bool, bool) { return peer[0], peer[1] })

	var launched, quit int
	var launchErr, preErr error
	h.stagedUpdate = func(context.Context) (string, error) { return "1.5.0", nil }
	h.preflightUpdater = func(context.Context) error { return preErr }
	h.launchUpdater = func(context.Context) error { launched++; return launchErr }
	h.QuitForUpdate = func() error { quit++; return nil }

	req := func(body string, mut func(*http.Request) *http.Request) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8420/api/system/update/install", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:5555"
		r.Header.Set("Origin", "http://127.0.0.1:8420")
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		r = r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerDashCookie))
		if mut != nil {
			r = mut(r)
		}
		rec := httptest.NewRecorder()
		h.InstallUpdate(rec, r)
		return rec
	}
	reset := func() { launched, quit, launchErr, preErr = 0, 0, nil, nil; h.installing = 0 }

	// #395: a staged release that is not newer than the running one is never installed, and the page is told why.
	t.Run("a staged release that is not newer than the running Coral is refused as not_newer", func(t *testing.T) {
		for _, tc := range []struct{ staged, installed string }{
			{"2.0.1", "2.0.3"},     // lower
			{"2.0.3", "2.0.3"},     // equal
			{"2.0.3", "2.0.4-rc1"}, // lower than a prerelease of a later version
			{"2.0.3", "v2.0.3"},    // equal, with a "v"
		} {
			reset()
			h.installedVersion = func() string { return tc.installed }
			h.stagedUpdate = func(context.Context) (string, error) { return tc.staged, nil }
			rec := req("", nil)
			assert.Equal(t, http.StatusConflict, rec.Code, tc.staged+" vs "+tc.installed)
			assert.Contains(t, rec.Body.String(), "not_newer", tc.staged+" vs "+tc.installed)
			assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit}, "nothing was started: "+tc.staged+" vs "+tc.installed)
		}
		for _, tc := range []struct{ staged, installed string }{
			{"2.0.4", "2.0.3"},     // higher
			{"2.0.3", "2.0.3-rc1"}, // a release is above a prerelease of the same version
			{"1.5.0", "dev"},       // a build with no version is never blocked by this check
		} {
			reset()
			h.installedVersion = func() string { return tc.installed }
			h.stagedUpdate = func(context.Context) (string, error) { return tc.staged, nil }
			assert.Equal(t, http.StatusAccepted, req("", nil).Code, tc.staged+" vs "+tc.installed)
		}
		h.installedVersion = nil
		h.stagedUpdate = func(context.Context) (string, error) { return "1.5.0", nil }
	})
	t.Run("the dashboard on this computer starts the updater, then quits", func(t *testing.T) {
		reset()
		rec := req("", nil)
		require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
		assert.JSONEq(t, `{"ok":true,"version":"1.5.0","quitting":true}`, rec.Body.String())
		assert.Equal(t, [2]int{1, 1}, [2]int{launched, quit})
		assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	})
	t.Run("an empty object is the same request", func(t *testing.T) {
		reset()
		require.Equal(t, http.StatusAccepted, req("{}", nil).Code)
	})
	t.Run("the request names nothing to install: a body that chooses a path or an address is refused", func(t *testing.T) {
		for _, body := range []string{`{"path":"C:\\x.msi"}`, `{"url":"http://x"}`, `{"version":"1.5.0","path":"C:\\x.msi"}`, `{"version":9}`, `{"version":null}`, `{"version":"1.5.0"} {}`, strings.Repeat(" ", 70)} {
			reset()
			rec := req(body, nil)
			assert.Equal(t, http.StatusBadRequest, rec.Code, body)
			assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit}, body)
		}
	})
	// #7338: the page says which version it showed; the server installs only that one. The version is a check, never a choice.
	t.Run("the version the page showed is installed when it is the one staged", func(t *testing.T) {
		reset()
		rec := req(`{"version":"1.5.0"}`, nil)
		require.Equal(t, http.StatusAccepted, rec.Code, rec.Body.String())
		assert.JSONEq(t, `{"ok":true,"version":"1.5.0","quitting":true}`, rec.Body.String())
		assert.Equal(t, [2]int{1, 1}, [2]int{launched, quit})
	})
	t.Run("a version that is not the staged one installs nothing and says the update changed", func(t *testing.T) {
		for _, body := range []string{`{"version":"9.9.9"}`, `{"version":"1.4.9"}`, `{"version":""}`, `{"version":"1.5.0-rc1"}`, `{"version":" 1.5.0"}`} {
			reset()
			rec := req(body, nil)
			assert.Equal(t, http.StatusConflict, rec.Code, body)
			assert.Contains(t, rec.Body.String(), "stale_version", body)
			assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit}, body)
		}
	})
	t.Run("through Coral Hub it is refused", func(t *testing.T) {
		reset()
		rec := req("", func(r *http.Request) *http.Request { return stamp(r) })
		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit})
	})
	t.Run("an agent's session token is refused, whatever else the request carries", func(t *testing.T) {
		reset()
		rec := req("", func(r *http.Request) *http.Request {
			r.Header.Set(store.SessionTokenHeader, "an-agents-token")
			return r
		})
		assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
		assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit})
	})
	t.Run("a local program that leaves its token out and sends the dashboard's headers is refused (#323 F1)", func(t *testing.T) {
		for _, kind := range []string{callerDashNoCookie, callerLocalOther, callerAgentNoToken, callerAPIKey, callerOpen} {
			reset()
			rec := req("", func(r *http.Request) *http.Request {
				return r.WithContext(context.WithValue(r.Context(), callerKindKey{}, kind))
			})
			assert.Equal(t, http.StatusForbidden, rec.Code, kind+": "+rec.Body.String())
			assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit}, kind)
		}
	})
	t.Run("another local user is refused", func(t *testing.T) {
		reset()
		peer = [2]bool{false, true}
		t.Cleanup(func() { peer = [2]bool{true, true} })
		assert.Equal(t, http.StatusForbidden, req("", nil).Code)
		assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit})
	})
	t.Run("a request that is not the dashboard (no browser marks) is refused", func(t *testing.T) {
		reset()
		rec := req("", func(r *http.Request) *http.Request {
			r.Header.Del("Origin")
			r.Header.Del("Sec-Fetch-Site")
			return r.WithContext(context.Background())
		})
		assert.Equal(t, http.StatusForbidden, rec.Code)
		assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit})
	})
	t.Run("not Windows: 409, nothing started", func(t *testing.T) {
		reset()
		updateInstallPlatform = false
		t.Cleanup(func() { updateInstallPlatform = true })
		rec := req("", nil)
		assert.Equal(t, http.StatusConflict, rec.Code)
		assert.Contains(t, rec.Body.String(), "unsupported_platform")
		assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit})
	})
	t.Run("nothing staged: 409, the server keeps running", func(t *testing.T) {
		reset()
		h.stagedUpdate = func(context.Context) (string, error) { return "", errors.New("none") }
		t.Cleanup(func() { h.stagedUpdate = func(context.Context) (string, error) { return "1.5.0", nil } })
		rec := req("", nil)
		assert.Equal(t, http.StatusConflict, rec.Code)
		assert.Contains(t, rec.Body.String(), "nothing_staged")
		assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit})
	})
	t.Run("no way to quit for the updater (not under the tray): 409, the updater is not started", func(t *testing.T) {
		reset()
		keep := h.QuitForUpdate
		h.QuitForUpdate = nil
		t.Cleanup(func() { h.QuitForUpdate = keep })
		rec := req("", nil)
		assert.Equal(t, http.StatusConflict, rec.Code)
		assert.Contains(t, rec.Body.String(), "install_unavailable")
		assert.Zero(t, launched)
	})
	t.Run("the updater could not be started: 500, and the server does NOT quit", func(t *testing.T) {
		reset()
		launchErr = errors.New("boom")
		rec := req("", nil)
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.Contains(t, rec.Body.String(), "updater_not_started")
		assert.Equal(t, [2]int{1, 0}, [2]int{launched, quit})
		// and it can be tried again
		launchErr = nil
		assert.Equal(t, http.StatusAccepted, req("", nil).Code)
	})
	// The server quits once the updater is running, so the updater is asked first (#5946): each answer that means "I will not install" is a 409 with its own
	// code, the updater is never started and the server never quits.
	for name, tc := range map[string]struct {
		err  error
		code string
	}{
		"the apply is not turned on":       {trigger.ErrApplyDisabled, "apply_not_enabled"},
		"updates are off for this build":   {trigger.ErrUpdatesOff, "updates_off"},
		"not a registered per-machine one": {trigger.ErrInstallUnsupported, "install_not_supported"},
		"the updater cannot be asked":      {trigger.ErrUpdaterUnavailable, "updater_unavailable"},
		"an error nobody expected":         {errors.New("boom"), "updater_unavailable"},
		"wrapped, as Preflight returns it": {fmt.Errorf("%w: exit 1", trigger.ErrUpdaterUnavailable), "updater_unavailable"},
	} {
		t.Run("the updater says no: "+name, func(t *testing.T) {
			reset()
			preErr = tc.err
			rec := req("", nil)
			assert.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
			assert.Contains(t, rec.Body.String(), tc.code)
			assert.Equal(t, [2]int{0, 0}, [2]int{launched, quit}, "Coral keeps running: nothing was started and it did not quit")
			assert.Zero(t, h.installing, "and the next try is not held up")
		})
	}
	t.Run("a second request while one is under way is refused", func(t *testing.T) {
		reset()
		require.Equal(t, http.StatusAccepted, req("", nil).Code)
		rec := req("", nil)
		assert.Equal(t, http.StatusConflict, rec.Code)
		assert.Contains(t, rec.Body.String(), "busy")
		assert.Equal(t, [2]int{1, 1}, [2]int{launched, quit})
	})
}

// On Windows the Hub's relaunch is refused (#166): the install needs a person at this computer to approve it, so Coral Hub can neither start it nor
// leave Coral stopped behind a prompt nobody sees. Elsewhere it is as before (TestRelaunchHappyPathAndStatusShape).
func TestRelaunchIsRefusedOnWindows(t *testing.T) {
	e := newRelaunchEnv(t) // (it stands for a non-Windows OS; the next line stands for Windows; its cleanup restores the real value)
	relaunchNeedsLocalApproval = true

	code, st := e.status(hubHdr(ownerA))
	require.Equal(t, 200, code)
	rl := st["relaunch"].(map[string]any)
	assert.Equal(t, false, rl["available"])
	assert.Equal(t, "local_approval_needed", rl["reason"])
	assert.NotContains(t, rl, "ack", "no token is issued for a relaunch that cannot start")

	for _, body := range []string{`{"ack":"anything"}`, "", "{}"} {
		code, out := e.post(body, hubHdr(ownerA))
		assert.Equal(t, 409, code, body)
		assert.Equal(t, "local_approval_needed", out["code"], "%v", out)
	}
	assert.Zero(t, e.up.applyCount(), "nothing was started")
}

// #7338: the status tells the page whether the person here may install: only a request from this computer's own dashboard, only where the install is a local one (Windows).
// A machine behind Coral Hub (a viewer, the owner) is told nothing it could draw an Install update button from.
func TestStatusSaysWhetherThePersonHereMayInstall(t *testing.T) {
	e := newRelaunchEnv(t) // a non-Windows OS
	code, st := e.status(nil)
	require.Equal(t, 200, code)
	assert.NotContains(t, st, "local_install", "elsewhere an update installs by relaunch")

	relaunchNeedsLocalApproval = true // Windows
	code, st = e.status(nil)
	require.Equal(t, 200, code)
	assert.Equal(t, true, st["local_install"], "the dashboard on this computer may install")
	assert.Equal(t, "local_approval_needed", st["relaunch"].(map[string]any)["reason"])

	code, st = e.status(hubHdr(ownerA))
	require.Equal(t, 200, code)
	assert.NotContains(t, st, "local_install", "through Coral Hub nobody installs")
}
