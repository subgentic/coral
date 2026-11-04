package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// Ignore and Undo of a question through Coral Hub (#13446, #13450): the owner's Needs you table drawn on the Hub puts a question away and brings it back. The account this computer is linked to may; a grantee, a viewer and a
// guide get 403 owner_only on both, before the body is read; an agent's token is refused on Undo; a note is needed to close.

func hubCloseCall(t *testing.T, h *BoardHandler, qid int64, hdr map[string]string, actor *Actor, body map[string]any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/board/team/asks/%d/close", qid), strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	if actor != nil {
		req = withActor(req, *actor)
		if actor.Kind == ActorHub {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerHub))
		}
	}
	rc := chi.NewRouteContext()
	rc.URLParams.Add("project", "team")
	rc.URLParams.Add("messageID", fmt.Sprint(qid))
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
	w := httptest.NewRecorder()
	h.CloseAsk(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestIgnoreAndUndoThroughTheHubAreTheOwnersAlone(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	for _, who := range []struct{ id, title string }{{"Lead", "Lead Developer"}} {
		_, err := bs.Subscribe(ctx, "team", who.id, who.title, "", nil, "all")
		require.NoError(t, err)
	}
	q, err := bs.PostMessage(ctx, "team", "Lead", "@Operator may I proceed?", nil)
	require.NoError(t, err)
	require.NoError(t, bs.RecordAsk(ctx, "team", q, []string{"Operator"}))
	open := func() int { _, rows, _ := readOperatorAsks(t, h, asPerson); return len(rows) }
	hubOperator := &Actor{Kind: ActorHub, Name: "Operator", HubUser: ownerLabel}
	viewer := func() map[string]string {
		m := granteeHeaders()
		m[tunnel.HubRoleHeader] = "viewer"
		return m
	}
	guide := func() map[string]string {
		m := granteeHeaders()
		m[tunnel.HubRoleHeader] = tunnel.HubRoleGuide
		m[tunnel.HubGuideBoardHeader] = "team"
		m[tunnel.HubGuideLabelHeader] = "Reviewer"
		return m
	}

	// not the owner: refused as owner_only on the close and on the undo, whatever the body says, and nothing changes
	for name, hdr := range map[string]map[string]string{"grantee": granteeHeaders(), "viewer": viewer(), "guide": guide()} {
		code, out := hubCloseCall(t, h, q.ID, hdr, hubOperator, map[string]any{"note": "Dismissed by the operator"})
		assert.Equal(t, http.StatusForbidden, code, name+" closes nothing")
		assert.Equal(t, "owner_only", out["code"], name)
		code, out = hubCloseCall(t, h, q.ID, hdr, hubOperator, map[string]any{"undo": true})
		assert.Equal(t, http.StatusForbidden, code, name+" opens nothing")
		assert.Equal(t, "owner_only", out["code"], name)
	}
	assert.Equal(t, 1, open(), "the question is still open after every refusal")

	// an empty note is refused, for the owner too
	code, _ := hubCloseCall(t, h, q.ID, ownerHeaders(ownerLabel), hubOperator, map[string]any{"note": "   "})
	assert.Equal(t, http.StatusBadRequest, code, "a note is needed: say where it was answered")
	assert.Equal(t, 1, open())

	// the owner closes it with a note, and an agent's token (through the Hub too) cannot undo it
	code, _ = hubCloseCall(t, h, q.ID, ownerHeaders(ownerLabel), hubOperator, map[string]any{"note": "Dismissed by the operator"})
	assert.Equal(t, http.StatusOK, code, "the owner puts it away")
	assert.Equal(t, 0, open())
	code, out := hubCloseCall(t, h, q.ID, ownerHeaders(ownerLabel), &Actor{Kind: ActorToken, Name: "Lead", Session: "claude-lead"}, map[string]any{"undo": true})
	assert.Equal(t, http.StatusForbidden, code, "an agent token is refused on undo")
	assert.NotEqual(t, "", out["code"])
	assert.Equal(t, 0, open())

	// the owner opens it again
	code, _ = hubCloseCall(t, h, q.ID, ownerHeaders(ownerLabel), hubOperator, map[string]any{"undo": true})
	assert.Equal(t, http.StatusOK, code, "the owner undoes the ignore")
	assert.Equal(t, 1, open())
}
