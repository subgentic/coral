package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/httputil"
)

// Sign in with Coral Hub, the local half (#3966; design note r2, sections 1 and 4-6 and 12-13).
// A Hub sign-in is a full Operator browser session for this computer's owner, like a password
// session, with the exceptions in hubSessionDenied. Coral Hub can sign the owner in here only
// while the local setting is on, Coral Hub may act as the Operator (#3404), the computer is
// linked, and the hub accepted the origin the page was reached on.

// SessionByHub is a browser session signed in through Coral Hub.
const SessionByHub = "hub"

var (
	// ErrHubUnanswered: Coral Hub didn't answer (no tunnel, a timeout). A Hub session may wait
	// for the next check, up to hubCheckGrace.
	ErrHubUnanswered = errors.New("auth: Coral Hub didn't answer")
	// ErrHubDisabled: the hub's own per-machine switch for Hub sign-in is off (begin only).
	ErrHubDisabled = errors.New("auth: Sign in with Coral Hub is off for this computer in Coral Hub")
)

// HubGrant is a redeemed Hub sign-in.
type HubGrant struct {
	Grant, Account, Display string
	TTL                     time.Duration
}

// HubBackend is Coral Hub as the sign-in sees it (the server adapts internal/cloud's Manager;
// this package can't import it).
type HubBackend interface {
	// Linked: enrolled with the configured hub and not revoked.
	Linked() bool
	// Ready: a sign-in may start for a page reached on origin now.
	Ready(ctx context.Context, origin string) bool
	// Start begins a flow and returns the hub page to send the browser to (ErrHubDisabled).
	Start(ctx context.Context, challenge, state, origin string) (string, error)
	Redeem(ctx context.Context, code, verifier string) (HubGrant, error)
	// Check is nil while grant holds, ErrHubUnanswered when no answer came, else an error that
	// ends the session at once.
	Check(ctx context.Context, grant string) error
	// Link starts linking this computer (the device-code enrollment) and returns where the
	// person approves it.
	Link(ctx context.Context) (verificationURL, userCode string, err error)
	// LinkState is "enrolling", "linked" or "failed" (with a message) for the last Link.
	LinkState() (state, message string)
	// HubPage is Coral Hub's own https address on the configured host, or "".
	HubPage() string
}

// HubSettings keeps the local settings (user_settings; the server adapts the store). They
// are written only by this file's routes, never by PUT /api/settings.
type HubSettings interface {
	SigninEnabled() bool
	SetSigninEnabled(on bool) error
	Origins() []string // the configured extra return origins, already validated
	SetOrigins(origins []string) error
	OfferDismissed() bool
	DismissOffer() error
}

const (
	hubFlowTTL       = 5 * time.Minute
	hubFlowsMax      = 5
	hubFlowYoungest  = time.Minute // an open flow younger than this is never dropped for a new one from ANOTHER client
	hubFlowsPerAddr  = 2           // open flows one client (an IPv4 address, an IPv6 /64) holds: its next start replaces its oldest
	hubStartsPerAddr = 10          // per minute
	hubStartsGlobal  = 30          // per minute
	hubCheckEvery    = 60 * time.Second
	hubCheckGrace    = 10 * time.Minute // unanswered checks keep a session at most this long
	hubLinkTTL       = 15 * time.Minute
	hubDeniedCode    = "hub_session_not_allowed"
	hubFlowCookie    = "coral_hub_flow"
	hubLinkCookie    = "coral_hub_link"
	hubFlowPath      = "/auth/hub/"
	hubDisabledShown = 10 * time.Minute // the sign-in page says "turned off in Coral Hub" this long
	maxHubOrigins    = 16
)

// hubFlow is one started sign-in. Only hashes of the state and the flow cookie are kept.
type hubFlow struct {
	stateHash, cookieHash [32]byte
	verifier, origin      string
	addr                  string // the client that started it (rateKey)
	created               time.Time
	used                  bool
}

// hubLink is one unpaired "link and sign in" started from the sign-in page.
type hubLink struct {
	cookieHash [32]byte
	enable     bool
	created    time.Time
	applied    bool
}

