package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"strings"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/httputil"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// cloudStatus is the connector status plus the local auto-accept switch.
type cloudStatus struct {
	cloud.Status
	AllowHubAutoAccept bool `json:"allow_hub_auto_accept"`
	// MaxMode is the saved cap (the connector's own max_mode is what the tunnel enforces); MaxModeSaved says the owner chose it (Connect's question, or Settings): an unset cap reads as view, so without this an
	// existing install and a new one look the same, and the Connect screen could not keep what an install has while offering Launch to a new one.
	MaxModeSaved bool `json:"max_mode_saved"`
	// RedactTokens: tokens and private keys are hidden from Coral Hub viewers (#3560).
	RedactTokens bool `json:"redact_tokens"`
	// HubRelaunchUpdates is the local switch "Let Coral Hub relaunch this Coral to install updates" (#5280).
	HubRelaunchUpdates bool `json:"hub_relaunch_updates"`
	// HubRelaunchNeedsHere: on Windows an update installs only when a person at this computer approves it, so the switch above cannot let Coral Hub install; the page says so (#7338).
	HubRelaunchNeedsHere bool `json:"hub_relaunch_needs_here,omitempty"`
	// HubRelaunchAvailable: Coral Hub's relaunch exists in this build (updateRelaunchFeature, false in every shipping build). While it is false the switch above does nothing, and the page draws neither the switch nor its sentence (#7343).
	HubRelaunchAvailable bool `json:"hub_relaunch_available"`
	// HubCrossTeamSettings is the local lock "Let Coral Hub change cross-team settings" (#5572); on, the Coral Hub owner may turn a team's cross-team messaging and file sharing on or off.
	HubCrossTeamSettings bool `json:"hub_cross_team_settings"`
	// AllowHubAutoAcceptChanged is who last changed the auto-accept switch and when ({by: "hub"|"local", user, at}), shown beside it in Settings > Network and Hub (#5840); absent until it was changed.
	AllowHubAutoAcceptChanged json.RawMessage `json:"allow_hub_auto_accept_changed,omitempty"`
	// Bootstrap is the last one-time-credential enrollment's outcome
	// ({status, detail, at}); absent when there was none.
	Bootstrap json.RawMessage `json:"bootstrap,omitempty"`
	// OfferAtLaunch: the dashboard opens its first-launch Connect to Coral Hub
	// screen only when this server was started to offer it (#3459).
	OfferAtLaunch bool `json:"offer_at_launch"`
	// OwnerLabelMissing: this computer is linked to Coral Hub but its enrolment recorded no owner (linked before Coral recorded one), so the owner-only routes refuse the owner through the Hub until it is
	// recorded (Settings > Network and Hub offers to, #6108).
	OwnerLabelMissing bool `json:"owner_label_missing,omitempty"`
	// OwnerKind is what this computer is enrolled as: "personal" (a person's, and every enrolment made before teams) or "team" (a Coral Hub organisation's, #7061). Never the organisation's id.
	OwnerKind string `json:"owner_kind"`
	// OwnerAdoptedAt is when the person at this computer confirmed the owner (RFC 3339); empty when the label came with the enrolment (#6108).
	OwnerAdoptedAt string `json:"owner_adopted_at,omitempty"`
	// SecretKey is present only when the key that seals the Hub token and the remote servers'
	// API keys can't be used (#3698): the dashboard then offers the re-key, listing what it discards.
	SecretKey *store.SecretKeyState `json:"secret_key,omitempty"`
}

