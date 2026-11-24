package routes

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/store"
)

// A self-hosted Hub's request key (#20944, design #20901). Made, listed and revoked only by the person at this computer (the dashboard, or the signed command line, which is also how a Hub over SSH makes one: `coral cloud keys
// create <name>`); never tunneled, never an agent's, never a key's. The key is in the response to the make and nowhere else.
//
//	POST   /api/cloud/link-keys       {name}  -> {id, name, key}   the key is shown once
//	GET    /api/cloud/link-keys               -> {keys: [{id, name, created_at, last_used_at}]}   never a key
//	DELETE /api/cloud/link-keys/{id}          -> {ok}   ends the key and the requests it left waiting

// VerifyLinkKey is the identity layer's check of a request key: its id when it is live.
func (h *CloudHandler) VerifyLinkKey(ctx context.Context, key string) (string, bool) {
	if h == nil || h.links == nil {
		return "", false
	}
	k, ok := h.links.VerifyLinkKey(ctx, key, time.Now())
	return k.ID, ok
}

func (h *CloudHandler) linkKeyErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrLinkKeyNone):
		errNotFound(w, "No such key")
	case errors.Is(err, store.ErrLinkKeyName):
		errBadRequest(w, store.ErrLinkKeyName.Error())
	case errors.Is(err, store.ErrLinkKeyLimit):
		writeError(w, http.StatusConflict, "too_many_keys", store.ErrLinkKeyLimit.Error())
	default:
		errInternalServer(w, "Could not do that with the key")
	}
}

// LinkKeyCreate: POST /api/cloud/link-keys.
func (h *CloudHandler) LinkKeyCreate(w http.ResponseWriter, r *http.Request) {
	if h.linkRequestHuman(w, r) || !requireJSON(w, r) {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeJSONLimit(r, &body, 1024); err != nil {
		errBadRequest(w, "send {\"name\": a name for the Hub this key is for}")
		return
	}
	id, key, err := h.links.CreateLinkKey(r.Context(), body.Name, time.Now())
	if err != nil {
		h.linkKeyErr(w, err)
		return
	}
	slog.Info("cloud: link key made", "key", id) // never the key
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "name": cleanSavedField(body.Name), "key": key})
}

// LinkKeyList: GET /api/cloud/link-keys.
func (h *CloudHandler) LinkKeyList(w http.ResponseWriter, r *http.Request) {
	if h.linkRequestHuman(w, r) {
		return
	}
	ks, err := h.links.ListLinkKeys(r.Context())
	if err != nil {
		errInternalServer(w, "Could not read the keys")
		return
	}
	type view struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		CreatedAt  string `json:"created_at"`
		LastUsedAt string `json:"last_used_at,omitempty"`
	}
	out := make([]view, 0, len(ks))
	for _, k := range ks {
		v := view{ID: k.ID, Name: cleanSavedField(k.Name), CreatedAt: k.CreatedAt.UTC().Format(time.RFC3339)}
		if !k.LastUsedAt.IsZero() {
			v.LastUsedAt = k.LastUsedAt.UTC().Format(time.RFC3339)
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": out})
}

// LinkKeyRevoke: DELETE /api/cloud/link-keys/{id}.
func (h *CloudHandler) LinkKeyRevoke(w http.ResponseWriter, r *http.Request) {
	if h.linkRequestHuman(w, r) {
		return
	}
	id := chi.URLParam(r, "id")
	if err := h.links.RevokeLinkKey(r.Context(), id, time.Now()); err != nil {
		h.linkKeyErr(w, err)
		return
	}
	slog.Info("cloud: link key revoked", "key", id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// finishFailures counts wrong-code finishes across the whole process (design item 7): past the limit in the window every finish waits, whoever asks, so a spread of requests cannot guess at codes one try at a time.
var finishFailures = struct {
	sync.Mutex
	at []time.Time
}{}

const (
	finishFailureWindow = 10 * time.Minute
	finishFailureLimit  = 20
)

func finishFailuresOver(now time.Time) bool {
	finishFailures.Lock()
	defer finishFailures.Unlock()
	keep := finishFailures.at[:0]
	for _, t := range finishFailures.at {
		if now.Sub(t) < finishFailureWindow {
			keep = append(keep, t)
		}
	}
	finishFailures.at = keep
	return len(keep) >= finishFailureLimit
}

func noteFinishFailure(now time.Time) {
	finishFailures.Lock()
	finishFailures.at = append(finishFailures.at, now)
	finishFailures.Unlock()
}
