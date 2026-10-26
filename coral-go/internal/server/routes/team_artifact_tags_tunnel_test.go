package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8623: PUT /api/board/{project}/artifacts/{id}/tags has no tunnel row, so Coral Hub never forwards it; and a request that arrives with the connector's stamp anyway is still the owner's or refused: the
// handler's first act is refuseNonOwner. The handler has no board here: a request that got past the refusal would not be a 403.
func TestSetArtifactTagsRefusesATunneledNonOwner(t *testing.T) {
	withRecord(t, "team", teamOrgA, nil)
	h := &BoardHandler{}
	const id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for name, hdr := range map[string]http.Header{
		"a member of the organisation":      teamStamp(teamOrgA, "member", teamUIDA, teamUser),
		"an admin of another organisation":  teamStamp(teamOrgB, "admin", teamUIDA, teamUser),
		"a stamp with no role":              teamStamp(teamOrgA, "", teamUIDA, teamUser),
		"the stamp of a hub viewer, no uid": teamStamp(teamOrgA, "member", "", teamUser),
	} {
		req := httptest.NewRequest(http.MethodPut, "/api/board/alpha/artifacts/"+id+"/tags", nil)
		for k, vs := range hdr {
			req.Header[k] = vs
		}
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("project", "alpha")
		rctx.URLParams.Add("id", id)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rec := httptest.NewRecorder()
		require.NotPanics(t, func() { h.SetArtifactTags(rec, req) }, name)
		assert.Equal(t, http.StatusForbidden, rec.Code, name)
		assert.Equal(t, "owner_only", decodeStrings(t, rec.Body.String())["code"], name)
	}
}
