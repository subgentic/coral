package auth

import (
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
)

// ProxyMessage is the warning Settings and the startup log give once a request shows Coral is reached through a proxy while remote access is off (#21527).
const ProxyMessage = "Coral is being reached through a proxy; set a password"

var (
	proxySeen    atomic.Bool
	proxyLogOnce sync.Once
)

// ProxiedRequest reports whether r looks like it came through a reverse proxy or a public name: it carries a forwarding header, or its Host is not a local name. The caller decides whether that matters (it only does while Coral listens on this computer alone).
func ProxiedRequest(r *http.Request) bool {
	if hasProxyHeaders(r) {
		return true
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(strings.TrimSpace(host), "[]")
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return false
	}
	ip := net.ParseIP(host)
	return ip == nil || !ip.IsLoopback()
}

// NoteProxied remembers that a proxied request arrived (until Coral restarts) and logs the warning once. passwordSet says whether the warning is red. It never refuses or changes the request.
func NoteProxied(passwordSet func() bool, strictLocal bool) {
	proxySeen.Store(true)
	proxyLogOnce.Do(func() {
		if ProxyWarningRed(passwordSet(), strictLocal) {
			log.Printf("[auth] WARNING: %s. %s", ProxyMessage, ProxyRedDetail)
			return
		}
		log.Printf("[auth] WARNING: %s (a password is set and local requests need a credential). To refuse proxied requests outright, start Coral with --hub-only and reach it only through a Hub.", ProxyMessage)
	})
}

// ProxySeen reports whether a proxied request has reached Coral since it started.
func ProxySeen() bool { return proxySeen.Load() }

// ProxyRedDetail says why the warning is red.
const ProxyRedDetail = "A request from the proxy can pass as a local one, so it may get in with no credential: set a password, turn on require_auth_on_loopback, and do not start Coral with strict local auth off. Or start Coral with --hub-only and reach it only through a Hub."

// ProxyWarningRed is true when the proxied access can get in with no credential: require_auth_on_loopback is off and either no password is set or strict local auth is off (a proxy that adds no header then looks local, even with a password) (#21527).
func ProxyWarningRed(passwordSet, strictLocal bool) bool {
	return !RequireAuthOnLoopback() && (!passwordSet || !strictLocal)
}

// ResetProxySeenForTest clears the remembered sighting (tests only).
func ResetProxySeenForTest() {
	proxySeen.Store(false)
	proxyLogOnce = sync.Once{}
}
