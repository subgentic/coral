package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/subgentic/coral/internal/auth"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/httputil"
	"github.com/subgentic/coral/internal/peercred"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// CloudHandler serves the "Connect to Coral Hub" settings section.
type CloudHandler struct {
	// OfferAtLaunch is config.OffersCloudConnect (#3459), set by the server.
	OfferAtLaunch bool

	// Hub mode (#3460), set by the server: whether this process runs as a hub, whether
	// --hub or CORAL_HUB=1 forced it, and how to restart, when this process can.
	HubModeRunning bool
	HubModeForced  bool
	Restart        func() error
	// QuitForUpdate, set by the server where a tray or the desktop app supervises it, makes this process quit with UpdateQuitExitCode after the answer is
	// written, so the updater (started just before) has Coral to itself and the supervisor does not start the server again (#166).
	QuitForUpdate func() error
	// stagedUpdate, launchUpdater and installing belong to InstallUpdate (system_update_install.go); the three funcs are nil in production (the staged
	// folder, the updater's own answer to "will you install?" and the Windows updater launch are used) and are set by a test.
	stagedUpdate     func(context.Context) (string, error)
	preflightUpdater func(context.Context) error
	launchUpdater    func(context.Context) error
	installing       int32
	// The terminal backend (#3634), set by the server: the one this run uses, and whether
	// --backend forced it.
	BackendRunning string
	BackendForced  bool

	ss       *store.SessionStore
	identity *IdentityObserver
	// bs holds the record of Operator actions taken through Coral Hub (#3404).
	bs *board.Store
	// mintLogin mints a dashboard sign-in token (#3387).
	mintLogin func() (string, error)

	// cliAuth checks `coral cloud connect`: it proves it knows the 0600 token
	// without sending it (cloud.CLIAuth);
	// empty if it could not be written, which turns the command-line path off.
	cliAuth  *cloud.CLIAuth
	cliToken string
	dataDir  string
	// sameUser tells whether a loopback request comes from Coral's own user
	// (peercred.SameUser; a test seam).
	sameUser func(*http.Request) (same, supported bool)
	// linked overrides whether a Hub link exists (a test seam; nil reads the manager).
	linked func() bool

	// ownerLabels is where the owner's hub-user label is read and recorded (SetOwnerLabelStore, #6108).
	ownerLabels ownerLabelStore
	// connected overrides whether the connector is up to the enrolled hub (a test seam).
	connected func() bool

	mu  sync.RWMutex
	mgr *cloud.Manager
}

// NewCloudHandler creates the handler and writes a fresh command-line token in
// dataDir. The manager is attached later (SetManager) because it needs the
// running server's address.
func NewCloudHandler(ss *store.SessionStore, dataDir string) *CloudHandler {
	h := &CloudHandler{ss: ss, sameUser: peercred.SameUser, dataDir: dataDir}
	tok, err := cloud.WriteCLIToken(dataDir)
	if err != nil {
		slog.Warn("cloud: could not write the command-line token; `coral cloud connect` will be refused", "error", err)
	}
	h.cliAuth = cloud.NewCLIAuth(tok)
	h.cliToken = tok
	return h
}

// Close removes the command-line token this server wrote, at a graceful
// shutdown: a stopped server leaves no token behind (a new one is written at
// every start).
func (h *CloudHandler) Close() {
	h.mu.RLock()
	tok := h.cliToken
	h.mu.RUnlock()
	if err := cloud.RemoveCLIToken(h.dataDir, tok); err != nil {
		slog.Warn("cloud: could not remove the command-line token", "error", err)
	}
}

