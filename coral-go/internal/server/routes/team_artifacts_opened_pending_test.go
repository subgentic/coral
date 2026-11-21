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

// #20200 (walk #20199 item 3): the Operator opens v1 BEFORE v2 exists. A first upload is no series yet (v2 stamps it, retroactively), so the opened record had nowhere to go: the route answered 404 and v2's row
// never said "New version". An open of a standalone file is kept (version 1, by its digest) and counts as version 1 of the series it becomes.
func TestOpeningVersionOneBeforeVersionTwoExistsGivesTheNewVersionBaseline(t *testing.T) {
	p := newPinnedRig(t)
	k := p.k
	ctx := context.Background()
	require.NoError(t, k.h.bs.RenameBoard(ctx, "alpha", "Product"))
	root, err := k.h.bs.CreateTask(ctx, "alpha", "OPERATOR the document", "", "medium", "lead", "Backend")
	require.NoError(t, err)
	code, out := k.upTask("s1", root.ID, "the document, version one", "&name=doc.md")
	require.Equal(t, 201, code, out)
	v1 := digestOfURI(out["uri"].(string))
	open := func(id string) (int, string) {
		req := httptest.NewRequest(http.MethodPost, "/api/artifacts/"+id+"/opened", nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rc := chi.NewRouteContext()
		rc.URLParams.Add("id", id)
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rc))
		rec := httptest.NewRecorder()
		k.h.openedArtifactRoute(rec, req)
		return rec.Code, rec.Body.String()
	}
	c, body := open(v1)
	require.Equal(t, 200, c, "opening a standalone first version is recorded, not refused: "+body)
	code, out = k.upTask("s1", root.ID, "the document, version two", "&name=doc.md")
	require.Equal(t, 201, code, out)
	_, list := p.get(t, "/api/team-artifacts?tag=for+review&team=alpha", nil)
	arts, _ := list["artifacts"].([]any)
	require.NotEmpty(t, arts, list)
	row := arts[0].(map[string]any)
	assert.EqualValues(t, 2, row["version"])
	assert.EqualValues(t, 1, row["opened_version"], "v2's row has the baseline of the v1 the Operator opened, so it says New version v2")
}
