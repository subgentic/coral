// The Sign in with Coral Hub settings and the origins the Hub may sign in from: the caller check, the settings reads and writes, the offer, and CanonicalOrigin. Moved out of hub_signin.go (#8284), no code changed.

package auth

import (
	"errors"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/httputil"
)

// hubSettingsCaller refuses what may not change Hub sign-in's settings. write also needs
// this server's Origin.
func (h *HubSignin) hubSettingsCaller(w http.ResponseWriter, r *http.Request, write bool) bool {
	if refuseAgent(w, r) {
		return false
	}
	if r.Header.Get("X-Coral-Via-Tunnel") != "" {
		authError(w, http.StatusForbidden, "not_through_hub", "Change this on this computer, not through Coral Hub")
		return false
	}
	cli := h.ar.cliVerified(r)
	if write && !cli && !sameOriginWrite(r, true) {
		authError(w, http.StatusForbidden, "cross_origin", "Change this from Coral's own page")
		return false
	}
	if h.ks.IsHubSession(r) {
		authError(w, http.StatusForbidden, hubDeniedCode, "A Coral Hub sign-in can't change this")
		return false
	}
	if !cli && !h.ar.signedIn(r) {
		notSignedIn(w)
		return false
	}
	return true
}

// Settings: GET /api/auth/hub-signin.
func (h *HubSignin) Settings(w http.ResponseWriter, r *http.Request) {
	if !h.hubSettingsCaller(w, r, false) {
		return
	}
	team := h.team()
	enabled, linked := h.settings.SigninEnabled() && !team, h.hub.Linked()
	httputil.WriteJSON(w, http.StatusOK, map[string]any{
		"enabled": enabled, "linked": linked, "team_machine": team,
		"offer":            linked && !enabled && !team && !h.settings.OfferDismissed(),
		"operator_allowed": h.operatorAllowed == nil || h.operatorAllowed(),
	})
}

// SetSettings turns Hub sign-in on or off here: PUT /api/auth/hub-signin {"enabled": bool}.
// Off ends every Hub session at once.
func (h *HubSignin) SetSettings(w http.ResponseWriter, r *http.Request) {
	if !h.hubSettingsCaller(w, r, true) {
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if !readPasswordBody(w, r, &body) || body.Enabled == nil {
		if body.Enabled == nil {
			authError(w, http.StatusBadRequest, "bad_request", `Send {"enabled": true} or {"enabled": false}`)
		}
		return
	}
	if *body.Enabled && h.team() {
		authError(w, http.StatusConflict, "hub_signin_team_machine", "This computer belongs to a Coral Hub organisation: signing in to it with Coral Hub is not offered")
		return
	}
	if err := h.settings.SetSigninEnabled(*body.Enabled); err != nil {
		authError(w, http.StatusInternalServerError, "save_failed", "The setting could not be saved")
		return
	}
	ended := 0
	if *body.Enabled {
		log.Printf("[auth] Sign in with Coral Hub was turned on from %s", clientIP(r))
		h.record(r.Context(), "this computer", "Sign in with Coral Hub enabled")
	} else {
		ended = h.EndAll(r.Context(), "Sign in with Coral Hub was turned off on this computer")
		log.Printf("[auth] Sign in with Coral Hub was turned off from %s; %d session(s) ended", clientIP(r), ended)
		h.record(r.Context(), "this computer", "Sign in with Coral Hub disabled")
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "enabled": *body.Enabled, "signed_out": ended})
}