// RotateCLIToken writes a new command-line token and makes the server use it, after
// `coral reset-password` (#4041): whatever read the old one (an agent, a copy) can no longer
// sign as the Operator. Pending hellos are dropped; each command line reads the new token on
// its next request.
func (h *CloudHandler) RotateCLIToken() {
	tok, err := cloud.WriteCLIToken(h.dataDir)
	if err != nil {
		// Fail closed: an old token that may be known must not keep signing.
		slog.Warn("cloud: could not write a new command-line token after a password reset; the command line is off until Coral restarts", "error", err)
		tok = ""
	}
	h.cliAuth.Rotate(tok)
	h.mu.Lock()
	h.cliToken = tok
	h.mu.Unlock()
	slog.Info("cloud: the command-line token was replaced after a password reset")
}

// SetPeerCheck replaces the same-user check (tests).
// SetPeerCheck has no production caller: it is exported for the cloud-gate, hook and hub end-to-end tests in internal/server.
func (h *CloudHandler) SetPeerCheck(f func(*http.Request) (same, supported bool)) { h.sameUser = f }

// SetManager attaches the connector manager.
func (h *CloudHandler) SetManager(m *cloud.Manager) {
	h.mu.Lock()
	h.mgr = m
	h.mu.Unlock()
}

func (h *CloudHandler) manager() *cloud.Manager {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.mgr
}

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

// secrets is the store of the key that seals the Hub token and the remote servers' API keys.
func (h *CloudHandler) secrets() *store.RemoteServerStore {
	if h.ss == nil {
		return nil
	}
	return store.NewRemoteServerStore(h.ss.DB(), h.dataDir)
}

// Rekey replaces a secret key Coral refuses (for example one other accounts could read) with a
// new one, discarding what the old one sealed: the Coral Hub enrollment (the tunnel stops first)
// and the remote servers' API keys, which must be entered again (#3698). It is the Operator's,
// on this computer only (never through Coral Hub), and needs {"confirm": true}. A usable key is
// never replaced (409).
// POST /api/cloud/rekey
func (h *CloudHandler) Rekey(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard|allowCLI) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Confirm bool `json:"confirm"`
	}
	if err := decodeJSONLimit(r, &body, 4096); err != nil || !body.Confirm {
		errBadRequest(w, `re-keying discards the Coral Hub connection and the remote servers' API keys: send {"confirm": true}`)
		return
	}
	rs := h.secrets()
	if rs == nil {
		errInternalServer(w, "no store")
		return
	}
	ks, err := rs.KeyState(r.Context())
	if err != nil {
		errInternalServer(w, "could not read the secret key's state")
		return
	}
	switch ks.State {
	case "refused":
	case "unreadable": // an I/O or access error, not a refusal of the key: no re-key (#3698)
		writeJSON(w, http.StatusConflict, map[string]any{"error": store.ErrKeyNotRefused.Error() + ": " + ks.Message, "code": "key_unreadable", "state": ks.State})
		return
	default:
		writeJSON(w, http.StatusConflict, map[string]any{"error": store.ErrRekeyNotNeeded.Error(), "code": "rekey_not_needed", "state": ks.State})
		return
	}
	if m := h.manager(); m != nil {
		if err := m.Disconnect(r.Context()); err != nil && !errors.Is(err, cloud.ErrNotConfigured) {
			errInternalServer(w, "could not stop the Coral Hub connection")
			return
		}
	}
	if err := rs.Rekey(r.Context()); err != nil {
		if errors.Is(err, store.ErrRekeyNotNeeded) {
			writeError(w, http.StatusConflict, "rekey_not_needed", err.Error())
			return
		}
		if errors.Is(err, store.ErrKeyNotRefused) {
			writeError( // it changed between the check and the re-key
				w, http.StatusConflict, "key_unreadable", err.Error())
			return
		}
		errInternalServer(w, "re-key failed: "+err.Error())
		return
	}
	slog.Info("secret key replaced by a re-key; the Coral Hub enrollment and remote API keys were discarded",
		"remote_server_keys", ks.RemoteServerKeys, "had_hub_enrollment", ks.HubURL != "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "discarded_remote_server_keys": ks.RemoteServerKeys,
		"discarded_hub_enrollment": ks.HubURL != "", "status": h.status()})
}

