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

// Mutant: the board serves the Dropbox items through the tunnel (the provider's own check removed).
func TestThroughTheHubNeedsYouHasNoDropboxEdit(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil) // the Hub's owner of this computer: the one Hub reader who gets every kind of Needs you
	be, _, e := heldEdit(t)
	h, _ := operatorAsksRig(t)
	h.SetNeedsYouDropbox(DropboxEditItems(be.h.dbx.dataDir))

	code, out := readNeedsYou(t, h, "", asPerson)
	require.Equal(t, http.StatusOK, code)
	assert.EqualValues(t, 1, out["counts"].(map[string]any)["dropbox_edit"], "on this computer the edit is counted")
	found := false
	for _, it := range needsYouItems(out) {
		if it["kind"] == "dropbox_edit" && it["id"] == "dropbox_edit:"+e.DocID {
			found = true
		}
	}
	assert.True(t, found, "and listed")

	viaHub := func(r *http.Request) *http.Request {
		for k, v := range ownerHeaders(ownerLabel) {
			r.Header.Set(k, v)
		}
		return asPerson(r)
	}
	code, out = readNeedsYou(t, h, "", viaHub)
	require.Equal(t, http.StatusOK, code, "the Hub's owner reads Needs you: %v", out)
	assert.EqualValues(t, 0, out["counts"].(map[string]any)["dropbox_edit"], "through the Hub: counted as none")
	for _, it := range needsYouItems(out) {
		assert.NotEqual(t, "dropbox_edit", it["kind"], "through the Hub: never listed")
	}
	code, out = readNeedsYou(t, h, "?kind=dropbox_edit", viaHub)
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, needsYouItems(out), "not even asked for by kind")
}

// Mutant: the decision routes take an agent's token.
func TestAnAgentTokenCannotDecideAHeldEdit(t *testing.T) {
	be, _, e := heldEdit(t)
	r := chi.NewRouter()
	r.Post("/api/dropbox/edits/{doc}/promote", be.h.DropboxPromoteEdit)
	r.Post("/api/dropbox/edits/{doc}/separate", be.h.DropboxSeparateEdit)
	for _, action := range []string{"promote", "separate"} {
		for _, hdr := range []map[string]string{{"Authorization": "Bearer agent-token-0123456789"}, {"X-Coral-Session-Token": "agent-token-0123456789"}} {
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
