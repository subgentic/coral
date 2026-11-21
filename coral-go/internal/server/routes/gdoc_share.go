package routes

import (
	"context"
	"errors"
	"io"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/gdocsync"
	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

// GdocTokenSource gives a fresh Google access token for the one sign-in. It is the only place the share code gets a token from. The server sets it to the sealed in-app
// sign-in (WireGdocGoogle, #20212); until then there is no sign-in. A token is never kept in a field of ours.
type GdocTokenSource func() (string, error)

var gdocTokenSource GdocTokenSource = func() (string, error) { return "", ErrGoogleNotConnected }

// WireGdocGoogle makes the sealed in-app Google sign-in (Settings, #20022) the token source of Google Doc share, and what "connected" means. The macOS keychain reader is
// not a fallback: a sign-in that is not the sealed one is not used (#20212).
func WireGdocGoogle(h *CloudHandler) {
	gdocTokenSource = func() (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return h.GoogleAccessToken(ctx)
	}
	gdocConnected = func() bool {
		if h.ggl == nil {
			return false
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		c, err := h.ggl.store.Get(ctx)
		return err == nil && c.Connected && c.State == store.GoogleStateConnected
	}
}

// gdocClientFor makes the Drive and Docs client from the token source; a test replaces it with one that talks to a stand-in.
var gdocClientFor = func() (*gdocsync.Client, error) {
	return gdocsync.NewClient(gdocTokenSource), nil
}

// gdocMac says whether this computer can keep the sign-in (a Mac for now): elsewhere the feature is unavailable. A test changes it.
var gdocMac = func() bool { return runtime.GOOS == "darwin" }

// gdocShareMu serialises shares, so two presses cannot make two Docs for one file.
var gdocShareMu sync.Mutex

const gdocMaxMarkdown = 1 << 20

// GdocShareOffMessage is the plain refusal of any Google Doc route while the switch is off (#19996): it names the setting, so the person knows where to turn it on.
const GdocShareOffMessage = "Sharing to Google Docs is turned off. Turn on \"Share to Google (experimental)\" in Settings to use it."

// gdocShareOn reads the switch; an unreadable store counts as off.
func (h *SessionsHandler) gdocShareOn(r *http.Request) bool {
	st, err := h.ss.GetSettings(r.Context())
	return err == nil && gdocSwitchOn(st)
}

func gdocSwitchOn(settings map[string]string) bool { return setreg.Bool(settings, setreg.GdocShare) }

// requireGdocShare refuses a request while the switch is off, before anything is read or written.
func (h *SessionsHandler) requireGdocShare(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.gdocShareOn(r) {
			writeError(w, http.StatusForbidden, "gdoc_share_off", GdocShareOffMessage)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RegisterGdocShare adds the Google Doc share routes (#19996). The status route answers either way; the rest sit behind the switch.
func (h *SessionsHandler) RegisterGdocShare(r chi.Router) {
	r.Get("/api/gdoc/status", h.gdocStatus)
	r.With(h.requireGdocShare).Post("/api/artifacts/{id}/gdoc/share", h.shareToGdoc)
	r.With(h.requireGdocShare).Delete("/api/artifacts/{id}/gdoc/share", h.unshareGdoc)
	r.With(h.requireGdocShare).Post("/api/artifacts/{id}/gdoc/sync", h.pauseGdoc)
}

// gdocConnected says whether the sealed Google sign-in is kept on this computer (no network call, nothing read out); WireGdocGoogle sets it, a test replaces it.
var gdocConnected = func() bool { return false }

// gdocStatus: GET /api/gdoc/status[?id=<artifact>]. Whether the switch is on and a sign-in is kept here, and, for the Operator alone and an artifact asked about, whether it is shared
// and the address of its Doc. An agent's call gets neither: no agent learns which Doc a file is in.
func (h *SessionsHandler) gdocStatus(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"enabled": h.gdocShareOn(r)}
	if out["enabled"] == true && !isAgentCaller(r) { // an agent's call never touches the sign-in and is told nothing about the sign-in or a Doc
		out["connected"] = gdocMac() && gdocConnected()
		if id := r.URL.Query().Get("id"); id != "" && validArtifactID(id) {
			key := id
			if sid, _, in := callerSeries(r, h.cfg.CoralDir(), id); in {
				key = sid
			}
			if g, err := h.ss.GetGdocShare(r.Context(), key); err == nil && g != nil {
				out["shared"] = true
				out["url"] = gdocURL(g.DocID)
				out["paused"] = g.State == store.GdocSharePaused
				if g.ConflictDoc != "" {
					out["kept_url"] = gdocURL(g.ConflictDoc) // the earlier Doc that still has the edits made in Google
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// shareToGdoc: POST /api/artifacts/{id}/gdoc/share (the owner's; flag-gated). The first share makes a Google Doc from the artifact's Markdown; sharing a later version of the same
// series changes only the ranges that differ in the same Doc. Nothing the person wrote is lost: a Doc edited meanwhile is refused (409), not overwritten.
func (h *SessionsHandler) shareToGdoc(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if !validArtifactID(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	if !gdocMac() {
		writeError(w, http.StatusNotImplemented, "gdoc_unavailable", "Sharing to Google Docs works on a Mac only for now.")
		return
	}
	f, meta, _, ok := h.openArtifactForRead(w, r, id, false)
	if !ok {
		return
	}
	defer f.Close()
	if !strings.HasPrefix(meta.MediaType, "text/markdown") && !strings.HasSuffix(strings.ToLower(meta.Name), ".md") {
		errBadRequest(w, "Only a Markdown file can be shared to a Google Doc.")
		return
	}
	md, err := io.ReadAll(io.LimitReader(f, gdocMaxMarkdown+1))
	if err != nil {
		errInternalServer(w, "could not read the artifact")
		return
	}
	if len(md) > gdocMaxMarkdown {
		errBadRequest(w, "This file is too large to share to a Google Doc (1 MB at most).")
		return
	}
	key := id
	if sid, _, in := callerSeries(r, h.cfg.CoralDir(), id); in {
		key = sid
	}
	c, err := gdocClientFor()
	if err != nil {
		errInternalServer(w, "Google Docs is not set up")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if _, err := c.TokenFunc(); err != nil { // the token read (and a refresh) happens before the lock, so a slow one blocks no other share
		writeError(w, http.StatusBadGateway, "gdoc_failed", "Google Docs is not signed in on this computer. Sign in and try again.")
		return
	}
	title := meta.Name
	if title == "" {
		title = "Coral artifact"
	}
	res, err := h.pushGdoc(ctx, c, key, md, id, title, false)
	if err != nil {
		h.gdocFail(w, err)
		return
	}
	out := map[string]any{"doc_id": res.DocID, "url": gdocURL(res.DocID), "created": res.Created, "requests": res.Requests}
	if res.Kept != "" {
		out["kept_url"] = gdocURL(res.Kept) // the Doc that still has the person's edits
	}
	writeJSON(w, http.StatusOK, out)
}

// gdocKey is the share's key for an artifact: its series id, or its digest when it has no series.
func (h *SessionsHandler) gdocKey(r *http.Request, id string) string {
	if sid, _, in := callerSeries(r, h.cfg.CoralDir(), id); in {
		return sid
	}
	return id
}

// unshareGdoc: DELETE /api/artifacts/{id}/gdoc/share (the owner's). Coral forgets the Doc and stops syncing it; the Doc stays in Google, as it is.
func (h *SessionsHandler) unshareGdoc(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if !validArtifactID(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	gdocShareMu.Lock()
	defer gdocShareMu.Unlock()
	ok, err := h.ss.DeleteGdocShare(r.Context(), h.gdocKey(r, id))
	if err != nil {
		errInternalServer(w, "could not stop sharing")
		return
	}
	if !ok {
		errNotFound(w, "This file is not shared to a Google Doc.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"unshared": true})
}

// pauseGdoc: POST /api/artifacts/{id}/gdoc/sync {"paused": true|false} (the owner's): a paused Doc is not synced by the loop, and a press of Share is refused, until it is resumed.
func (h *SessionsHandler) pauseGdoc(w http.ResponseWriter, r *http.Request) {
	if refuseNonOwner(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if !validArtifactID(id) {
		errBadRequest(w, "invalid artifact id")
		return
	}
	var body struct {
		Paused bool `json:"paused"`
	}
	if err := decodeJSON(r, &body); err != nil {
		errBadRequest(w, "invalid JSON")
		return
	}
	state := store.GdocShareLive
	if body.Paused {
		state = store.GdocSharePaused
	}
	gdocShareMu.Lock()
	defer gdocShareMu.Unlock()
	ok, err := h.ss.SetGdocShareState(r.Context(), h.gdocKey(r, id), state)
	if err != nil {
		errInternalServer(w, "could not change the sync")
		return
	}
	if !ok {
		errNotFound(w, "This file is not shared to a Google Doc.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"paused": body.Paused})
}

// gdocFail answers a failed Google call in plain words; the error text never reaches the answer (it could carry a body), only the kind.
func (h *SessionsHandler) gdocFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errGdocRate):
		writeError(w, http.StatusTooManyRequests, "gdoc_rate", "This Doc was changed 20 times in the last hour. Try again later.")
	case errors.Is(err, errGdocPaused):
		writeError(w, http.StatusConflict, "gdoc_paused", "Syncing this Doc is paused. Resume it to share again.")
	case errors.Is(err, errGdocBusy):
		writeError(w, http.StatusConflict, "gdoc_busy", "This file is being sent already. Wait a moment and look at the Doc.")
	case errors.Is(err, errGdocRedact):
		writeError(w, http.StatusInternalServerError, "gdoc_redact", "The file could not be checked for secrets, so nothing was sent.")
	case errors.Is(err, gdocsync.ErrDocChanged):
		writeError(w, http.StatusConflict, "gdoc_changed", "The Doc was edited while the update was prepared. Nothing was changed; share again.")
	case errors.Is(err, gdocsync.ErrOutcomeUnknown):
		writeError(w, http.StatusBadGateway, "gdoc_unknown", "Google did not confirm the change. Look at the Doc before sharing again.")
	default:
		writeError(w, http.StatusBadGateway, "gdoc_failed", "Google Docs did not accept the request. Check the sign-in (run the gdoc-login helper) and try again.")
	}
}
