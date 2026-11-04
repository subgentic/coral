package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
)

// #13522: the built list of a team's artifacts is kept for a walk of its pages. These tests pin that it is kept (a walk builds it once), and that every input of the list shows on the next read: no stale list.

func countBuilds(t *testing.T) *atomic.Int64 {
	t.Helper()
	var n atomic.Int64
	old := teamItemsBuildHook
	teamItemsBuildHook = func() { n.Add(1) }
	t.Cleanup(func() { teamItemsBuildHook = old })
	return &n
}

func TestTeamArtifactsListIsBuiltOnceForAWalk(t *testing.T) {
	srv, h, coralDir := teamArtifactServer(t)
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	for i := 0; i < 5; i++ {
		writeUpload(t, coralDir, sessAlice, "# doc "+string(rune('a'+i))+"\n", "doc.md", "2026-10-09T1"+string(rune('0'+i))+":00:00Z")
	}
	time.Sleep(uploadDirSettle + 500*time.Millisecond)
	builds := countBuilds(t)
	for page := 0; page < 5; page++ {
		got := getTeamArtifacts(t, srv, "/api/board/alpha/artifacts?limit=1&offset="+string(rune('0'+page)), 200)
		require.Len(t, got.Artifacts, 1)
	}
	require.EqualValues(t, 1, builds.Load(), "five pages of one walk are one build of the list")
}

func TestTeamArtifactsListShowsEveryInputOnTheNextRead(t *testing.T) {
	srv, h, coralDir := teamArtifactServer(t)
	ctx := context.Background()
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	first := writeUpload(t, coralDir, sessAlice, "# first\n", "first.md", "2026-10-09T10:00:00Z")
	time.Sleep(uploadDirSettle + 500*time.Millisecond)
	r := chi.NewRouter() // the Operator's own requests: the kinds and the private marks are the owner's
	r.Get("/api/board/{project}/artifacts", func(w http.ResponseWriter, rq *http.Request) { h.ListTeamArtifacts(w, asPerson(rq)) })
	owner := httptest.NewServer(r)
	t.Cleanup(owner.Close)
	_ = srv
	list := func() []teamArtifact {
		return getTeamArtifacts(t, owner, "/api/board/alpha/artifacts?limit=200", 200).Artifacts
	}
	find := func(rows []teamArtifact, id string) *teamArtifact {
		for i := range rows {
			if rows[i].ID == id {
				return &rows[i]
			}
		}
		return nil
	}
	require.NotNil(t, find(list(), first), "the first read lists the upload")
	builds := countBuilds(t)
	list()
	require.EqualValues(t, 0, builds.Load(), "a second read with nothing changed is the kept list")

	t.Run("a tag", func(t *testing.T) {
		require.NoError(t, h.bs.SetArtifactTags(ctx, "alpha", first, []string{"for review"}))
		row := find(list(), first)
		require.NotNil(t, row)
		require.Equal(t, []string{"for review"}, row.Tags)
	})
	t.Run("a private mark", func(t *testing.T) {
		require.False(t, find(list(), first).Private)
		require.NoError(t, h.bs.SetArtifactPrivate(ctx, first, true, "Operator"))
		require.True(t, find(list(), first).Private)
		require.NoError(t, h.bs.SetArtifactPrivate(ctx, first, false, "Operator"))
		require.False(t, find(list(), first).Private)
	})
	t.Run("a kind", func(t *testing.T) {
		_, err := h.bs.SetArtifactKind(ctx, "alpha", first, board.KindRelease, "sess", time.Now())
		require.NoError(t, err)
		require.Equal(t, board.KindRelease, find(list(), first).Kind)
	})
	t.Run("an upload written into the folder", func(t *testing.T) {
		second := writeUpload(t, coralDir, sessAlice, "# second\n", "second.md", "2026-10-09T11:00:00Z")
		require.NotNil(t, find(list(), second), "a record dropped into a subscriber's folder shows on the next read")
	})
	t.Run("a task result", func(t *testing.T) {
		stored := storeManagedArtifact(t, coralDir, "# result\n", true, true)
		completeWithArtifacts(t, h, "alpha", "Build", []board.TaskArtifact{{Name: "result.md", URI: "coral://artifacts/" + stored}})
		require.NotNil(t, find(list(), stored), "a task completed with a file shows on the next read")
	})
	t.Run("a new member's uploads", func(t *testing.T) {
		const sessCarol = "66666666-cccc-0000-0000-000000000006"
		third := writeUpload(t, coralDir, sessCarol, "# third\n", "third.md", "2026-10-09T12:00:00Z")
		require.Nil(t, find(list(), third), "an agent that is not on the team is not listed")
		subscribeSession(t, h, "alpha", "Carol", sessCarol)
		require.NotNil(t, find(list(), third), "once it joins, its uploads show on the next read")
	})
}

func TestTeamArtifactsListNeverOutlivesItsTTL(t *testing.T) {
	srv, h, coralDir := teamArtifactServer(t)
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	writeUpload(t, coralDir, sessAlice, "# one\n", "one.md", "2026-10-09T10:00:00Z")
	time.Sleep(uploadDirSettle + 500*time.Millisecond)
	now := time.Now()
	h.itemsCache.now = func() time.Time { return now }
	builds := countBuilds(t)
	getTeamArtifacts(t, srv, "/api/board/alpha/artifacts?limit=10", 200)
	getTeamArtifacts(t, srv, "/api/board/alpha/artifacts?limit=10", 200)
	require.EqualValues(t, 1, builds.Load())
	now = now.Add(teamItemsTTL + time.Second) // a writer that forgot to note a change is still shown within the TTL
	getTeamArtifacts(t, srv, "/api/board/alpha/artifacts?limit=10", 200)
	require.EqualValues(t, 2, builds.Load(), "past the TTL the list is built again")
}
