package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/tunnel"
)

// #13959: the server's attention rule is the page's: per person and per version. A file read on an earlier version still waits while a newer one is unopened; changes requested stays the agent's turn; read means read of
// THIS version.
func TestTheAttentionRuleByTagsNewsAndVersion(t *testing.T) {
	cases := []struct {
		name    string
		tags    []string
		news    int
		newVer  bool
		waiting bool
	}{
		{"for review, unread", []string{"for review"}, 0, false, true},
		{"for review, read", []string{"for review", "read"}, 0, false, false},
		{"for review, read, new version unopened", []string{"for review", "read"}, 0, true, true},
		{"for review, read, news", []string{"for review", "read"}, 2, false, true},
		{"changes requested, no news", []string{"for review", "changes requested"}, 0, false, false},
		{"changes requested, no news, new version unopened", []string{"for review", "changes requested", "read"}, 0, true, false},
		{"changes requested, with news", []string{"for review", "changes requested"}, 1, false, true},
		{"saved, new version unopened", []string{"for review", "read", "saved"}, 0, true, false},
		{"ignored, new version unopened", []string{"for review", "read", "ignored"}, 0, true, false},
		{"decided, no news", []string{"approved"}, 0, true, false},
		{"decided, with news", []string{"approved"}, 1, false, true},
	}
	for _, c := range cases {
		assert.Equal(t, c.waiting, needsYouFileV(c.tags, c.news, c.newVer), c.name)
	}
	assert.False(t, artifactIsReadV(teamArtifact{Tags: []string{"for review", "read"}}, true), "read of an earlier version is not read")
	assert.True(t, artifactIsReadV(teamArtifact{Tags: []string{"for review", "read"}}, false))
	assert.False(t, artifactIsReadV(teamArtifact{Tags: []string{"for review", "read"}, NewComments: 1}, false))
}

// Over HTTP, on the cross-team list: the newest version of a three-version file is tagged for review and read, and the Operator last opened version N.
func TestWaitingAndReadFiltersFollowTheVersionsThePersonOpened(t *testing.T) {
	p := newPinnedRig(t)
	k := p.k
	ctx := context.Background()
	_, d := threeVersions(t, k) // alpha's series d[0], d[1], d[2]; d[2] is the row for the file
	_, err := k.h.bs.AddArtifactTags(ctx, "alpha", d[2], []string{"read"})
	require.NoError(t, err)
	sid := mustSeriesOf(t, k, d[0])
	open := func(version int) {
		_, err := k.h.db.ExecContext(ctx, `DELETE FROM artifact_series_opened`)
		require.NoError(t, err)
		if version > 0 {
			_, err = k.h.db.ExecContext(ctx, `INSERT INTO artifact_series_opened (person, board_id, series_id, version, opened_at) VALUES ('owner', 'alpha', ?, ?, '2026-11-06T10:00:00Z')`, sid, version)
			require.NoError(t, err)
		}
	}
	has := func(path string) bool {
		code, out := p.get(t, path, nil)
		require.Equal(t, http.StatusOK, code, out)
		for _, a := range out["artifacts"].([]any) {
			if strings.TrimPrefix(a.(map[string]any)["digest"].(string), "sha256:") == d[2] {
				return true
			}
		}
		return false
	}
	const waiting, read = "/api/team-artifacts?tag=for+review&waiting=1&limit=50", "/api/team-artifacts?tag=for+review&read=1&limit=50"

	open(3) // opened the newest version: read stands
	assert.False(t, has(waiting), "opened this version: it does not wait")
	assert.True(t, has(read), "and it is read")
	open(2) // a newer version (3) than the one they last opened (2)
	assert.True(t, has(waiting), "a new version unopened waits for them though it was read on an earlier one")
	assert.False(t, has(read), "and it is not read")
	assert.True(t, has("/api/team-artifacts?tag=for+review&read=0&limit=50"))
	open(0) // never opened through the page: the read tag stands as it always did
	assert.False(t, has(waiting))
	assert.True(t, has(read))

	// changes requested: the agent's turn, visible but uncounted, whatever version is unopened
	_, err = k.h.bs.AddArtifactTags(ctx, "alpha", d[2], []string{"changes requested"})
	require.NoError(t, err)
	open(2)
	assert.False(t, has(waiting), "changes requested with no news is not waiting, though a new version is unopened")
	assert.True(t, has("/api/team-artifacts?tag=for+review&limit=50"), "but it is still in the list")
}

