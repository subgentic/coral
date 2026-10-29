package routes

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cliauth"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/peercred"
	"github.com/subgentic/coral/internal/store"
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
	installedVersion func() string // the running version (config.Version unless a test says otherwise)
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

// requireJSON makes state-changing calls non-"simple" cross-site requests, so a web
// page in the user's browser cannot toggle connector settings without a CORS preflight.
func requireJSON(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		errBadRequest(w, "Content-Type must be application/json")
		return false
	}
	return true
}

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

// SetIdentityObserver gives the handler the identity observer for its report (#3387).
func (h *CloudHandler) SetIdentityObserver(o *IdentityObserver) {
	h.mu.Lock()
	h.identity = o
	h.mu.Unlock()
}
