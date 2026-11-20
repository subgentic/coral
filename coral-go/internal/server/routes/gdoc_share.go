package routes

import (
	"context"
	"errors"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/gdocsync"
	setreg "github.com/subgentic/coral/internal/settings"
)

// gdocAccount is the keychain item the sign-in helper wrote (scope drive.file).
const gdocAccount = "file"

// GdocTokenSource gives a fresh Google access token for the one sign-in. It is the only place the share code gets a token from: the preview reads the keychain item
// (account "file", drive.file); the sealed in-app sign-in (Backend Dev) replaces gdocTokenSource without a change to the share code. A token is never kept in a field of ours.
type GdocTokenSource func() (string, error)

var gdocTokenSource GdocTokenSource = gdocsync.KeychainTokenFunc(gdocAccount)

// gdocClientFor makes the Drive and Docs client from the token source; a test replaces it with one that talks to a stand-in.
var gdocClientFor = func() (*gdocsync.Client, error) {
	return gdocsync.NewClient(gdocTokenSource), nil
}

// gdocMac says whether this computer can keep the sign-in (the macOS keychain): elsewhere the feature is unavailable. A test changes it.
var gdocMac = func() bool { return runtime.GOOS == "darwin" }

const gdocMaxMarkdown = 1 << 20

// GdocShareOffMessage is the plain refusal of any Google Doc route while the switch is off (#19996): it names the setting, so the person knows where to turn it on.
const GdocShareOffMessage = "Sharing to Google Docs is turned off. Turn on \"Share to Google (experimental)\" in Settings to use it."

// gdocShareOn reads the switch; an unreadable store counts as off.
func (h *SessionsHandler) gdocShareOn(r *http.Request) bool {
	st, err := h.ss.GetSettings(r.Context())
	return err == nil && setreg.Bool(st, setreg.GdocShare)
}

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
	r.Get("/api/gdoc/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": h.gdocShareOn(r)})
	})
	r.With(h.requireGdocShare).Post("/api/artifacts/{id}/gdoc/share", h.shareToGdoc)
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
	gdocLinksMu.Lock()
	defer gdocLinksMu.Unlock()
	links, err := h.loadGdocLinks()
	if err != nil {
		errInternalServer(w, "could not read the list of shared files")
		return
	}
	title := meta.Name
	if title == "" {
		title = "Coral artifact"
	}
	link, shared := links[key]
	patched := 0
	if shared {
		if patched, err = c.Patch(ctx, link.DocID, string(md)); err != nil {
			h.gdocFail(w, err)
			return
		}
	} else {
		docID, err := c.Push(ctx, title, string(md))
		if err != nil {
			h.gdocFail(w, err)
			return
		}
		link = gdocLink{DocID: docID, Name: title}
	}
	link.Digest = id
	links[key] = link
	if err := h.saveGdocLinks(links); err != nil {
		errInternalServer(w, "the Doc was updated but the link to it could not be saved")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"doc_id": link.DocID, "url": "https://docs.google.com/document/d/" + link.DocID + "/edit", "created": !shared, "requests": patched})
}

// gdocFail answers a failed Google call in plain words; the error text never reaches the answer (it could carry a body), only the kind.
func (h *SessionsHandler) gdocFail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, gdocsync.ErrDocChanged):
		writeError(w, http.StatusConflict, "gdoc_changed", "The Doc was edited while the update was prepared. Nothing was changed; share again.")
	case errors.Is(err, gdocsync.ErrOutcomeUnknown):
		writeError(w, http.StatusBadGateway, "gdoc_unknown", "Google did not confirm the change. Look at the Doc before sharing again.")
	default:
		writeError(w, http.StatusBadGateway, "gdoc_failed", "Google Docs did not accept the request. Check the sign-in (run the gdoc-login helper) and try again.")
	}
}
