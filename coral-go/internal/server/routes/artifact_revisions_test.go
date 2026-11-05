package routes

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
)

func requireArtifactRevisionMoves(t *testing.T, bs *board.Store, team string, write func()) {
	t.Helper()
	before, all := bs.ArtifactsRevision(team), bs.ArtifactsRevision("")
	write()
	require.Greater(t, bs.ArtifactsRevision(team), before)
	require.Greater(t, bs.ArtifactsRevision(""), all)
}

func TestArtifactRevisionFollowsFilesystemWriters(t *testing.T) {
	_, h, dir := teamArtifactServer(t)
	old := uploaderLookup
	uploaderLookup = func(context.Context, string) (string, string, string) { return "alpha", "Dev", "worker" }
	t.Cleanup(func() { uploaderLookup = old })
	// This is also the path used by pasted images and auto-attached files.
	requireArtifactRevisionMoves(t, h.bs, "alpha", func() {
		_, _, err := storeArtifact(dir, "session-one", "one.md", "text/markdown", []byte("one"))
		require.NoError(t, err)
	})
	requireArtifactRevisionMoves(t, h.bs, "alpha", func() {
		require.NoError(t, h.writeCrossTeamRecord("shared", crossTeamArtifactRecord{ID: fmt.Sprintf("%064x", 1), Board: "alpha", Name: "shared.md"}))
	})
	requireArtifactRevisionMoves(t, h.bs, "alpha", func() {
		require.NoError(t, h.writeCrossTeamRecord("received", crossTeamArtifactRecord{ID: fmt.Sprintf("%064x", 2), Board: "alpha", Name: "received.md"}))
	})
}

func TestArtifactRevisionFollowsOperatorUpload(t *testing.T) {
	e := newShareEnv(t, true)
	requireArtifactRevisionMoves(t, e.h.bs, "alpha", func() {
		code, out := e.upload(t, sessAlice, "revision.md", "revision upload")
		require.Equal(t, http.StatusCreated, code, out)
	})
}

func TestArtifactRevisionFollowsCommentsAndUnread(t *testing.T) {
	r := newCmtRig(t)
	r.agent(1, "Dev", false)
	var id int64
	requireArtifactRevisionMoves(t, r.h.bs, "team-a", func() { id = r.ownerComment("Please check this") })
	path := fmt.Sprintf("%s/%d", cp(cmtDoc), id)
	for _, step := range []struct {
		method, path string
		body         any
	}{
		{"PATCH", path, map[string]any{"body": "Please check the revision"}},
		{"POST", path + "/resolve", nil}, {"POST", path + "/reopen", nil},
	} {
		t.Run(step.method+step.path, func(t *testing.T) {
			requireArtifactRevisionMoves(t, r.h.bs, "team-a", func() {
				code, out := r.do(step.method, step.path, cmtAsOwner, step.body)
				require.Equal(t, 200, code, out)
			})
		})
	}
	_, out := r.send(id, "Dev")
	require.Equal(t, "sent", states(out)["Dev"])
	requireArtifactRevisionMoves(t, r.h.bs, "team-a", func() { code, out := r.reply(id, asAgentSession(1), "Checked"); require.Equal(t, 201, code, out) })
	requireArtifactRevisionMoves(t, r.h.bs, "team-a", func() { code, out := r.do("GET", cp(cmtDoc), cmtAsOwner, nil); require.Equal(t, 200, code, out) })
	requireArtifactRevisionMoves(t, r.h.bs, "team-a", func() { code, out := r.do("DELETE", path, cmtAsOwner, nil); require.Equal(t, 200, code, out) })
}

func TestArtifactRevisionFeedAndAgentScope(t *testing.T) {
	tick := &wsTick{artifactsRev: map[string]uint64{"alpha": 12, "beta": 34, "": 45}, artifactsJSON: `{"":45,"alpha":12,"beta":34}`}
	f := coralFeed{firstMessage: true}
	packet, _ := f.frame(tick, nil, nil, nil, time.Time{}, 0)
	require.Equal(t, tick.artifactsRev, packet["artifacts_rev"])
	// An unknown agent must not learn other boards from their revision keys.
	scoped := scopeTickForAgent(tick, "unknown")
	require.Empty(t, scoped.artifactsRev)
	f.firstMessage = false
	packet, _ = f.frame(tick, nil, nil, nil, time.Time{}, 0)
	require.Equal(t, tick.artifactsRev, packet["artifacts_rev"], "a revision-only change emits a diff")
}

