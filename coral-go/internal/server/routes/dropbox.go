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
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
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
	save      func(ctx context.Context, account, refresh, fingerprint string) error // the store's Save; a test makes it fail
	dataDir   string
	port      int

	mu      sync.Mutex
	pending *dropboxSwitch // a sign-in to another account, waiting for the Operator's confirm

	outbox *store.DropboxOutbox // the backup's queue (stage 4), set by NewDropboxBackup; nil before
	backup *DropboxBackup       // the worker, for Check again; nil before NewDropboxBackup
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
		save:      ds.Save,
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
	if types, days, err := d.store.Filters(r.Context()); err == nil {
		if types == nil {
			types = []string{}
		}
		out["filters"] = map[string]any{"types": types, "max_age_days": days}
	}
	if d.outbox != nil {
		if counts, err := d.outbox.Counts(r.Context()); err == nil {
			out["backup"] = counts // counts and the last sync only: no names or paths
		}
	}
	if days, _, err := d.store.Retention(r.Context()); err == nil {
		ret := map[string]any{"days": days}
		if c, err := d.store.Get(r.Context()); err == nil && days > 0 && d.outbox != nil && c.AccountID != "" {
			if n, err := d.outbox.LedgerSize(r.Context(), c.AccountID); err == nil && n < 4 {
				// Half the ledger, in whole pairs (a version and its sidecar): retention starts once at least 2 artifacts are backed up (Security's point 7).
				ret["waiting_for_files"] = true
			}
		}
		out["retention"] = ret
	}
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
	// The flow cookie is the host's the dashboard was opened at, and the browser returns it only to that host: the callback is on 127.0.0.1, so the
	// dashboard must be too (Security's note 4 on #14638).
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil || host != "127.0.0.1" {
		if port == "" {
			port = "8420"
		}
		writeError(w, http.StatusConflict, "open_on_127", "Open Coral at http://127.0.0.1:"+port+" to connect Dropbox")
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
	old := d.storedRefresh(ctx) // the sign-in this one replaces, kept in memory until the new one is saved
	if err := d.save(ctx, tok.AccountID, tok.Refresh, fp); err != nil {
		return didNotFinish
	}
	if old != "" && old != tok.Refresh { // the same token again is the new sign-in itself: never revoked (Security's SHOULDs a and b on #14640)
		d.revokeRefresh(ctx, old)
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
	old := d.storedRefresh(r.Context()) // the old account's sign-in, kept in memory: the new one is saved first, then the old one revoked, best effort
	if err := d.save(r.Context(), p.account, p.refresh, p.fingerprint); err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not save the Dropbox connection")
		return
	}
	oldRevoked := old != "" && old != p.refresh && d.revokeRefresh(r.Context(), old)
	writeJSON(w, http.StatusOK, map[string]any{"connected": true, "account_id": p.account, "old_revoked": oldRevoked})
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
	if old := d.storedRefresh(r.Context()); old != "" {
		revoked = d.revokeRefresh(r.Context(), old)
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

// storedRefresh is the stored sign-in's refresh token, or "" when there is none (or it cannot be read). Kept in a local variable only.
func (d *dropboxRoutes) storedRefresh(ctx context.Context) string {
	refresh, err := d.store.RefreshToken(ctx)
	if err != nil {
		return ""
	}
	return refresh
}

// revokeRefresh ends the sign-in whose refresh token is refresh at Dropbox, and reports whether Dropbox no longer accepts it (revoked now, or
// refused already). It never fails a caller: a revoke that cannot be done is reported as false.
func (d *dropboxRoutes) revokeRefresh(ctx context.Context, refresh string) bool {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cl := d.client(d.appKey())
	access, err := cl.Refresh(ctx, refresh)
	if errors.Is(err, dropbox.ErrInvalidGrant) {
		return true // Dropbox already refuses it
	}
	if err != nil {
		return false
	}
	return cl.Revoke(ctx, access) == nil
}

// DropboxSetFilters answers PUT /api/dropbox/filters {"types": [...], "max_age_days": n}: the Operator's choice of what to back up (stage 4, #14655).
// Types only from the closed extension map; narrowing never deletes anything already in Dropbox.
func (h *CloudHandler) DropboxSetFilters(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	var in struct {
		Types      []string `json:"types"`
		MaxAgeDays int      `json:"max_age_days"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		errBadRequest(w, "a filter is {\"types\": [...], \"max_age_days\": n}")
		return
	}
	known := map[string]bool{}
	for _, e := range dropboxExt {
		known[e] = true
	}
	seen := map[string]bool{}
	var types []string
	for _, t := range in.Types {
		t = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(t), "."))
		if !known[t] {
			errBadRequest(w, "not a type Dropbox backup knows")
			return
		}
		if !seen[t] {
			seen[t] = true
			types = append(types, t)
		}
	}
	if in.MaxAgeDays < 0 || in.MaxAgeDays > 3650 {
		errBadRequest(w, "max_age_days is 0 (no limit) to 3650")
		return
	}
	if err := d.store.SetFilters(r.Context(), types, in.MaxAgeDays); err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not save the filters")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"types": types, "max_age_days": in.MaxAgeDays})
}

// DropboxCheckAgain answers POST /api/dropbox/check: the Operator's Check again (after freeing space in Dropbox) asks the worker for a pass now.
func (h *CloudHandler) DropboxCheckAgain(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	if h.dbx == nil || h.dbx.backup == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	h.dbx.backup.Nudge()
	writeJSON(w, http.StatusAccepted, map[string]any{"checking": true})
}

// DropboxSetRetention answers PUT /api/dropbox/retention (stage 4b, #14703): the Operator's "Keep in Dropbox for N days", on this computer only.
// {days: 0} turns it off. Without confirm it is a dry run: what the next pass would delete at that N, nothing saved. With confirm it is saved, and
// the audit row records the dry-run count and bytes the page showed (seen_count, seen_bytes: recorded only, never trusted).
func (h *CloudHandler) DropboxSetRetention(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	d := h.dbx
	if d == nil || d.backup == nil {
		writeError(w, http.StatusNotFound, "not_available", "Dropbox backup is not available in this build")
		return
	}
	var in struct {
		Days      int   `json:"days"`
		Confirm   bool  `json:"confirm"`
		SeenCount int   `json:"seen_count"`
		SeenBytes int64 `json:"seen_bytes"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		errBadRequest(w, "retention is {\"days\": n, \"confirm\": true|false}")
		return
	}
	if in.Days < 0 || in.Days > 3650 {
		errBadRequest(w, "days is 0 (off) to 3650")
		return
	}
	ctx := r.Context()
	old, _, err := d.store.Retention(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the retention setting")
		return
	}
	if in.Days > 0 && !in.Confirm {
		count, bytes, held, ledger, err := d.backup.RetentionPreview(ctx, in.Days)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "", "could not count what retention would delete")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"dry_run": true, "days": in.Days, "due": count, "bytes": bytes, "held": held, "ledger": ledger})
		return
	}
	if in.Days > 0 {
		if c, err := d.store.Get(ctx); err != nil || !c.Connected {
			writeError(w, http.StatusConflict, "not_connected", "Connect Dropbox first")
			return
		}
	}
	if err := d.store.SetRetention(ctx, in.Days); err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not save the retention setting")
		return
	}
	a := store.DropboxAudit{Kind: store.DropboxAuditSetting, Who: "operator", OldDays: old, NewDays: in.Days}
	if in.Days > 0 {
		a.Count, a.Bytes = max(in.SeenCount, 0), max(in.SeenBytes, 0)
	}
	_ = d.store.AddAudit(ctx, a)
	writeJSON(w, http.StatusOK, map[string]any{"days": in.Days})
}