// HubSignin serves Sign in with Coral Hub. Nil-safe where the server may not have one.
type HubSignin struct {
	ks       *KeyStore
	ar       *Routes
	hub      HubBackend
	settings HubSettings
	// operatorAllowed is the #3404 switch: false when "Don't let Coral Hub act as the
	// Operator" is on.
	operatorAllowed func() bool
	// teamMachine is true when this computer belongs to a Coral Hub organisation (#7061), or when that cannot be told: Hub sign-in is refused there, not only off. A person's account that enrolled the
	// machine must not become a standing way into the organisation's computer, and the organisation's owners reach it through Coral Hub's own routes.
	teamMachine func() bool
	// loopbackOrigins are this server's own loopback origins, always on the list.
	loopbackOrigins func() []string
	// originsChanged tells the connector to send the list again.
	originsChanged func()
	// onAction records a Hub session's request and the sign-in's own events in the
	// Operator-actions log.
	onAction func(ctx context.Context, who, method, path string, status int)
	now      func() time.Time

	mu           sync.Mutex
	flows        []*hubFlow
	starts       map[string][]time.Time // per address, the last minute
	startsAll    []time.Time
	links        []*hubLink
	disabledSeen time.Time
	lastCheck    map[string]time.Time
	readLogged   map[string]time.Time // session id hash + route: when a read was last recorded
	allowedAt    time.Time            // allowed()'s cached answer, for a second
	allowedVal   bool
}

// HubSigninConfig wires a HubSignin.
type HubSigninConfig struct {
	Hub             HubBackend
	Settings        HubSettings
	OperatorAllowed func() bool
	TeamMachine     func() bool
	LoopbackOrigins func() []string
	OriginsChanged  func()
	OnAction        func(ctx context.Context, who, method, path string, status int)
}

// NewHubSignin makes the routes' Hub sign-in.
func (ar *Routes) NewHubSignin(c HubSigninConfig) *HubSignin {
	h := &HubSignin{
		ks: ar.ks, ar: ar, hub: c.Hub, settings: c.Settings, operatorAllowed: c.OperatorAllowed, teamMachine: c.TeamMachine,
		loopbackOrigins: c.LoopbackOrigins, originsChanged: c.OriginsChanged, onAction: c.OnAction, now: time.Now,
		starts: map[string][]time.Time{}, lastCheck: map[string]time.Time{},
		readLogged: map[string]time.Time{},
	}
	ar.hub = h
	return h
}

// team reports whether sign-in is refused because the computer is a Coral Hub organisation's (#7061).
func (h *HubSignin) team() bool { return h != nil && h.teamMachine != nil && h.teamMachine() }

func (h *HubSignin) record(ctx context.Context, who, what string) {
	if h.onAction != nil {
		h.onAction(ctx, who, "EVENT", what, 0)
	}
}

// allowed is every local condition for Hub sign-in: the setting on, Coral Hub allowed to act
// as the Operator, and linked. When it turns false, live Hub sessions end (the check loop).
func (h *HubSignin) allowed() bool {
	return h != nil && !h.team() && h.settings.SigninEnabled() && (h.operatorAllowed == nil || h.operatorAllowed()) && h.hub.Linked()
}

// allowedCached is allowed, read at most once a second: it is asked on every Hub-session
// request. The routes that change it (the setting, #3404) also end the sessions themselves.
func (h *HubSignin) allowedCached() bool {
	h.mu.Lock()
	if now := h.now(); now.Sub(h.allowedAt) < time.Second && !h.allowedAt.IsZero() {
		v := h.allowedVal
		h.mu.Unlock()
		return v
	}
	h.mu.Unlock()
	v := h.allowed()
	h.mu.Lock()
	h.allowedAt, h.allowedVal = h.now(), v
	h.mu.Unlock()
	return v
}

