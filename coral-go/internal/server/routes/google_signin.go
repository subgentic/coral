package routes

// Google sign-in routes (#20022, Google Doc share), built like the Dropbox ones (dropbox.go) and to Security's six points on #20008. The Operator's only: the local
// dashboard (refuseCloud with allowDashboard: never through the tunnel, never an agent's token, never another OS user), listed as class b in the agent census and "never"
// in the tunnel table. The browser comes back to a one-shot listener on 127.0.0.1 (googlesignin.ServeCallbackOnce), never to Coral's own listener; the sign-in is bound to
// the browser that started it (a flow cookie), uses PKCE S256 and a state kept as a hash, and a failed exchange changes nothing stored. The refresh token is sealed in the
// store (GoogleStore); the access token is held in memory only. The client (id and secret) is read at run time from the file CORAL_GOOGLE_CLIENT_FILE named when Coral started:
// the path is read from the environment once, there is no setting and no route that changes it (an agent cannot point Coral at another file), and the file's text is never
// echoed. Disconnect revokes at Google (best effort) and forgets the token whatever that did. The scope is drive.file alone.

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/googlesignin"
	"github.com/subgentic/coral/internal/store"
)

// googleClientFileEnv names the file with Google's OAuth client. It is for the preview and the Operator's own test: a shipped Coral has no default (the Operator, 2026-11-20).
const googleClientFileEnv = "CORAL_GOOGLE_CLIENT_FILE"

// ErrGoogleNotConnected is what GoogleAccessToken says when there is no usable sign-in (never connected, disconnected, or it needs to be connected again).
var ErrGoogleNotConnected = errors.New("not signed in to Google: connect it in Settings")

type googleRoutes struct {
	store      *store.GoogleStore
	flows      *googlesignin.Flows
	clientFile string                                                // read from the environment once, at start
	client     func(c googlesignin.ClientCreds) *googlesignin.Client // a test points it at a fake Google
	port       int                                                   // 0 is any free port (Google accepts any loopback port for a desktop client)

	mu      sync.Mutex
	access  string // in memory only
	expires time.Time
}

// SetGoogle attaches the Google sign-in to the handler. The client file's path is read from the environment here, once.
func (h *CloudHandler) SetGoogle(gs *store.GoogleStore) {
	h.ggl = &googleRoutes{store: gs, flows: googlesignin.NewFlows(), clientFile: os.Getenv(googleClientFileEnv), client: googlesignin.NewClient}
}

// creds reads the client file now. Any problem is the one fixed sentence.
func (g *googleRoutes) creds() (googlesignin.ClientCreds, error) {
	return googlesignin.LoadClientFile(g.clientFile)
}

func (h *CloudHandler) googleOrRefuse(w http.ResponseWriter) *googleRoutes {
	if h.ggl == nil {
		writeError(w, http.StatusNotFound, "not_available", "Google sign-in is not available in this build")
	}
	return h.ggl
}

// GoogleStatus answers GET /api/google/status: never a token, never the client's text.
func (h *CloudHandler) GoogleStatus(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) {
		return
	}
	g := h.googleOrRefuse(w)
	if g == nil {
		return
	}
	c, err := g.store.Get(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not read the Google connection")
		return
	}
	_, cerr := g.creds()
	writeJSON(w, http.StatusOK, map[string]any{
		"client_file_set": g.clientFile != "", "client_file_ok": cerr == nil, "connected": c.Connected, "account_id": c.AccountID, "state": c.State,
		"signin_pending": g.flows.Pending(),
	})
}

// GoogleConnect answers POST /api/google/connect: opens the one-shot callback listener, binds a new sign-in to this browser (a flow cookie), and returns the Google URL
// for the browser to open.
func (h *CloudHandler) GoogleConnect(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	g := h.googleOrRefuse(w)
	if g == nil {
		return
	}
	if g.clientFile == "" {
		writeError(w, http.StatusConflict, "no_client", "Google sign-in has no client file set up on this computer")
		return
	}
	creds, err := g.creds()
	if err != nil {
		writeError(w, http.StatusConflict, "bad_client", err.Error()) // the fixed sentence, nothing of the file
		return
	}
	host, port, err := net.SplitHostPort(r.Host) // the flow cookie is the host's the dashboard was opened at, and the callback is on 127.0.0.1
	if err != nil || host != "127.0.0.1" {
		if port == "" {
			port = "8420"
		}
		writeError(w, http.StatusConflict, "open_on_127", "Open Coral at http://127.0.0.1:"+port+" to connect Google")
		return
	}
	binding, err := randomBinding()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not start the sign-in")
		return
	}
	redirect, err := googlesignin.ServeCallbackOnce(g.port, googlesignin.FlowTTL, g.finish)
	if err != nil {
		writeError(w, http.StatusConflict, "signin_busy", "Another Google sign-in is already waiting; finish or wait five minutes")
		return
	}
	u, err := g.flows.Start(creds.ID, redirect, binding)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not start the sign-in")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: googlesignin.FlowCookie, Value: binding, Path: googlesignin.CallbackPath, MaxAge: int(googlesignin.FlowTTL / time.Second), HttpOnly: true, SameSite: http.SameSiteLaxMode})
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"authorize_url": u})
}