func TestArtifactRevisionFollowsObjectActions(t *testing.T) {
	r := newCmtRig(t)
	// One digest can appear on another team's list, so object-wide actions must
	// invalidate that list as well as the team that uploaded it.
	for _, step := range []struct{ method, path string }{
		{"PUT", "/star"}, {"DELETE", "/star"}, {"PUT", "/keep"}, {"DELETE", "/keep"}, {"DELETE", ""},
	} {
		t.Run(step.method+step.path, func(t *testing.T) {
			requireArtifactRevisionMoves(t, r.h.bs, "other-team", func() {
				code, out := r.do(step.method, "/api/artifacts/"+cmtDoc+step.path, cmtAsOwner, nil)
				require.Equal(t, 200, code, out)
			})
		})
	}
}

func TestArtifactRevisionReadContracts(t *testing.T) {
	srv, h, dir := teamArtifactServer(t)
	_, err := h.bs.Subscribe(context.Background(), "alpha", "Dev", "worker", "revision-session", nil, "")
	require.NoError(t, err)
	old := uploaderLookup
	uploaderLookup = func(context.Context, string) (string, string, string) { return "alpha", "Dev", "worker" }
	t.Cleanup(func() { uploaderLookup = old })
	_, _, err = storeArtifact(dir, "revision-session", "contract.md", "text/markdown", []byte("contract"))
	require.NoError(t, err)
	for _, path := range []string{"/api/board/alpha/artifacts", "/api/board/alpha/artifacts?tag=draft", "/api/team-artifacts"} {
		resp, err := http.Get(srv.URL + path)
		require.NoError(t, err)
		var body map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
		resp.Body.Close()
		require.Equal(t, 200, resp.StatusCode, body)
		require.NotZero(t, body["artifacts_rev"], path)
	}
	r := newCmtRig(t)
	mux := chi.NewRouter()
	mux.Get("/api/board/{project}/status", r.h.TeamAvailability)
	req := httptest.NewRequest("GET", "/api/board/team-a/status", nil)
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	require.Equal(t, 200, out.Code, out.Body.String())
	var body map[string]any
	require.NoError(t, json.Unmarshal(out.Body.Bytes(), &body))
	require.Equal(t, float64(r.h.bs.ArtifactsRevision("team-a")), body["artifacts_rev"])
	require.Equal(t, float64(r.h.bs.ArtifactsRevision("")), body["artifacts_all_rev"])
}

func TestArtifactRevisionFollowsPrune(t *testing.T) {
	r := newPruneRig(t)
	r.object("old unreferenced revision object", "orphan-session", 72*time.Hour)
	requireArtifactRevisionMoves(t, r.bs, "observed-team", func() {
		rep := r.run(pruneOptions{OlderThan: 48 * time.Hour, Kinds: kinds(pruneKindObjects)})
		require.Positive(t, rep.Removed)
	})
}

func TestArtifactRevisionFollowsBoardSettings(t *testing.T) {
	e := newArtifactEnv(t)
	requireArtifactRevisionMoves(t, e.h.bs, "beta", func() { e.open() })
}

func TestArtifactRevisionFollowsPersistedTaskDiff(t *testing.T) {
	_, h, dir := teamArtifactServer(t)
	h.SetTaskArtifactWriter(dir, func(_ context.Context, _ *board.Task, path string) error {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		return os.WriteFile(path, []byte("diff --git a/a b/a"), 0600)
	})
	session := "revision-session"
	requireArtifactRevisionMoves(t, h.bs, "alpha", func() {
		h.persistTaskArtifact(context.Background(), &board.Task{ID: 1, BoardID: "alpha", SessionID: &session})
	})
}

