package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14777, Security's SHOULD 7 on the 5a approval: through Coral Hub the Needs you answer carries no dropbox_edit item and counts none, and an
// agent's token can neither read the held edit nor decide it.

// The Operator (#196894): no Dropbox item in Needs you, on this computer or through Coral Hub; a held edit is in Settings only. Mutant: the
// dropbox_edit kind (or its provider) back in the board's Needs you.
func TestNeedsYouHasNoDropboxEditAnywhere(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	heldEdit(t)
	h, _ := operatorAsksRig(t)
	viaHub := func(r *http.Request) *http.Request {
		for k, v := range ownerHeaders(ownerLabel) {
			r.Header.Set(k, v)
		}
		return asPerson(r)
	}
	for _, as := range []func(*http.Request) *http.Request{asPerson, viaHub} {
		code, out := readNeedsYou(t, h, "", as)
		require.Equal(t, http.StatusOK, code)
		_, has := out["counts"].(map[string]any)["dropbox_edit"]
		assert.False(t, has, "no dropbox_edit count")
		for _, it := range needsYouItems(out) {
			assert.NotEqual(t, "dropbox_edit", it["kind"])
		}
		code, _ = readNeedsYou(t, h, "?kind=dropbox_edit", as)
		assert.Equal(t, http.StatusBadRequest, code, "not a kind of Needs you any more")
	}
}

// Mutant: the decision routes take an agent's token.
func TestAnAgentTokenCannotDecideAHeldEdit(t *testing.T) {
	be, _, e := heldEdit(t)
	r := chi.NewRouter()
	r.Post("/api/dropbox/edits/{doc}/promote", be.h.DropboxPromoteEdit)
	r.Post("/api/dropbox/edits/{doc}/separate", be.h.DropboxSeparateEdit)
	for _, action := range []string{"promote", "separate"} {
		tok := "agent-token-" + "0123456789" // built here: the repository's text holds no header-key-shaped value (the secrets rule)
		for _, hdr := range []map[string]string{{"Authorization": "Bearer " + tok}, {"X-Coral-Session-Token": tok}} {
			req := httptest.NewRequest(http.MethodPost, "/api/dropbox/edits/"+e.DocID+"/"+action, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			for k, v := range hdr {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			assert.NotEqual(t, http.StatusOK, rec.Code, "%s with %v: %s", action, hdr, rec.Body.String())
		}
	}
	open, _ := be.b.edits.IsOpen(context.Background(), e.DocID)
	assert.True(t, open, "still pending: nothing was decided")
	assert.False(t, be.hasRecord(e.Digest))
}