// finish handles the browser's return on the one-shot listener; its answer is the text the browser shows. A failure changes nothing stored.
func (g *googleRoutes) finish(res googlesignin.CallbackResult) string {
	const didNotFinish = "Google sign-in didn't finish. Go back to Coral and try again."
	verifier, redirect, ok := g.flows.Take(res.State, res.Binding)
	if !ok || res.Error != "" || res.Code == "" {
		return didNotFinish
	}
	creds, err := g.creds()
	if err != nil {
		return didNotFinish
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := g.client(creds)
	tok, err := cl.Exchange(ctx, res.Code, verifier, redirect)
	if err != nil || tok.Refresh == "" {
		return didNotFinish
	}
	account, err := cl.AccountID(ctx, tok.Access)
	if err != nil {
		return didNotFinish
	}
	old, _ := g.store.RefreshToken(ctx) // the sign-in this one replaces, in memory until the new one is saved
	if err := g.store.Save(ctx, account, tok.Refresh); err != nil {
		return didNotFinish
	}
	g.setAccess(tok.Access, time.Duration(tok.ExpiresIn)*time.Second)
	if old != "" && old != tok.Refresh {
		g.revoke(ctx, old)
	}
	return "Connected. You can close this tab."
}

func (g *googleRoutes) setAccess(token string, ttl time.Duration) {
	g.mu.Lock()
	g.access, g.expires = token, time.Now().Add(ttl)
	g.mu.Unlock()
}

// revoke ends a sign-in at Google and says whether Google answered; it never fails a caller.
func (g *googleRoutes) revoke(ctx context.Context, refresh string) bool {
	creds, err := g.creds()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return g.client(creds).Revoke(ctx, refresh) == nil
}

// GoogleDisconnect answers POST /api/google/disconnect: revokes at Google first (best effort), then forgets the sign-in here whatever the revoke did, and says which.
func (h *CloudHandler) GoogleDisconnect(w http.ResponseWriter, r *http.Request) {
	if h.refuseCloud(w, r, allowDashboard) || !requireJSON(w, r) {
		return
	}
	g := h.googleOrRefuse(w)
	if g == nil {
		return
	}
	revoked := false
	if old, err := g.store.RefreshToken(r.Context()); err == nil && old != "" {
		revoked = g.revoke(r.Context(), old)
	}
	g.mu.Lock()
	g.access, g.expires = "", time.Time{}
	g.mu.Unlock()
	if err := g.store.Disconnect(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "", "could not forget the Google connection")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": false, "revoked": revoked})
}

// GoogleAccessToken is the token source Google Doc share reads (the seam Developer experience named, gdocTokenSource): a fresh access token, held in memory only and
// refreshed from the sealed refresh token a minute before it runs out. A refusal by Google (invalid_grant) moves the sign-in to "reconnect"; any other failure leaves it as it is.
func (h *CloudHandler) GoogleAccessToken(ctx context.Context) (string, error) {
	g := h.ggl
	if g == nil {
		return "", ErrGoogleNotConnected
	}
	g.mu.Lock()
	if g.access != "" && time.Now().Before(g.expires.Add(-time.Minute)) {
		t := g.access
		g.mu.Unlock()
		return t, nil
	}
	g.mu.Unlock()
	refresh, err := g.store.RefreshToken(ctx)
	if err != nil {
		if errors.Is(err, store.ErrNoGoogleConnection) {
			return "", ErrGoogleNotConnected
		}
		return "", errors.New("the Google sign-in could not be read")
	}
	creds, err := g.creds()
	if err != nil {
		return "", err
	}
	access, ttl, err := g.client(creds).Refresh(ctx, refresh)
	if errors.Is(err, googlesignin.ErrInvalidGrant) {
		if serr := g.store.SetState(ctx, store.GoogleStateReconnect); serr != nil {
			slog.Warn("[google] could not record that the sign-in must be made again")
		}
		return "", ErrGoogleNotConnected
	}
	if err != nil {
		return "", err
	}
	g.setAccess(access, ttl)
	return access, nil
}
