package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// An artifact's id is its content (#13493, Security on coral-hub's #169685: "can a file the owner saw change before they approve it?"). The object is named by the SHA-256 of its bytes, written once and never replaced,
// so a verdict on {id} is a verdict on those bytes. These tests pin that; the review route's Hub guard (a row with no matching digest is refused) follows from it.

func objectHashes(t *testing.T, dir string) map[string]os.FileInfo {
	t.Helper()
	out := map[string]os.FileInfo{}
	entries, err := os.ReadDir(filepath.Join(dir, "artifacts", "objects"))
	require.NoError(t, err)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") || strings.HasPrefix(e.Name(), ".tmp") {
			continue
		}
		fi, err := e.Info()
		require.NoError(t, err)
		out[e.Name()] = fi
	}
	return out
}

func TestAStoredObjectIsNamedByItsBytesAndNeverReplaced(t *testing.T) {
	dir := t.TempDir()
	one, other := []byte("# the plan, version one"), []byte("# the plan, version two")
	id1, meta1, err := storeArtifact(dir, "sess-a", "plan.md", "text/markdown", one)
	require.NoError(t, err)
	sum := sha256.Sum256(one)
	assert.Equal(t, hex.EncodeToString(sum[:]), id1, "the id is the SHA-256 of the bytes")
	assert.Equal(t, "sha256:"+id1, meta1.Digest)
	before := objectHashes(t, dir)[id1]
	require.NotNil(t, before)

	// the same bytes again, under another name and from another session: the same id, the object is not written again (the same file, the same modification time)
	id1b, meta1b, err := storeArtifact(dir, "sess-b", "renamed.md", "text/markdown", one)
	require.NoError(t, err)
	assert.Equal(t, id1, id1b, "the same bytes are the same id")
	assert.Equal(t, "plan.md", meta1b.Name, "the first record's name stays: the sidecar is created once")
	after := objectHashes(t, dir)[id1]
	assert.True(t, os.SameFile(before, after), "the object is the same file")
	assert.Equal(t, before.ModTime(), after.ModTime(), "and was not written again")

	// other bytes are another id and leave the first object as it was
	id2, _, err := storeArtifact(dir, "sess-a", "plan.md", "text/markdown", other)
	require.NoError(t, err)
	assert.NotEqual(t, id1, id2, "other bytes, other id")
	assert.True(t, os.SameFile(before, objectHashes(t, dir)[id1]), "the first object is untouched")

	// every object in the store is named by the hash of what it holds
	for name := range objectHashes(t, dir) {
		b, err := os.ReadFile(filepath.Join(dir, "artifacts", "objects", name))
		require.NoError(t, err)
		s := sha256.Sum256(b)
		assert.Equal(t, hex.EncodeToString(s[:]), name, "the object's name is its content's hash")
	}
}

// No other file of the routes package writes into the objects folder (every writer hashes the bytes first and names the object by the hash, so even a rewrite of an existing name holds the same bytes; cross_team_pending.go only checks objects exist): the files that name the folder (or its helper) AND write a file are exactly these. A new one is a new way to write a stored object: review it, and
// that it names by hash and never replaces, before it goes in this list.
func TestOnlyTheReviewedFilesWriteIntoTheObjectsFolder(t *testing.T) {
	names, err := filepath.Glob("*.go")
	require.NoError(t, err)
	refs := regexp.MustCompile(`"artifacts", "objects"|artifactDir\(\)|objectsDir\(`)
	writes := regexp.MustCompile(`writeFileAtomic\(|os\.WriteFile\(|os\.Rename\(|os\.Create\(|os\.CreateTemp\(|os\.OpenFile\(|os\.Link\(`)
	var got []string
	for _, n := range names {
		if strings.HasSuffix(n, "_test.go") {
			continue
		}
		b, err := os.ReadFile(n)
		require.NoError(t, err)
		if refs.Match(b) && writes.Match(b) {
			got = append(got, n)
		}
	}
	sort.Strings(got)
	want := []string{"artifact_comment_images.go", "artifacts.go", "artifacts_store.go", "cross_team_pending.go", "operator_artifacts.go"}
	assert.Equal(t, want, got, "the files of this package that name the objects folder and write a file changed: review how the new one names and writes an object")
}

// Through Coral Hub a verdict on a file whose stored record does not confirm its content is refused (#13493): the id names the bytes only when the record says sha256:<id>.
func TestAHubVerdictNeedsTheStoredDigestToMatchTheId(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	for name, c := range map[string]struct {
		withMeta bool
		hub      bool
		want     int
	}{
		"through the Hub, digest confirmed":  {true, true, http.StatusOK},
		"through the Hub, no digest record":  {false, true, http.StatusConflict},
		"on this computer, no digest record": {false, false, http.StatusOK},
		"on this computer, digest confirmed": {true, false, http.StatusOK},
	} {
		srv, h, coralDir := teamArtifactServer(t)
		_ = srv
		r := chi.NewRouter()
		r.Get("/api/board/{project}/artifacts", h.ListTeamArtifacts)
		r.Put("/api/board/{project}/artifacts/{id}/tags", h.SetArtifactTags)
		r.Post("/api/board/{project}/artifacts/{id}/review", func(w http.ResponseWriter, req *http.Request) {
			kind := callerDashCookie
			if c.hub {
				kind = callerHub
			}
			h.ReviewArtifact(w, req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind)))
		})
		s := httptest.NewServer(r)
		t.Cleanup(s.Close)
		subscribeSession(t, h, "alpha", "Alice", sessAlice)
		subscribeSession(t, h, "alpha", "Bob", sessBob)
		id := storeManagedArtifact(t, coralDir, "# the plan "+name, true, c.withMeta)
		completeWithArtifactsAs(t, h, "alpha", "Alice", "A work", []board.TaskArtifact{{Name: "plan.md", URI: "coral://artifacts/" + id}})
		e := &reviewEnv{srv: s, h: h, id: id, name: "plan.md"}
		e.tag(t, `["for review"]`)
		req, err := http.NewRequest(http.MethodPost, s.URL+"/api/board/alpha/artifacts/"+id+"/review", strings.NewReader(`{"decision":"approve"}`))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		if c.hub {
			for k, v := range ownerHeaders(ownerLabel) {
				req.Header.Set(k, v)
			}
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		assert.Equal(t, c.want, resp.StatusCode, name)
	}
}
