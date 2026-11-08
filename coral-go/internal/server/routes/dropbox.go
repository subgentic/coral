package routes

// Dropbox sign-in routes (#14609, Dropbox stage 3a; design v33 §4 and §4b; Security's notes on #14619). The Operator's only: the local dashboard
// (refuseCloud with allowDashboard: never through the tunnel, never an agent's token, never another OS user), listed as class b in the agent census and
// "never" in the tunnel table. The browser comes back to a one-shot listener on 127.0.0.1 (internal/dropbox.ServeCallbackOnce), never to Coral's
// own listener; the sign-in is bound to the browser that started it (a flow cookie), uses only the loopback redirect captured at its start, and a
// failed exchange changes nothing stored. Disconnect revokes at Dropbox first and clears locally whatever happens. A sign-in to a different account than
// the last one is held in memory until the Operator confirms the switch. A data folder whose machine fingerprint is not this computer's "looks like a
// copy" until the Operator takes over.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/dropbox"
	"github.com/subgentic/coral/internal/store"
)

// DropboxDefaultAppKey is the app key a build ships with (set by -ldflags, empty otherwise); CORAL_DROPBOX_APP_KEY overrides it. It is not a secret.
var DropboxDefaultAppKey = ""

// DropboxCallbackPort is the port the one-shot listener uses; the app's registered redirect names it.
const DropboxCallbackPort = 53682

// dropboxRoutes is the Dropbox part of the cloud handler.
type dropboxRoutes struct {
	store     *store.DropboxStore
	flows     *dropbox.Flows
	appKey    func() string
	client    func(appKey string) *dropbox.Client
	machineID func() (string, error)
	dataDir   string
	port      int

	mu      sync.Mutex
	pending *dropboxSwitch // a sign-in to another account, waiting for the Operator's confirm
}

type dropboxSwitch struct {
	account, refresh, fingerprint string
	until                         time.Time
}

const dropboxSwitchTTL = 5 * time.Minute

// SetDropbox attaches the Dropbox sign-in to the handler (the server calls it with the real store; tests with their own client and port).
func (h *CloudHandler) SetDropbox(ds *store.DropboxStore, dataDir string) {
	h.dbx = &dropboxRoutes{
		store: ds, flows: dropbox.NewFlows(), dataDir: dataDir, port: DropboxCallbackPort,
		appKey: func() string {
			if k := os.Getenv("CORAL_DROPBOX_APP_KEY"); k != "" {
				return k
			}
			return DropboxDefaultAppKey
		},
		client:    dropbox.NewClient,
		machineID: dropbox.MachineID,
	}
}

func (d *dropboxRoutes) fingerprint(ctx context.Context) (string, error) {
	id, err := d.machineID()
	if err != nil {
		slog.Warn("[dropbox] this computer's id could not be read; the copy check uses the data folder only")
		id = ""
	}
	return d.store.Fingerprint(ctx, id, d.dataDir)
}

func (d *dropboxRoutes) looksLikeCopy(ctx context.Context) bool {
	id, err := d.machineID()
	if err != nil {
		id = ""
	}
	ok, err := d.store.FingerprintMatches(ctx, id, d.dataDir)
	return err == nil && !ok
}

// DropboxStatus answers GET /api/dropbox/status: never the token.
func (h *CloudHandler) DropboxStatus(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) {
		return
	}
	d := h.dbx
	if d == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	c, err := d.store.Get(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the Dropbox connection")
		return
	}
	out := map[string]any{
		"app_key_set": d.appKey() != "", "connected": c.Connected, "account_id": c.AccountID, "state": c.State,
		"signin_pending": d.flows.Pending(), "looks_like_copy": c.Connected && d.looksLikeCopy(r.Context()),
	}
	d.mu.Lock()
	if p := d.pending; p != nil && time.Now().Before(p.until) {
		out["switch_pending"] = map[string]string{"from": c.LastAccountID, "to": p.account}
	}
	d.mu.Unlock()
	writeJSON(w, http.StatusOK, out)
}

