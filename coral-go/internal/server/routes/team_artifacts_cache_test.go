package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
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

// The kept list is the team's own: what depends on the caller is applied to a copy for each request. An agent, a Hub guest and the owner each read the list from the one kept build, in either order, and no one
// gets another's view: an agent only what it may read, a guest nothing private or from another board, and the private marks only on the owner's copy.
func TestKeptListIsNeverAnotherCallersView(t *testing.T) {
	ids := func(in []teamArtifact) map[string]bool {
		out := map[string]bool{}
		for _, it := range in {
			out[it.ID] = true
		}
		return out
	}
	anyPrivate := func(in []teamArtifact) bool {
		for _, it := range in {
			if it.Private {
				return true
			}
		}
		return false
	}

	t.Run("an agent and the owner, either order", func(t *testing.T) {
		for _, ownerFirst := range []bool{true, false} {
			_, h, coralDir := teamArtifactServer(t)
			w := &world{sessions: map[string]string{"a1": "alpha", "b1": "beta"}, owners: map[string]artifactPrincipal{"alpha": hubOwner(aliceUser), "beta": hubOwner(bobUser)}}
			useCircle(t, w.circle())
			userA, _, err := storeArtifactBy(coralDir, "a1", "alice.md", "text/markdown", "", "", []byte("# alice\n"))
			require.NoError(t, err)
			userB, _, err := storeArtifactBy(coralDir, "b1", "bob.md", "text/markdown", "", "", []byte("# bob\n"))
			require.NoError(t, err)
			subscribeSession(t, h, "alpha", "Alice", "a1")
			subscribeSession(t, h, "alpha", "Bob", "b1") // both uploaded to this board's folder set: the kept list holds both rows
			require.NoError(t, h.bs.SetArtifactPrivate(context.Background(), userA, true, "Operator"))
			time.Sleep(uploadDirSettle + 300*time.Millisecond)
			owner := func() []teamArtifact {
				items, _, err := h.projectArtifactItems(httptest.NewRequest(http.MethodGet, "/x", nil), "alpha", "")
				require.NoError(t, err)
				return items
			}
			agent := func(sid string) []teamArtifact {
				req := httptest.NewRequest(http.MethodGet, "/x", nil)
				req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sid}))
				items, _, err := h.projectArtifactItems(req, "alpha", "")
				require.NoError(t, err)
				return items
			}
			builds := countBuilds(t)
			check := func() {
				o := owner()
				require.True(t, ids(o)[userA] && ids(o)[userB], "the owner reads both rows")
				require.True(t, anyPrivate(o), "the owner sees the private mark")
				a := agent("a1")
				require.False(t, ids(a)[userB], "alice's agent does not get bob's file")
				require.False(t, anyPrivate(a), "an agent never gets a private mark")
				b := agent("b1")
				require.False(t, ids(b)[userA], "bob's agent does not get alice's file")
				require.False(t, anyPrivate(b), "an agent never gets a private mark")
			}
			if ownerFirst {
				check()
			} else {
				_ = agent("a1")
				check()
			}
			check() // and again: what the first caller's copy had done to the kept list shows in no later one
			require.EqualValues(t, 1, builds.Load(), "all of it from one build")
		}
	})

	t.Run("a Hub guest and the owner, either order", func(t *testing.T) {
		for _, ownerFirst := range []bool{true, false} {
			_, h, coralDir := teamArtifactServer(t)
			prev := artifactCircle
			w := &world{sessions: map[string]string{"s-a": gaBoard}, owners: map[string]artifactPrincipal{gaBoard: hubOwner(aliceUser)}}
			circle := w.circle()
			circle.PrivateArtifacts = h.bs.PrivateArtifacts // the guide's read check asks the store which files are private
			SetArtifactCircle(circle)
			t.Cleanup(func() { SetArtifactCircle(prev) })
			record := func(id string) {
				dir := uploadsDir(coralDir, "s-a")
				require.NoError(t, os.MkdirAll(dir, 0o755))
				b, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "f", MediaType: "text/plain", Size: 4, Digest: id}, CreatedAt: time.Now().UTC().Format(time.RFC3339), Board: gaBoard})
				require.NoError(t, os.WriteFile(filepath.Join(dir, id+".json"), b, 0o644))
			}
			record(gaMine)
			record(gaPrivate)
			subscribeSession(t, h, gaBoard, "Ann", "s-a")
			require.NoError(t, h.bs.SetArtifactPrivate(context.Background(), gaPrivate, true, "Operator"))
			time.Sleep(uploadDirSettle + 300*time.Millisecond)
			guest := func() []teamArtifact {
				req := httptest.NewRequest(http.MethodGet, "/x", nil)
				for k, v := range gaGuide(gaDana) {
					req.Header.Set(k, v)
				}
				items, _, err := h.projectArtifactItems(req, gaBoard, "")
				require.NoError(t, err)
				return items
			}
			owner := func() []teamArtifact {
				items, _, err := h.projectArtifactItems(httptest.NewRequest(http.MethodGet, "/x", nil), gaBoard, "")
				require.NoError(t, err)
				return items
			}
			check := func() {
				o := owner()
				require.True(t, ids(o)[gaMine] && ids(o)[gaPrivate], "the owner reads this board's files, the private one too: %v", ids(o))
				require.True(t, anyPrivate(o), "the owner sees the private mark")
				g := guest()
				require.True(t, ids(g)[gaMine], "the guest reads this board's file: %v", ids(g))
				require.False(t, ids(g)[gaPrivate], "the guest does not get the private file, not even as a row")
				require.False(t, anyPrivate(g), "the guest never gets a private mark")
			}
			if ownerFirst {
				check()
			} else {
				_ = guest()
				check()
			}
			check()
		}
	})
}