// hubSensitiveRead names the read routes whose use by a Hub session is recorded (Security's
// ruling (a)): file content, diffs, transcripts, terminal capture, history, peek and artifact
// downloads. It returns the route's pattern, or "".
func hubSensitiveRead(method, path string) string {
	if method != http.MethodGet && method != http.MethodHead {
		return ""
	}
	seg := strings.Split(strings.Trim(path, "/"), "/")
	switch {
	case len(seg) >= 5 && seg[0] == "api" && seg[1] == "sessions" && seg[2] == "live":
		switch rest := strings.Join(seg[4:], "/"); rest {
		case "file-content", "file-original", "diff", "changes.diff", "chat", "capture", "poll", "history/search", "history/context":
			return "/api/sessions/live/{name}/" + rest
		}
	case len(seg) == 4 && seg[0] == "api" && seg[1] == "sessions" && seg[3] == "changes.diff":
		return "/api/sessions/{id}/changes.diff"
	case len(seg) >= 3 && seg[0] == "api" && seg[1] == "sessions" && seg[2] == "history":
		return "/api/sessions/history/*"
	case len(seg) >= 3 && seg[0] == "api" && seg[1] == "agent" && seg[2] == "history":
		return "/api/agent/history/*"
	case len(seg) == 4 && seg[0] == "api" && seg[1] == "board" && seg[3] == "peek":
		return "/api/board/{project}/peek"
	case len(seg) == 6 && seg[0] == "api" && seg[1] == "board" && seg[3] == "tasks" && (seg[5] == "artifact-content" || seg[5] == "changes.diff"):
		return "/api/board/{project}/tasks/{id}/" + seg[5]
	case len(seg) >= 3 && seg[0] == "api" && seg[1] == "artifacts":
		return "/api/artifacts/*"
	}
	return ""
}

// readToRecord reports whether a Hub session's read of route should go in the log now: once a
// minute per session and route.
func (h *HubSignin) readToRecord(id, route string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.now()
	k := id + " " + route
	if last, ok := h.readLogged[k]; ok && now.Sub(last) < time.Minute {
		return false
	}
	if len(h.readLogged) > 4096 {
		for key, t := range h.readLogged {
			if now.Sub(t) >= time.Minute {
				delete(h.readLogged, key)
			}
		}
	}
	h.readLogged[k] = now
	return true
}

// requestOrigin is the origin r reached this server on: scheme://host[:port], lower case.
func (h *HubSignin) requestOrigin(r *http.Request) string {
	scheme := "http"
	if h.ks.overHTTPS(r) {
		scheme = "https"
	}
	o, err := CanonicalOrigin(scheme + "://" + r.Host)
	if err != nil {
		return ""
	}
	return o
}

// PageState is the sign-in page's Hub state for r: "" (no Hub UI), "ready", "unpaired" or
// "disabled_in_hub".
func (h *HubSignin) PageState(r *http.Request) string {
	if h == nil || h.team() || (h.operatorAllowed != nil && !h.operatorAllowed()) {
		return ""
	}
	if !h.hub.Linked() {
		return "unpaired"
	}
	if !h.settings.SigninEnabled() {
		return ""
	}
	h.mu.Lock()
	disabled := !h.disabledSeen.IsZero() && h.now().Sub(h.disabledSeen) < hubDisabledShown
	h.mu.Unlock()
	if disabled {
		return "disabled_in_hub"
	}
	if h.hub.Ready(r.Context(), h.requestOrigin(r)) {
		return "ready"
	}
	return ""
}

// HubURL is the checked Coral Hub address for the sign-in page's "Open Coral Hub" link
// (PageState.HubURL), or "" when there is none or it doesn't pass the check.
func (h *HubSignin) HubURL() string {
	if h == nil {
		return ""
	}
	return h.hub.HubPage()
}

// Origins is the whole return-origin list the hub is told: this server's loopback origins
// and the configured ones.
func (h *HubSignin) Origins() []string {
	var out []string
	seen := map[string]bool{}
	add := func(list []string) {
		for _, o := range list {
			if !seen[o] && len(out) < maxHubOrigins {
				seen[o] = true
				out = append(out, o)
			}
		}
	}
	if h.loopbackOrigins != nil {
		add(h.loopbackOrigins())
	}
	add(h.settings.Origins())
	return out
}

func random32() (string, [32]byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", [32]byte{}, err
	}
	s := base64.RawURLEncoding.EncodeToString(b)
	return s, sha256.Sum256([]byte(s)), nil
}

func hubBack(w http.ResponseWriter, r *http.Request, why string) {
	http.Redirect(w, r, "/auth?hub="+why, http.StatusSeeOther)
}

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