func randomBinding() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// DropboxConnect answers POST /api/dropbox/connect: opens the one-shot callback listener, binds a new sign-in to this browser (a flow cookie), and
// returns the Dropbox URL for the browser to open.
func (h *CloudHandler) DropboxConnect(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	key := d.appKey()
	if key == "" {
		writeError(w, http.StatusConflict, "no_app_key", "This build has no Dropbox app key")
		return
	}
	binding, err := randomBinding()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not start the sign-in")
		return
	}
	redirect, err := dropbox.ServeCallbackOnce(d.port, dropbox.FlowTTL, func(res dropbox.CallbackResult) string { return d.finish(res) })
	if err != nil {
		writeError(w, http.StatusConflict, "signin_busy", "Another Dropbox sign-in is already waiting; finish or wait five minutes")
		return
	}
	u, err := d.flows.Start(key, redirect, binding)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not start the sign-in")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: dropbox.FlowCookie, Value: binding, Path: dropbox.CallbackPath, MaxAge: int(dropbox.FlowTTL / time.Second),
		HttpOnly: true, SameSite: http.SameSiteLaxMode})
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"authorize_url": u})
}

// finish handles the browser's return on the one-shot listener; its answer is the text the browser shows. A failure changes nothing stored.
func (d *dropboxRoutes) finish(res dropbox.CallbackResult) string {
	const didNotFinish = "Dropbox sign-in didn't finish. Go back to Coral and try again."
	verifier, redirect, ok := d.flows.Take(res.State, res.Binding)
	if !ok || res.Error != "" || res.Code == "" {
		return didNotFinish
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tok, err := d.client(d.appKey()).Exchange(ctx, res.Code, verifier, redirect)
	if err != nil || tok.Refresh == "" || tok.AccountID == "" {
		return didNotFinish // an invalid_grant here is a bad or used code: nothing is deleted or marked (Security note c)
	}
	fp, err := d.fingerprint(ctx)
	if err != nil {
		return didNotFinish
	}
	c, err := d.store.Get(ctx)
	if err != nil {
		return didNotFinish
	}
	if c.LastAccountID != "" && c.LastAccountID != tok.AccountID {
		d.mu.Lock()
		d.pending = &dropboxSwitch{account: tok.AccountID, refresh: tok.Refresh, fingerprint: fp, until: time.Now().Add(dropboxSwitchTTL)}
		d.mu.Unlock()
		return "This is a different Dropbox account from before. Go back to Coral to confirm the switch."
	}
	if err := d.store.Save(ctx, tok.AccountID, tok.Refresh, fp); err != nil {
		return didNotFinish
	}
	return "Connected. You can close this tab."
}

// DropboxConfirmSwitch answers POST /api/dropbox/switch: saves the held sign-in to the other account.
func (h *CloudHandler) DropboxConfirmSwitch(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	d.mu.Lock()
	p := d.pending
	d.pending = nil
	d.mu.Unlock()
	if p == nil || time.Now().After(p.until) {
		writeError(w, http.StatusConflict, "no_switch_pending", "No switch to another Dropbox account is waiting")
		return
	}
	if err := d.store.Save(r.Context(), p.account, p.refresh, p.fingerprint); err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not save the Dropbox connection")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": true, "account_id": p.account})
}

// DropboxDisconnect answers POST /api/dropbox/disconnect: revokes at Dropbox first, then forgets the sign-in here whatever the revoke did (Security's
// note on #14618), and says which happened.
func (h *CloudHandler) DropboxDisconnect(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	revoked := false
	if refresh, err := d.store.RefreshToken(r.Context()); err == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		cl := d.client(d.appKey())
		if access, err := cl.Refresh(ctx, refresh); err == nil {
			revoked = cl.Revoke(ctx, access) == nil
		} else if errors.Is(err, dropbox.ErrInvalidGrant) {
			revoked = true // Dropbox already refuses it
		}
		cancel()
	}
	d.mu.Lock()
	d.pending = nil
	d.mu.Unlock()
	if err := d.store.Disconnect(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not forget the Dropbox connection")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": false, "revoked": revoked})
}

// DropboxTakeOver answers POST /api/dropbox/takeover: records this computer as the sign-in's own (the Operator's answer to "looks like a copy").
func (h *CloudHandler) DropboxTakeOver(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	id, err := d.machineID()
	if err != nil {
		id = ""
	}
	if err := d.store.TakeOver(r.Context(), id, d.dataDir); err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not take over")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"looks_like_copy": false})
}