// DismissOffer is the one-time notice's "Not now": POST /api/auth/hub-signin/dismiss.
func (h *HubSignin) DismissOffer(w http.ResponseWriter, r *http.Request) {
	if !h.hubSettingsCaller(w, r, true) {
		return
	}
	if err := h.settings.DismissOffer(); err != nil {
		authError(w, http.StatusInternalServerError, "save_failed", "Could not be saved")
		return
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GetOrigins: GET /api/auth/hub-origins {"origins": the configured ones, "loopback": this
// server's own, always included (http, and https when it serves TLS), so the page shows them as
// the server has them rather than guessing from its own address.
func (h *HubSignin) GetOrigins(w http.ResponseWriter, r *http.Request) {
	if !h.hubSettingsCaller(w, r, false) {
		return
	}
	var loopback []string
	if h.loopbackOrigins != nil {
		loopback = h.loopbackOrigins()
	}
	httputil.WriteJSON(w, http.StatusOK, map[string]any{"origins": nonNil(h.settings.Origins()), "loopback": nonNil(loopback)})
}

// SetOrigins replaces the configured return origins: PUT /api/auth/hub-origins
// {"origins": [...]}. Each is validated (CanonicalOrigin); the hub is sent the new list.
func (h *HubSignin) SetOrigins(w http.ResponseWriter, r *http.Request) {
	if !h.hubSettingsCaller(w, r, true) {
		return
	}
	var body struct {
		Origins []string `json:"origins"`
	}
	if !readPasswordBody(w, r, &body) {
		return
	}
	limit := maxHubOrigins
	if h.loopbackOrigins != nil {
		limit -= len(h.loopbackOrigins())
	}
	if len(body.Origins) > limit {
		authError(w, http.StatusBadRequest, "too_many", "At most "+strconv.Itoa(limit)+" addresses")
		return
	}
	var out []string
	seen := map[string]bool{}
	for i, o := range body.Origins {
		c, err := CanonicalOrigin(o)
		if err != nil {
			httputil.WriteJSON(w, http.StatusBadRequest, map[string]any{"code": "bad_origin", "index": i, "error": err.Error()})
			return
		}
		if !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	if err := h.settings.SetOrigins(out); err != nil {
		authError(w, http.StatusInternalServerError, "save_failed", "The addresses could not be saved")
		return
	}
	if h.originsChanged != nil {
		h.originsChanged()
	}
	h.record(r.Context(), "this computer", "Coral Hub sign-in addresses changed")
	httputil.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "origins": nonNil(out)})
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// tailscaleV4 and tailscaleV6 are Tailscale's address ranges (CGNAT 100.64/10 and its ULA).
var (
	tailscaleV4 = netip.MustParsePrefix("100.64.0.0/10")
	tailscaleV6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")
)

// CanonicalOrigin validates a return origin and returns its canonical form
// (scheme://host[:port], lower case, no default port, no trailing dot): https to any host
// name or address, or http only to a literal loopback, private (RFC 1918), ULA or Tailscale
// address (or localhost). No userinfo, path, query, fragment or wildcard.
func CanonicalOrigin(s string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || u.Scheme == "" || u.Host == "" || u.Opaque != "" {
		return "", errors.New("not an address like https://name or http://192.168.1.5:8420")
	}
	scheme := strings.ToLower(u.Scheme)
	switch {
	case u.User != nil:
		return "", errors.New("no user name or password in the address")
	case u.Path != "" && u.Path != "/", u.RawQuery != "", u.Fragment != "", u.ForceQuery:
		return "", errors.New("only scheme, host and port: no path, query or #")
	case scheme != "https" && scheme != "http":
		return "", errors.New("use https (or http to a private address)")
	}
	host, port := u.Hostname(), u.Port()
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == "" || strings.ContainsAny(host, "*%") {
		return "", errors.New("no wildcards")
	}
	if strings.HasPrefix(host, ".") || strings.Contains(host, "..") || strings.HasSuffix(host, ".") {
		return "", errors.New("not a host name") // "https://.." trims to "." and is no origin a browser sends
	}
	if port != "" {
		if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
			return "", errors.New("the port must be 1 to 65535")
		}
	}
	addr, ipErr := netip.ParseAddr(host)
	if scheme == "http" && host != "localhost" {
		if ipErr != nil {
			return "", errors.New("http only to a numeric private address; use https for a name")
		}
		addr = addr.Unmap()
		if !(addr.IsLoopback() || addr.IsPrivate() || tailscaleV4.Contains(addr) || tailscaleV6.Contains(addr)) {
			return "", errors.New("http only to a loopback, private or Tailscale address")
		}
	}
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	h := host
	if ipErr == nil && addr.Is6() {
		h = "[" + addr.String() + "]"
	} else if ipErr == nil {
		h = addr.String()
	}
	if port != "" {
		h = net.JoinHostPort(strings.Trim(h, "[]"), port)
	}
	return scheme + "://" + h, nil
}
