package routes

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Every file that asks artifactReadable whether a caller may read an artifact (#14913, Security's #14912): a new caller is a new read route, so it is added here with the route it serves, and the forged-stamp
// table in internal/server (TestEveryArtifactReadRouteRefusesAForgedTunnelStamp) gets that route too. The count is the number of calls in the file.
var artifactReadableCallers = map[string]struct {
	calls int
	route string
}{
	"artifact_comment_carry.go":  {1, "the comments a series carries: each version's digest is asked before its comments are listed (GET /api/artifacts/{id}/comments)"},
	"artifact_comment_images.go": {1, "GET /api/artifacts/{id}/comments/... the pictures of a comment"},
	"artifact_comments.go":       {1, "GET /api/artifacts/{id}/comments"},
	"artifact_series_routes.go":  {2, "GET /api/artifacts/series/{series_id} and its versions"},
	"artifact_short_refs.go":     {1, "the short reference of an artifact (a prefix of its digest) is resolved only among the artifacts the caller reads"},
	"artifacts_read.go":          {1, "GET /api/artifacts/{id}"},
}

func TestEveryCallerOfArtifactReadableIsReviewed(t *testing.T) {
	files, err := filepath.Glob("*.go")
	require.NoError(t, err)
	got := map[string]int{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(f)
		require.NoError(t, err)
		n := 0
		for _, line := range strings.Split(string(raw), "\n") {
			code := line
			if i := strings.Index(code, "//"); i >= 0 {
				code = code[:i]
			}
			n += strings.Count(code, "artifactReadable(")
		}
		if f == "artifact_owner.go" {
			n-- // the definition
		}
		if n > 0 {
			got[f] = n
		}
	}
	var unreviewed, stale []string
	for f, n := range got {
		if want, ok := artifactReadableCallers[f]; !ok || want.calls != n {
			unreviewed = append(unreviewed, f)
		}
	}
	for f, want := range artifactReadableCallers {
		if got[f] != want.calls {
			stale = append(stale, f)
		}
	}
	sort.Strings(unreviewed)
	sort.Strings(stale)
	assert.Empty(t, unreviewed, "a file that asks artifactReadable is not in the reviewed list (or its number of calls changed): add its route here and to the forged-stamp table in internal/server")
	assert.Empty(t, stale, "the reviewed list names a call that is gone")
}

// The line holds on its own (#14913): a tunneled request that names no Hub account reads nothing, whatever the route in front of it checked. A stream that does name one still reads here: the grantees and guests the
// comment routes serve through the Hub (#7052) are decided by the route's own tier and refuseNonOwner, as they always were.
func TestArtifactReadableRefusesATunneledRequestThatNamesNoHubAccount(t *testing.T) {
	dir := t.TempDir()
	const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	req := func(header map[string]string) *http.Request {
		r := httptest.NewRequest("GET", "/api/artifacts/"+id, nil)
		for k, v := range header {
			r.Header.Set(k, v)
		}
		return r
	}
	assert.False(t, artifactReadable(req(map[string]string{tunnel.ViaHeader: cloud.ViaSecret()}), dir, id), "the real stamp and no Hub account")
	assert.False(t, artifactReadable(req(map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "not a hub user"}), dir, id), "an account name that is not a Hub user id")
	assert.True(t, artifactReadable(req(map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "hub-user-9999ffff"}), dir, id), "a Hub account: the route decides what it may do")
	assert.False(t, artifactReadable(req(map[string]string{tunnel.ViaHeader: "1", tunnel.HubUserHeader: "hub-user-9999ffff"}), dir, id), "a forged stamp with a valid Hub user is nothing: the stamp must be the connector's own (#14912)")
	assert.True(t, artifactReadable(req(map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubUserHeader: "hub-user-1234abcd"}), dir, id), "the connector's own stamp with a valid Hub user reads here")
}