// The Operator's own attention: an agent's token and a Hub caller that is not the owner get no per-person version state, and a request for the per-board list has no cross-team person either.
func TestTheVersionAwareAttentionIsTheOperatorsAlone(t *testing.T) {
	p := newPinnedRig(t)
	k := p.k
	ctx := context.Background()
	_, d := threeVersions(t, k)
	_, err := k.h.bs.AddArtifactTags(ctx, "alpha", d[2], []string{"read"})
	require.NoError(t, err)
	_, err = k.h.db.ExecContext(ctx, `INSERT INTO artifact_series_opened (person, board_id, series_id, version, opened_at) VALUES ('owner', 'alpha', ?, 2, '2026-11-06T10:00:00Z')`, mustSeriesOf(t, k, d[0]))
	require.NoError(t, err)
	rows := []teamArtifact{{ID: d[2], managed: d[2], BoardID: "alpha", Tags: []string{"for review", "read"}}}
	operator := httptest.NewRequest("GET", "/x", nil)
	assert.True(t, p.bh.newVersionUnopened(operator, "", rows)[attentionKey("alpha", d[2])], "the Operator's request sees it")
	agent := withActor(httptest.NewRequest("GET", "/x", nil), Actor{Kind: ActorToken, Name: "Backend", Session: "s1"})
	assert.Empty(t, p.bh.newVersionUnopened(agent, "", rows), "an agent's token gets nothing of it")
	hub := httptest.NewRequest("GET", "/x", nil)
	hub.Header.Set(tunnel.ViaHeader, "x")
	assert.Empty(t, p.bh.newVersionUnopened(hub, "", rows), "nor a Hub caller with no owner stamp")
	// only the rows the answer could change are looked at: not for review, not read, or changes requested
	for _, tags := range [][]string{{"read"}, {"for review"}, {"for review", "read", "changes requested"}} {
		assert.Empty(t, p.bh.newVersionUnopened(operator, "", []teamArtifact{{ID: d[2], managed: d[2], BoardID: "alpha", Tags: tags}}), strings.Join(tags, ","))
	}
}

// Needs you's own count (the badge) follows the same rule: a file the Operator read on version 1 is counted again while version 2 is unopened, and not once they opened it.
func TestNeedsYouCountsAFileReadOnAnEarlierVersionUntilTheNewOneIsOpened(t *testing.T) {
	e := newReviewEnv(t, true)
	coralDir := e.h.coralDir
	e.tag(t, `["for review", "read"]`)
	db, err := sqlx.Open("sqlite", filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	_, err = db.Exec(`CREATE TABLE artifact_series_opened (person TEXT NOT NULL, board_id TEXT NOT NULL, series_id TEXT NOT NULL, version INTEGER NOT NULL, opened_at TEXT NOT NULL, PRIMARY KEY (person, board_id, series_id))`)
	require.NoError(t, err)
	e.h.bs.SetSessionsDB(db)
	series := strings.Repeat("c", 32)
	up := uploadsDir(coralDir, "sA")
	require.NoError(t, os.MkdirAll(up, 0o700))
	rec, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "plan.md", MediaType: "text/markdown", Size: 9, Digest: "sha256:" + e.id}, CreatedAt: "2026-11-06T09:00:00Z", Board: "alpha", SeriesID: series, Version: 2, Previous: strings.Repeat("9", 64)})
	require.NoError(t, os.WriteFile(filepath.Join(up, e.id+".json"), rec, 0o600))
	count := func() int {
		req := asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
		w := httptest.NewRecorder()
		e.h.NeedsYou(w, req)
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		var out map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		return int(out["count"].(float64))
	}
	assert.Equal(t, 0, count(), "read, and the person never opened a version through the page: the read tag stands")
	_, err = db.Exec(`INSERT INTO artifact_series_opened (person, board_id, series_id, version, opened_at) VALUES ('owner', 'alpha', ?, 1, '2026-11-06T10:00:00Z')`, series)
	require.NoError(t, err)
	assert.Equal(t, 1, count(), "opened version 1, version 2 is out: it waits again")
	_, err = db.Exec(`UPDATE artifact_series_opened SET version = 2`)
	require.NoError(t, err)
	assert.Equal(t, 0, count(), "opened version 2: read")
}