// Who may use the /api/cloud routes. Never the Cloud Hub (they are not in the
// tunnel table, and a tunneled request is refused here too).
const (
	allowDashboard = 1 << iota // the positively identified local dashboard
	allowCLI                   // `coral cloud connect`: a loopback command-line request with the token
)

// refuseCloud admits only someone using Coral on this computer, as Coral's own
// user. On Linux, macOS and Windows the kernel names the user behind a loopback
// socket (peercred): another user (or a pod sidecar running as another uid) is
// refused whatever it sends,
// before any other rule, since browser headers can be forged with curl. Then
// either the dashboard (loopback peer, localhost Host, same-origin browser
// fetch, no tunnel stamp, no Bearer credential) or the command line with the
// 0600 token from Coral's data folder, as allowed.
func (h *CloudHandler) refuseCloud(w http.ResponseWriter, r *http.Request, allow int) bool {
	if cloud.Tunneled(r) {
		errForbidden(w, "Cloud connector settings are only available on this computer")
		return true
	}
	if same, supported := h.sameUser(r); supported && !same {
		writeError(w, http.StatusForbidden, "other_user", "Cloud connector settings are only available to the user Coral runs as")
		return true
	}
	if allow&allowDashboard != 0 && r.Header.Get(cloud.CLIAuthHeader) == "" && localDashboard(r) {
		return false
	}
	if allow&allowCLI != 0 && cliauth.Verified(r) {
		return false // strict local auth checked the signature already (#3418)
	}
	if allow&allowCLI != 0 && r.Header.Get(cloud.CLIAuthHeader) != "" && localCLI(r) {
		// The MAC covers the body, so read it here and give the handler a copy. A body that could not be read to the end is refused: what was read is not put back for any later check or handler.
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) { // over the limit is the size's answer, as in identity_keys.go; only a read that failed is unreadable
				writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", "This request's body is over the limit")
				return true
			}
			refuseUnreadableBody(w)
			return true
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		if h.cliAuth.Verify(r, body) {
			return false
		}
	}
	if allow&allowDashboard != 0 {
		// The Settings screen shows this as is, with a copy button for the command
		// (#3285): connecting is for someone at this computer, never a remote browser.
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error":   "Connecting has to happen on the computer running Coral. On that computer, open this dashboard, or run: coral cloud connect",
			"code":    "local_dashboard_required",
			"command": "coral cloud connect",
		})
	} else {
		errForbidden(w, "Only `coral cloud connect`, run as the user Coral runs as on this computer, can do this")
	}
	return true
}

