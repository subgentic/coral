package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/redact"
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

// The kept list is handed to a request as it is (no copy per page: a walk of 20,000 rows copied them for every page), so no request may write to it. Every way of reading it runs here, one after the other, and the
// kept rows are the same after all of them: the owner's two query paths, a filtered and a sorted one, a Hub owner (whose rows the query redacts in place), a guest and an agent. And the list a caller gets from
// projectArtifactItems is its own: it changes every field of it and reads again.
func TestNoRequestCanChangeTheKeptList(t *testing.T) {
	_, h, coralDir := teamArtifactServer(t)
	prev := artifactCircle
	w := &world{sessions: map[string]string{"s-a": gaBoard, "a1": gaBoard}, owners: map[string]artifactPrincipal{gaBoard: hubOwner(aliceUser)}}
	circle := w.circle()
	circle.PrivateArtifacts = h.bs.PrivateArtifacts
	SetArtifactCircle(circle)
	t.Cleanup(func() { SetArtifactCircle(prev) })
	ctx := context.Background()
	record := func(id string) {
		dir := uploadsDir(coralDir, "s-a")
		require.NoError(t, os.MkdirAll(dir, 0o755))
		b, _ := json.Marshal(agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: "file-" + id[:4] + ".md", MediaType: "text/markdown", Size: 4, Digest: id}, CreatedAt: time.Now().UTC().Format(time.RFC3339), Board: gaBoard})
		require.NoError(t, os.WriteFile(filepath.Join(dir, id+".json"), b, 0o644))
	}
	record(gaMine)
	record(gaPrivate)
	subscribeSession(t, h, gaBoard, "Ann", "s-a")
	require.NoError(t, h.bs.SetArtifactPrivate(ctx, gaPrivate, true, "Operator"))
	require.NoError(t, h.bs.SetArtifactTags(ctx, gaBoard, gaMine, []string{"for review", "notes"}))
	require.NoError(t, h.bs.SetArtifactTags(ctx, gaBoard, gaPrivate, []string{"for review"}))
	_, err := h.bs.SetArtifactKind(ctx, gaBoard, gaMine, board.KindRelease, "sess", time.Now())
	require.NoError(t, err)
	withLabel(t, ownerLabel, nil)
	time.Sleep(uploadDirSettle + 300*time.Millisecond)

	serve := func(wrap func(*http.Request) *http.Request) *httptest.Server {
		r := chi.NewRouter()
		r.Get("/api/board/{project}/artifacts", func(rw http.ResponseWriter, rq *http.Request) { h.ListTeamArtifacts(rw, wrap(rq)) })
		s := httptest.NewServer(r)
		t.Cleanup(s.Close)
		return s
	}
	withHeaders := func(hdr map[string]string) func(*http.Request) *http.Request {
		return func(rq *http.Request) *http.Request {
			for k, v := range hdr {
				rq.Header.Set(k, v)
			}
			return rq
		}
	}
	callers := map[string]*httptest.Server{
		"owner":     serve(asPerson),
		"hub owner": serve(withHeaders(ownerHeaders(ownerLabel))),
		"guest":     serve(withHeaders(gaGuide(gaDana))),
		"agent": serve(func(rq *http.Request) *http.Request {
			return rq.WithContext(context.WithValue(rq.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "a1"}))
		}),
	}
	queries := []string{"", "?limit=1", "?limit=1&offset=1", "?tag=for%20review&limit=1", "?q=file&limit=5", "?sort=name&limit=5", "?kind=release", "?versions=newest&limit=5"}

	snapshot := func() string {
		h.itemsCache.mu.Lock()
		defer h.itemsCache.mu.Unlock()
		require.Len(t, h.itemsCache.entries, 1, "one kept list for this board")
		raw, err := json.Marshal(h.itemsCache.entries[0].items)
		require.NoError(t, err)
		var managed []string
		for _, it := range h.itemsCache.entries[0].items {
			managed = append(managed, it.managed)
		}
		return string(raw) + "|" + strings.Join(managed, ",")
	}
	origRedactor := shownRedactor // a Hub viewer's rows are redacted in place by the query: with a redactor that hides every text, a write to the kept rows shows at once
	shownRedactor = func() redact.Redactor { return redact.Refuse }
	t.Cleanup(func() { shownRedactor = origRedactor })
	getTeamArtifacts(t, callers["owner"], "/api/board/"+gaBoard+"/artifacts", 200) // builds the kept list
	before := snapshot()
	require.Contains(t, before, gaMine)
	for name, srv := range callers {
		for _, q := range queries {
			resp, err := http.Get(srv.URL + "/api/board/" + gaBoard + "/artifacts" + q)
			require.NoError(t, err)
			resp.Body.Close()
			require.Equal(t, before, snapshot(), "%s %s changed the kept list", name, q)
		}
	}

	// the list a caller gets is its own: every field written, then read again
	ownerReq := func() *http.Request { return asPerson(httptest.NewRequest(http.MethodGet, "/x", nil)) }
	first, _, err := h.projectArtifactItems(ownerReq(), gaBoard, "")
	require.NoError(t, err)
	wasJSON, _ := json.Marshal(first)
	for i := range first {
		first[i].Name, first[i].Private, first[i].Kind, first[i].NewComments = "changed", !first[i].Private, "changed", 99
		if len(first[i].Tags) > 0 {
			first[i].Tags[0] = "changed"
		}
		if first[i].Size != nil {
			*first[i].Size = 12345
		}
	}
	again, _, err := h.projectArtifactItems(ownerReq(), gaBoard, "")
	require.NoError(t, err)
	againJSON, _ := json.Marshal(again)
	require.JSONEq(t, string(wasJSON), string(againJSON), "a caller that changes its list changes nothing for the next")
	require.Equal(t, before, snapshot())
}