func TestCommentPollOnlyInvalidatesArtifactsWhenUnreadRepliesChange(t *testing.T) {
	r := newCmtRig(t)
	r.agent(1, "Dev", false)
	id := r.ownerComment("Please check this")
	poll := func() { code, out := r.do("GET", cp(cmtDoc), cmtAsOwner, nil); require.Equal(t, 200, code, out) }
	before, all := r.h.bs.ArtifactsRevision("team-a"), r.h.bs.ArtifactsRevision("")
	poll()
	require.Equal(t, before, r.h.bs.ArtifactsRevision("team-a"), "a thread without unread replies must not invalidate artifact lists")
	require.Equal(t, all, r.h.bs.ArtifactsRevision(""))
	_, out := r.send(id, "Dev")
	require.Equal(t, "sent", states(out)["Dev"])
	code, out := r.reply(id, asAgentSession(1), "Checked")
	require.Equal(t, 201, code, out)
	requireArtifactRevisionMoves(t, r.h.bs, "team-a", poll)
	before, all = r.h.bs.ArtifactsRevision("team-a"), r.h.bs.ArtifactsRevision("")
	for i := 0; i < 3; i++ {
		poll()
	}
	require.Equal(t, before, r.h.bs.ArtifactsRevision("team-a"), "unchanged comment polls must preserve the board token")
	require.Equal(t, all, r.h.bs.ArtifactsRevision(""), "and the aggregate token")
}

func TestUploadMetadataAfterRecordMakesAnInterveningListStale(t *testing.T) {
	rig, _ := ownerRig(t)
	base := rig.uploadText("a1", "plan.txt", "first revision before series metadata")
	text := "second revision awaiting series metadata"
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(text)))
	recordPath := filepath.Join(uploadsDir(rig.coralDir, "a1"), digest+".json")
	reached, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var paused, unblocked sync.Once
	unblock := func() { unblocked.Do(func() { close(release) }) }
	oldLookup := uploaderLookup
	// Both the deferred-notification lookup and the later series-review check
	// reach this seam. Thus removing the defer cannot remove the synchronization.
	uploaderLookup = func(ctx context.Context, sid string) (string, string, string) {
		b, n, r := oldLookup(ctx, sid)
		if sid == "a1" {
			if _, err := os.Stat(recordPath); err == nil {
				stop := false
				paused.Do(func() { stop = true; close(reached) })
				if stop {
					<-release
				}
			}
		}
		return b, n, r
	}
	t.Cleanup(func() { uploaderLookup = oldLookup })
	bh := NewBoardHandler(rig.h.bs)
	bh.SetTaskArtifactWriter(rig.coralDir, nil)
	subscribeSession(t, bh, "team-a", "a1", "a1")
	router := chi.NewRouter()
	router.Get("/api/board/{project}/artifacts", bh.ListTeamArtifacts)
	readList := func() (uint64, int) {
		req := httptest.NewRequest("GET", "/api/board/team-a/artifacts", nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		out := httptest.NewRecorder()
		router.ServeHTTP(out, req)
		require.Equal(t, 200, out.Code, out.Body.String())
		var body struct {
			Revision uint64         `json:"artifacts_rev"`
			Items    []teamArtifact `json:"artifacts"`
		}
		require.NoError(t, json.Unmarshal(out.Body.Bytes(), &body))
		for _, item := range body.Items {
			if artifactStoreID(item) == base {
				return body.Revision, item.Versions
			}
		}
		t.Fatal("base artifact is missing from the list")
		return 0, 0
	}
	before := rig.h.bs.ArtifactsRevision("team-a")
	req := httptest.NewRequest("POST", "/api/agent/artifacts?session_id=a1", strings.NewReader(text))
	req.Header.Set(testAgentHeader, "a1")
	req.Header.Set("X-Artifact-Name", "plan.txt")
	req.Header.Set("X-Artifact-Media-Type", "text/plain")
	req.Header.Set(seriesHeader, "coral://artifacts/"+base)
	out := httptest.NewRecorder()
	go func() { rig.srv.Config.Handler.ServeHTTP(out, req); close(done) }()
	defer func() {
		unblock()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("upload did not finish after releasing the metadata barrier")
		}
	}()
	select {
	case <-reached:
	case <-done:
		t.Fatalf("upload returned before the record barrier: %d %s", out.Code, out.Body.String())
	case <-time.After(5 * time.Second):
		t.Fatal("upload never reached the post-record barrier")
	}
	middle, versions := readList()
	require.Greater(t, middle, before, "the upload record already advanced the revision")
	require.Zero(t, versions, "the list ran before the base artifact was stamped into the series")
	unblock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not finish")
	}
	require.Equal(t, http.StatusCreated, out.Code, out.Body.String())
	after, versions := readList()
	require.Equal(t, 2, versions, "series metadata landed after the intervening list")
	require.Greater(t, after, middle, "handler completion must invalidate the pre-metadata list, beyond the record-write notification")
}
