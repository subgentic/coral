package auth

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
)

// Hub-only mode (#21558): Coral listens on this computer only, forces a credential on every local request, and refuses any request that came through a proxy or a public name, so the only way
// in from another computer is Coral Hub's tunnel. A server started with --hub-only (or CORAL_HUB_ONLY=1) stays hub-only on later starts: the choice is a marker file in the data folder that only a
// process on this computer can write (`coral hub-only on|off`), never a setting a Hub or any request can change.

// HubOnlyEnv turns hub-only on for a start, like --hub-only.
const HubOnlyEnv = "CORAL_HUB_ONLY"

// HubOnlyRefusal is the one line a refused request gets.
const HubOnlyRefusal = "This Coral is reached through Coral Hub only."

var hubOnly atomic.Bool

// SetHubOnly sets whether this run is hub-only. Startup sets it once, before the server is made.
func SetHubOnly(v bool) { hubOnly.Store(v) }

// HubOnly reports whether this run is hub-only.
func HubOnly() bool { return hubOnly.Load() }

func hubOnlyMarker(dir string) string { return filepath.Join(dir, "hub-only") }

// HubOnlyPersisted reports whether the data folder holds the hub-only marker.
func HubOnlyPersisted(dir string) bool {
	if dir == "" {
		return false
	}
	_, err := os.Stat(hubOnlyMarker(dir))
	return err == nil
}

// SetHubOnlyPersisted writes or removes the marker.
func SetHubOnlyPersisted(dir string, on bool) error {
	if dir == "" {
		return nil
	}
	if !on {
		if err := os.Remove(hubOnlyMarker(dir)); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(hubOnlyMarker(dir), []byte("hub-only: Coral is reached through Coral Hub only. Turn it off with: coral hub-only off\n"), 0o600)
}

// HubOnlyGate refuses, before anything else sees it, a request that carries a forwarding header (X-Forwarded-*, Forwarded, Via, X-Real-IP, ...) or a Host that is not this computer's, whatever
// the password, while the run is hub-only. A request Coral Hub's connector forwarded (authentic reports the connector's secret stamp) passes; a request that carries the stamp but not the
// secret is a forgery and is refused. The local command line, the hooks and a browser on this computer carry none of these, so they pass. Nothing is changed or logged per request.
func HubOnlyGate(authentic, stamped func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !HubOnly() || authentic(r) {
				next.ServeHTTP(w, r)
				return
			}
			if stamped(r) || ProxiedRequest(r) {
				refuseHubOnly(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func refuseHubOnly(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("<!doctype html><meta charset=utf-8><title>Coral Hub only</title><p>" + HubOnlyRefusal + " Sign in at Coral Hub.</p>\n"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": HubOnlyRefusal, "error_code": "hub_only"})
}
