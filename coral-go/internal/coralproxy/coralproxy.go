// Package coralproxy lets the command-line clients that run inside Codex's sandbox (coral-board, coral-agent) reach Coral through Codex's own command proxy (#7489).
//
// Codex can run a sandboxed command under a permission profile that allows the network only through a local proxy and only to named hosts (127.0.0.1 for Coral). The proxy is announced to the command in the
// environment (CODEX_NETWORK_PROXY_ACTIVE and the usual HTTP_PROXY variables), but Go's http.ProxyFromEnvironment never uses a proxy for a loopback address, so the clients' own connection to Coral is refused
// by the sandbox. Func sends a loopback request through the proxy when, and only when, Codex says its proxy is active.
//
// Three guards keep this from changing anything else: (1) it needs Codex's own marker, so a person's corporate HTTP_PROXY is never applied to Coral's loopback calls; (2) the proxy must itself be on this
// computer (a loopback address), because the request carries Coral's session token and must never be handed to a proxy elsewhere; (3) every other request goes through http.ProxyFromEnvironment as before.
package coralproxy

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// Marker is the variable Codex sets in a command's environment when its network proxy is active.
const Marker = "CODEX_NETWORK_PROXY_ACTIVE"

// Active reports whether Codex says its network proxy is active for this process.
func Active() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(Marker)))
	return v != "" && v != "0" && v != "false" && v != "no"
}

// loopbackIP reports whether host (no port) is a loopback IP address.
func loopbackIP(host string) bool {
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// loopbackHost reports whether host (no port) is localhost or a loopback IP address: the request side.
func loopbackHost(host string) bool {
	return strings.EqualFold(host, "localhost") || loopbackIP(host)
}

// codexProxy is Codex's proxy from the environment: an http(s) URL on a loopback address, or nil.
func codexProxy() *url.URL {
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		raw := strings.TrimSpace(os.Getenv(name))
		if raw == "" {
			continue
		}
		if !strings.Contains(raw, "://") {
			raw = "http://" + raw
		}
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || !loopbackIP(u.Hostname()) { // an IP, never the name localhost: a changed hosts file must not move the proxy
			continue
		}
		return u
	}
	return nil
}

// Func is an http.Transport's Proxy: the Codex proxy for a loopback request while Codex's proxy is active, http.ProxyFromEnvironment for everything else.
func Func(req *http.Request) (*url.URL, error) {
	if Active() && loopbackHost(req.URL.Hostname()) {
		if u := codexProxy(); u != nil {
			return u, nil
		}
	}
	return http.ProxyFromEnvironment(req)
}

// Install makes the default transport use Func. It does nothing when the default transport is not a plain *http.Transport (something already wrapped it: the clients call this first).
func Install() {
	if t, ok := http.DefaultTransport.(*http.Transport); ok {
		t.Proxy = Func
	}
}
