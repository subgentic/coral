package routes

import (
	"context"
	"encoding/json"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestTeamArtifactUploadAttributionAndSort(t *testing.T) {
	srv, h, dir := teamArtifactServer(t)
	cases := []struct{ name, uploader, role, human string }{
		{"role.txt", "Ada", "Builder", ""}, {"name.txt", "Zed", "", ""}, {"operator.txt", "", "", "owner"}, {"old.txt", "", "", ""},
	}
	ids := map[string]string{}
	for i, c := range cases {
		sid := []string{sessAlice, sessBob, "operator-upload", "old-upload"}[i]
		subscribeSession(t, h, "alpha", c.name, sid)
		id := writeUpload(t, dir, sid, c.name, c.name, "2026-11-03T00:00:00Z")
		ids[c.name] = id
		rec, ok := readUploadRecord(dir, sid, id)
		require.True(t, ok)
		rec.Uploader, rec.Role, rec.UploadedBy, rec.OwnerKind = c.uploader, c.role, c.human, "operator"
		b, err := json.Marshal(rec)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(uploadsDir(dir, sid), id+".json"), b, 0600))
	}
	resp, err := http.Get(srv.URL + "/api/team-artifacts?sort=uploader&limit=2")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var first struct {
		Artifacts []map[string]any `json:"artifacts"`
		Next      string           `json:"next_cursor"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&first))
	require.Len(t, first.Artifacts, 2)
	require.Equal(t, ids["role.txt"], first.Artifacts[0]["id"])
	require.Equal(t, "Ada", first.Artifacts[0]["uploader"])
	require.Equal(t, "Builder", first.Artifacts[0]["role"])
	require.Equal(t, ids["operator.txt"], first.Artifacts[1]["id"])
	require.Equal(t, "owner", first.Artifacts[1]["uploaded_by"])
	require.NotEmpty(t, first.Next)
	next := getTeamArtifacts(t, srv, "/api/team-artifacts?sort=uploader&limit=2&cursor="+url.QueryEscape(first.Next), http.StatusOK)
	require.Equal(t, []string{"name.txt", "old.txt"}, artifactNames(next.Artifacts))
	desc := getTeamArtifacts(t, srv, "/api/team-artifacts?sort=uploader_desc", http.StatusOK)
	require.Equal(t, []string{"name.txt", "operator.txt", "role.txt", "old.txt"}, artifactNames(desc.Artifacts))
	sid := sessAlice
	original := []teamArtifact{{ID: ids["role.txt"], Name: "attached.txt", SessionID: &sid, TaskID: 42}}
	merged := h.uploads.merge(original, dir, map[string]string{sid: "Current role"})
	require.Equal(t, int64(42), merged[0].TaskID)
	wire, err := json.Marshal(merged[0])
	require.NoError(t, err)
	var fields map[string]any
	require.NoError(t, json.Unmarshal(wire, &fields))
	require.Equal(t, "Builder", fields["role"])
	require.Equal(t, "Ada", fields["uploader"])
}

// Upload labels reject controls at ingestion; a Hub list must also apply the
// configured redactor to the recorded display labels before sorting/returning them.
func TestTeamArtifactUploaderLabelsAreValidatedAndRedacted(t *testing.T) {
	srv, h, dir := teamArtifactServer(t)
	subscribeSession(t, h, "alpha", "Ada", sessAlice)
	prev := uploaderLookup
	t.Cleanup(func() { uploaderLookup = prev })
	uploaderLookup = func(context.Context, string) (string, string, string) { return "alpha", "Bad\x01Name", "Bad\x01Role" }
	id := writeUpload(t, dir, sessAlice, "invalid labels", "invalid.txt", "2026-11-03T00:00:00Z")
	rec, ok := readUploadRecord(dir, sessAlice, id)
	require.True(t, ok)
	checked := newUploadRecord(rec.agentArtifactMeta, sessAlice, "", "")
	require.Empty(t, checked.Uploader, "control-bearing uploader is never recorded")
	require.Empty(t, checked.Role, "control-bearing role is never recorded")
	b, err := json.Marshal(checked)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(uploadsDir(dir, sessAlice), id+".json"), b, 0600))
	clean := getTeamArtifacts(t, srv, "/api/team-artifacts", http.StatusOK)
	require.Len(t, clean.Artifacts, 1)
	require.Empty(t, clean.Artifacts[0].Uploader)
	require.Empty(t, clean.Artifacts[0].Role)
	const token = "ghp_aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5"
	id = writeUpload(t, dir, sessAlice, "recorded display labels", "redacted.txt", "2026-11-03T01:00:00Z")
	rec, ok = readUploadRecord(dir, sessAlice, id)
	require.True(t, ok)
	rec.Uploader = "Ada " + token
	rec.Role = "Builder " + token
	b, err = json.Marshal(rec)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(uploadsDir(dir, sessAlice), id+".json"), b, 0600))
	req, err := http.NewRequest("GET", srv.URL+"/api/team-artifacts?sort=uploader", nil)
	require.NoError(t, err)
	setHubOwner(t, req)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var reply struct {
		Artifacts []teamArtifact `json:"artifacts"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&reply))
	var found *teamArtifact
	for i := range reply.Artifacts {
		if reply.Artifacts[i].ID == id {
			found = &reply.Artifacts[i]
		}
	}
	require.NotNil(t, found)
	require.Equal(t, "Ada [redacted token]", found.Uploader)
	require.Equal(t, "Builder [redacted token]", found.Role)
}
