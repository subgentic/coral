package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #16140 (Security on #16030): the queue's list through Coral Hub is the computer owner's alone, and each note is redacted before it leaves.

func (g *resRig) list(hdr map[string]string) (int, []map[string]any, string) {
	g.t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/resources", nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	g.r.ServeHTTP(rec, req)
	var out struct {
		Resources []map[string]any `json:"resources"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out.Resources, rec.Body.String()
}

func TestTheResourceListThroughTheHubIsTheOwnersAlone(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})
	g.do("token:Dev A", "POST", "/api/resources/mac-heavy/claim", map[string]any{"note": "gate run"})
	withLabel(t, ownerLabel, nil)

	code, _, body := g.list(granteeHeaders())
	assert.Equal(t, http.StatusForbidden, code, "a Hub caller that is not the owner: a viewer, a grantee, a guide")
	assert.Contains(t, body, "owner_only")
	assert.NotContains(t, body, "Dev A", "nothing of the queue is read before the refusal")
	assert.NotContains(t, body, "gate run")

	code, list, _ := g.list(ownerHeaders(ownerLabel))
	require.Equal(t, http.StatusOK, code, "the owner")
	require.Len(t, list, 1)
	assert.Equal(t, "mac-heavy", list[0]["name"])

	code, list, _ = g.list(nil)
	require.Equal(t, http.StatusOK, code, "this computer's own dashboard and agents are unchanged")
	assert.Len(t, list, 1)
}

func TestTheResourceListThroughTheHubRedactsEachNoteAndLocalIsUnchanged(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	g.subscribe("alpha", "Dev B", "Developer", false)
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})
	secret := "s3cr3t" + "Value99AbCdEf1234" // built at runtime: no token-shaped string sits in the source; long enough for the api_key rule (16)
	g.do("token:Dev A", "POST", "/api/resources/mac-heavy/claim", map[string]any{"note": "gate run api_key=" + secret})
	g.do("token:Dev B", "POST", "/api/resources/mac-heavy/claim", map[string]any{"note": "next, password=" + secret})
	withLabel(t, ownerLabel, nil)

	code, _, body := g.list(ownerHeaders(ownerLabel))
	require.Equal(t, http.StatusOK, code)
	assert.NotContains(t, body, secret, "neither a holder's note nor a waiting agent's note leaves with its secret")
	assert.Contains(t, body, "gate run", "the rest of the note is kept")
	assert.Contains(t, body, "next,")

	_, _, local := g.list(nil)
	assert.Contains(t, local, secret, "this computer shows the note as it was written (the redaction is for what leaves)")

	// a note the redactor cannot check is dropped, never sent as it was
	redactCommentFailsFor = func(text string) bool { return strings.Contains(text, "gate run") }
	t.Cleanup(func() { redactCommentFailsFor = nil })
	_, list, body := g.list(ownerHeaders(ownerLabel))
	assert.NotContains(t, body, secret)
	assert.NotContains(t, body, "gate run")
	holders := list[0]["holders"].([]any)
	require.Len(t, holders, 1)
	assert.Equal(t, "Dev A", holders[0].(map[string]any)["agent"], "the entry stays, only its note is gone")
}