// CLIHello: POST /api/cloud/cli-hello {"nonce": c}, step 1 of the command
// line's handshake (cloud.CLIAuth): the server proves it knows the token. Only a
// loopback command-line request as Coral's user, never through the tunnel.
func (h *CloudHandler) CLIHello(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) {
		errForbidden(w, "Cloud connector settings are only available on this computer")
		return
	}
	if same, supported := h.sameUser(r); supported && !same {
		writeError(w, http.StatusForbidden, "other_user", "Cloud connector settings are only available to the user Coral runs as")
		return
	}
	if !localCLI(r) {
		errForbidden(w, "Only `coral cloud connect`, run on this computer, can do this")
		return
	}
	if !requireJSON(w, r) {
		return
	}
	var body struct {
		Nonce string `json:"nonce"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "nonce is required")
		return
	}
	// Only a direct local peer gets here (localCLI), so every hello is one caller: a program
	// can't get a bucket per loopback address and fill the pending table (#4041).
	sn, proof, err := h.cliAuth.HelloFrom("local", body.Nonce)
	if errors.Is(err, cliauth.ErrHelloLimit) {
		httputil.WriteActionLimit(w, 1, "cli_hello_limit", err.Error())
		return
	}
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"nonce": sn, "proof": proof})
}

// requireJSON makes state-changing calls non-"simple" cross-site requests, so a web
// page in the user's browser cannot toggle connector settings without a CORS preflight.
func requireJSON(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		errBadRequest(w, "Content-Type must be application/json")
		return false
	}
	return true
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

// VerifyCLI checks a command-line signature for strict local auth (#3418): a loopback
// request without browser headers, from Coral's own user, signed with the command-line
// token. It uses up the nonce and returns the request marked cliauth.Verified, with its
// body restored, so the cloud routes accept it without checking again.
func (h *CloudHandler) VerifyCLI(r *http.Request) (*http.Request, bool) {
	if r.Header.Get(cloud.CLIAuthHeader) == "" || !localCLI(r) {
		return r, false
	}
	if h.OtherUser(r) {
		return r, false
	}
	var body []byte
	if r.Body != nil && r.Body != http.NoBody {
		b, err := io.ReadAll(io.LimitReader(r.Body, cliSignedBodyMax+1))
		r.Body.Close()
		if err != nil || len(b) > cliSignedBodyMax {
			return r, false
		}
		body = b
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	if !h.cliAuth.Verify(r, body) {
		return r, false
	}
	return cliauth.WithVerified(r), true
}

// SameUser is the peer-user check (#3949): whether a loopback request comes from Coral's own OS
// user, and whether the system can tell at all.
func (h *CloudHandler) SameUser(r *http.Request) (same, supported bool) { return h.sameUser(r) }

// OtherUser reports whether a loopback request comes from another OS user (where the
// system can tell, peercred): such a caller is refused with code other_user.
func (h *CloudHandler) OtherUser(r *http.Request) bool {
	same, supported := h.sameUser(r)
	return supported && !same
}

// cliSignedBodyMax matches the command-line transport's limit (an artifact upload).
const cliSignedBodyMax = 32 << 20

// SetLinkedCheck replaces how the handler tells whether a Hub link exists (tests that
// run a tunnel without enrolling with a hub).
// SetLinkedCheck has no production caller: it is exported for the hub end-to-end tests in internal/server.
func (h *CloudHandler) SetLinkedCheck(fn func() bool) { h.linked = fn }

// SetBoardStore gives the handler the board store, for the recent Operator actions
// taken through Coral Hub (#3404).
func (h *CloudHandler) SetBoardStore(bs *board.Store) { h.bs = bs }

// SetLoginMinter gives the handler the dashboard login-token minter (#3387).
func (h *CloudHandler) SetLoginMinter(fn func() (string, error)) {
	h.mu.Lock()
	h.mintLogin = fn
	h.mu.Unlock()
}

// SetConnectedCheck replaces the answer to "is the connector up to the hub this computer was linked to" (tests, #6108).
// SetConnectedCheck has no production caller: it is exported for the hub owner-label test in internal/server.
func (h *CloudHandler) SetConnectedCheck(f func() bool) { h.connected = f }

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

// SetIdentityObserver gives the handler the identity observer for its report (#3387).
func (h *CloudHandler) SetIdentityObserver(o *IdentityObserver) {
	h.mu.Lock()
	h.identity = o
	h.mu.Unlock()
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

// localCLI admits only a command-line client on this computer: a loopback peer
// with a localhost Host, no tunnel stamp (any value), and nothing a browser
// sends (Origin, Referer, fetch metadata), so neither the Cloud Hub, another
// machine nor a web page can reach it.
func localCLI(r *http.Request) bool {
	if viaTunnel(r) || r.Header.Get("Origin") != "" || r.Header.Get("Referer") != "" || r.Header.Get("Sec-Fetch-Site") != "" {
		return false
	}
	// A direct local peer only (#3585): a request a local proxy forwarded is not the command line
	// on this computer. The require_auth_on_loopback clause is intentionally NOT applied here --
	// the signed handshakes signature is the credential, so the setting is already satisfied and
	// must not block `coral cloud connect`.
	if !auth.IsDirectLocalPeer(r) {
		return false
	}
	return localHostOK(r.Host)
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