// The task writers whose saves change what the list shows of a task (its review files, its title) note the board's revision, so the kept list is built again after them (Backend Dev's SHOULD on #13522).
func TestTeamArtifactsListShowsTheTaskWritersOnTheNextRead(t *testing.T) {
	srv, h, coralDir := teamArtifactServer(t)
	ctx := context.Background()
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	writeUpload(t, coralDir, sessAlice, "# first\n", "first.md", "2026-10-09T10:00:00Z")
	time.Sleep(uploadDirSettle + 500*time.Millisecond)
	list := func() []teamArtifact {
		return getTeamArtifacts(t, srv, "/api/board/alpha/artifacts?limit=200", 200).Artifacts
	}
	byName := func(rows []teamArtifact, name string) *teamArtifact {
		for i := range rows {
			if rows[i].Name == name {
				return &rows[i]
			}
		}
		return nil
	}
	require.NotNil(t, byName(list(), "first.md"))
	task, err := h.bs.CreateTask(ctx, "alpha", "reviewed", "", "medium", "lead", "Alice")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "alpha", "Alice", task.ID)
	require.NoError(t, err)
	require.Nil(t, byName(list(), "review-candidate"))

	t.Run("a completion review submitted", func(t *testing.T) {
		_, err := h.bs.SubmitCompletionReview(ctx, "alpha", task.ID, "Alice", "msg", "success", "needs review", []board.TaskArtifact{{Name: "review-candidate", Content: "r"}})
		require.NoError(t, err)
		row := byName(list(), "review-candidate")
		require.NotNil(t, row, "a submitted review's file shows on the next read")
		require.Equal(t, "reviewed", row.TaskTitle)
	})
	t.Run("a task's title edited", func(t *testing.T) {
		title := "reviewed again"
		_, err := h.bs.EditTaskText(ctx, "alpha", task.ID, "lead", &title, nil, 0, 0)
		require.NoError(t, err)
		require.Equal(t, "reviewed again", byName(list(), "review-candidate").TaskTitle, "the new title is on the row of its file on the next read")
	})
	t.Run("a completion review released", func(t *testing.T) {
		_, err := h.bs.Subscribe(ctx, "alpha", "Lead", "Orchestrator", "claude-77777777-aaaa-0000-0000-000000000007", nil, "all")
		require.NoError(t, err)
		list()
		builds := countBuilds(t)
		list()
		require.EqualValues(t, 0, builds.Load(), "nothing changed: the kept list")
		_, err = h.bs.ReleaseCompletionReview(ctx, "alpha", task.ID, "Lead", "not needed")
		require.NoError(t, err)
		list()
		require.EqualValues(t, 1, builds.Load(), "releasing the review moves the revision: the list is built again")
	})
}

// The 5 s a kept list may live count from when its build started (when its data was read), not from when it was stored: a build that takes longer than the TTL leaves an entry that is already out of date (Backend Dev's SHOULD on #13522).
func TestTeamArtifactsListTTLCountsFromTheStartOfTheBuild(t *testing.T) {
	srv, h, coralDir := teamArtifactServer(t)
	subscribeSession(t, h, "alpha", "Alice", sessAlice)
	writeUpload(t, coralDir, sessAlice, "# one\n", "one.md", "2026-10-09T10:00:00Z")
	time.Sleep(uploadDirSettle + 500*time.Millisecond)
	now := time.Now()
	h.itemsCache.now = func() time.Time { return now }
	var n atomic.Int64
	old := teamItemsBuildHook
	teamItemsBuildHook = func() {
		if n.Add(1) == 1 {
			now = now.Add(teamItemsTTL + time.Second) // the first build is slow: it runs past the TTL
		}
	}
	t.Cleanup(func() { teamItemsBuildHook = old })
	getTeamArtifacts(t, srv, "/api/board/alpha/artifacts?limit=10", 200)
	getTeamArtifacts(t, srv, "/api/board/alpha/artifacts?limit=10", 200)
	require.EqualValues(t, 2, n.Load(), "the entry of a slow build was already past its TTL when it was stored: the next read builds again")
	getTeamArtifacts(t, srv, "/api/board/alpha/artifacts?limit=10", 200)
	require.EqualValues(t, 2, n.Load(), "and the fast build after it is kept")
}