func (h *CloudHandler) status() cloudStatus {
	st := cloud.Status{State: cloud.StateOff}
	if m := h.manager(); m != nil {
		st = m.Status()
	}
	allow, redact, relaunch, crossTeam := true, true, true, true
	var boot, changed json.RawMessage
	modeSaved := false
	if s, err := h.ss.GetSettings(context.Background()); err == nil {
		_, modeSaved = tunnel.ParseMode(setreg.Raw(s, MaxModeSetting))
		if v := setreg.Raw(s, setreg.HubAutoAcceptChanged); json.Valid([]byte(v)) {
			changed = json.RawMessage(v)
		}
		allow, redact, relaunch, crossTeam = HubAutoAcceptAllowed(s), HubRedactTokens(s), HubRelaunchAllowed(s), HubCrossTeamAllowed(s)
		if v := setreg.Raw(s, cloud.BootstrapStatusSetting); json.Valid([]byte(v)) {
			boot = json.RawMessage(v)
		}
	}
	out := cloudStatus{Status: st, AllowHubAutoAccept: allow, MaxModeSaved: modeSaved, RedactTokens: redact, HubRelaunchUpdates: relaunch, HubRelaunchNeedsHere: relaunchNeedsLocalApproval, HubRelaunchAvailable: updateRelaunchFeature, HubCrossTeamSettings: crossTeam, AllowHubAutoAcceptChanged: changed, Bootstrap: boot, OfferAtLaunch: h.OfferAtLaunch}
	if missing, known := h.ownerLabelState(context.Background()); known && missing {
		out.OwnerLabelMissing = true
	}
	out.OwnerKind = tunnel.OwnerKindPersonal
	if h.ownerIsTeam(context.Background()) {
		out.OwnerKind = tunnel.OwnerKindTeam
	}
	if h.ownerLabels != nil {
		if at, err := h.ownerLabels.OwnerAdoptedAt(context.Background()); err == nil {
			out.OwnerAdoptedAt = at
		}
	}
	if rs := h.secrets(); rs != nil {
		if ks, err := rs.KeyState(context.Background()); err == nil && ks.State == "refused" {
			out.SecretKey = &ks
		}
	}
	return out
}

// GetStatus: GET /api/cloud/status
func (h *CloudHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) {
		return
	}
	writeJSON(w, http.StatusOK, h.status())
}

// Connect: POST /api/cloud/connect — starts enrollment and returns the user code. The body is optional: {"mode": "view|interact|launch", "allow_auto_accept": bool} is the answer to "What may Coral Hub do on this computer?", saved in this call before the enrollment starts (see decodeConnectAnswer).
func (h *CloudHandler) Connect(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) {
		return
	}
	m := h.manager()
	if m == nil {
		errBadRequest(w, cloud.ErrNotConfigured.Error())
		return
	}
	// The optional answer to "What may Coral Hub do on this computer?" (the dashboard's Connect screen): saved here, before the enrollment starts, in this one call, so nothing is half done. A closed body
	// (unknown fields are refused); nothing is saved when any part is invalid. This route is local only (refuseCloud above), so Coral Hub can never choose its own mode through the tunnel.
	if !m.Status().Configured { // nothing is saved for a server that has no hub to connect to
		errBadRequest(w, cloud.ErrNotConfigured.Error())
		return
	}
	ans, err := decodeConnectAnswer(r)
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	save := context.WithoutCancel(r.Context()) // a page that goes away mid-call must not leave half of the answer saved
	if ans.mode != nil {
		if err := h.applyMaxMode(save, *ans.mode); err != nil {
			errInternalServer(w, err.Error())
			return
		}
	}
	if ans.allowAutoAccept != nil {
		if err := h.applyAllowAutoAccept(save, *ans.allowAutoAccept); err != nil {
			errInternalServer(w, err.Error())
			return
		}
	}
	if err := m.Connect(r.Context()); err != nil {
		if err == cloud.ErrNotConfigured {
			errBadRequest(w, err.Error())
			return
		}
		var rl *cloud.RateLimitedError
		if errors.As(err, &rl) {
			// Coral Hub refused to start an enrollment now: a limit on this action, not this
			// server being busy (#3434).
			httputil.WriteActionLimit(w, int(math.Ceil(rl.RetryAfter.Seconds())), "rate_limited", rl.Error())
			return
		}
		if errors.Is(err, cloud.ErrHubUnavailable) {
			writeError( // Transient (unreachable, or a hub server error): 503, so the CLI says to try again.
				w, http.StatusServiceUnavailable, "", "Could not start enrollment: Coral Hub could not be reached or had an error; try again in a minute")
			return
		}
		errInternalServer(w, "Could not start enrollment; check that the hub is reachable")
		return
	}
	writeJSON(w, http.StatusOK, h.status())
}

// connectAnswer is the decoded optional body of POST /api/cloud/connect.
type connectAnswer struct {
	mode            *tunnel.Mode
	allowAutoAccept *bool
}

// decodeConnectAnswer reads POST /api/cloud/connect's optional body {"mode": "view|interact|launch", "allow_auto_accept": bool}: both fields optional, an empty body or {} is the plain connect the
// command line sends, unknown fields and a second value are refused, and the body is capped at 256 bytes.
func decodeConnectAnswer(r *http.Request) (connectAnswer, error) {
	var out connectAnswer
	var body struct {
		Mode            *string `json:"mode"`
		AllowAutoAccept *bool   `json:"allow_auto_accept"`
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 257))
	if err != nil || len(raw) > 256 {
		return out, errors.New("the body is too large")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		return out, errors.New(`the body is {"mode": "view"|"interact"|"launch", "allow_auto_accept": true|false}, both optional`)
	}
	if dec.More() {
		return out, errors.New("the body must be one JSON object")
	}
	if body.Mode != nil {
		m, ok := tunnel.ParseMode(*body.Mode)
		if !ok {
			return out, errors.New("mode must be view, interact or launch")
		}
		out.mode = &m
	}
	out.allowAutoAccept = body.AllowAutoAccept
	return out, nil
}

