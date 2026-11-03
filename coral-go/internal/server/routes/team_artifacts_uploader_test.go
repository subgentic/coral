package routes

import (
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