// CancelConnect: POST /api/cloud/connect/cancel — stops an enrollment in
// progress (Ctrl-C in `coral cloud connect`); never undoes a connection.
func (h *CloudHandler) CancelConnect(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) {
		return
	}
	if m := h.manager(); m != nil {
		m.CancelEnrollment(r.Context())
	}
	writeJSON(w, http.StatusOK, h.status())
}

// Disconnect: POST /api/cloud/disconnect — forgets the token locally.
func (h *CloudHandler) Disconnect(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) {
		return
	}
	m := h.manager()
	if m == nil {
		errBadRequest(w, cloud.ErrNotConfigured.Error())
		return
	}
	if err := m.Disconnect(r.Context()); err != nil {
		errInternalServer(w, "Could not disconnect")
		return
	}
	writeJSON(w, http.StatusOK, h.status())
}

// LoginToken: POST /api/system/login-token: a fresh single-use dashboard sign-in
// token for `coral open` (#3387). Only the coral CLI on this computer, through its
// HMAC handshake (or the dashboard here).
func (h *CloudHandler) LoginToken(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) {
		return
	}
	h.mu.RLock()
	mint := h.mintLogin
	h.mu.RUnlock()
	if mint == nil {
		errBadRequest(w, "sign-in links are not available")
		return
	}
	token, err := mint()
	if err != nil {
		errInternalServer(w, "could not mint a sign-in link")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"login_token": token, "path": "/?login_token=" + token, "expires_in": int(auth.LoginTokenTTL.Seconds())})
}

// IdentityReport: GET /api/system/identity-report: who called and what strict mode
// would refuse (#3387, phase 1). Only the dashboard on this computer or the coral CLI
// (its HMAC handshake): an agent can't read other sessions' mismatch details.
func (h *CloudHandler) IdentityReport(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) {
		return
	}
	h.mu.RLock()
	o := h.identity
	h.mu.RUnlock()
	if o == nil {
		writeJSON(w, http.StatusOK, map[string]any{"mode": "off"})
		return
	}
	writeJSON(w, http.StatusOK, o.Report())
}

// Redeem: POST /api/cloud/redeem, from `coral cloud connect`. The running
// server redeems, so it stays the only writer of the identity. The command
// reads the credential file itself, as the user who runs it, and sends the
// credential only in the Authorization header and the proof's contents as
// {"proof": {...}}: the server never opens a path a caller names (any local
// user can reach this route). {"check": true}, with no credential, asks only
// whether a bootstrap could proceed, so the command reads nothing when it
// could not; it passes the same gate as a redeem, so it is no oracle for
// another user. Local command line only, as Coral's user with its token; never
// through the tunnel. Answers 200
// {status, detail, exit_code}; status "ready" for a check that may proceed.
func (h *CloudHandler) Redeem(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowCLI) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Check bool            `json:"check"`
		Proof json.RawMessage `json:"proof"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || dec.More() {
		errBadRequest(w, "send only {\"check\": true} or {\"proof\": {...}}; never a file path")
		return
	}
	cred, bearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if bearer == body.Check {
		errBadRequest(w, "send either check or the credential in the Authorization header")
		return
	}
	src := cloud.CredentialSource{Value: []byte(cred)}
	if len(body.Proof) > 0 && string(body.Proof) != "null" {
		src.Proof = body.Proof
	}
	m := h.manager()
	var res cloud.BootstrapResult
	switch {
	case m == nil:
		res = cloud.BootstrapResult{Status: cloud.BootstrapNoHub, Detail: "no Coral Hub is configured (--cloud-url)"}
	case body.Check:
		if res = m.PreCheck(r.Context()); res.Status == cloud.BootstrapNone {
			res.Status = cloud.BootstrapReady
		}
	default:
		hostname, _ := os.Hostname()
		res = m.Redeem(r.Context(), h.ss, hostname, src)
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": res.Status, "detail": res.Detail, "exit_code": cloud.BootstrapExitCode(res.Status)})
}
