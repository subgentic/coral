package routes

import (
	"context"
	"encoding/json"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/tracking"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestQuietOlderVersionSettlementIsSupersededAndNotAnInboxIgnore(t *testing.T) {
	sink := captureAnalytics(t)
	e := newReviewEnv(t, true)
	seedNewerReview(t, e, "alpha")
	e.tag(t, `["for review","read","changes requested","saved","custom"]`)
	code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"ignore","quiet":true}`)
	require.Equal(t, 200, code, out)
	tags, err := e.h.bs.ArtifactTags(context.Background(), "alpha")
	require.NoError(t, err)
	require.Contains(t, tags[e.id], "superseded")
	for _, tag := range []string{"ignored", "for review", "changes requested", "saved", "read"} {
		require.NotContains(t, tags[e.id], tag)
	}
	require.Contains(t, tags[e.id], "custom")
	reviews, err := e.h.bs.ArtifactReviews(context.Background(), "alpha")
	require.NoError(t, err)
	require.Equal(t, "superseded", reviews[e.id].State)
	require.Empty(t, e.messages(t))
	activity, err := e.h.bs.ListActivity(context.Background(), board.ActivityFilter{})
	require.NoError(t, err)
	require.Len(t, activity, 1)
	require.Equal(t, board.ActSupersede, activity[0].Action)
	check, err := e.h.bs.VerifyActivity(context.Background())
	require.NoError(t, err)
	require.True(t, check.Intact)
	sink.none(t, tracking.EventInboxItemActioned)
	code, out = e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"ignore","quiet":true}`)
	require.Equal(t, 409, code, out)
	require.Equal(t, "not_for_review", out["code"])
	e.tag(t, `["for review"]`)
	code, out = e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"ignore"}`)
	require.Equal(t, 200, code, out)
	events := sink.wait(t, tracking.EventInboxItemActioned, 1)
	require.Len(t, events, 1)
	require.Equal(t, "ignore", events[0]["action"])
}

func TestQuietSettlementStillRequiresPersonAndOnlyAppliesToIgnore(t *testing.T) {
	e := newReviewEnv(t, false)
	e.tag(t, `["for review"]`)
	code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"ignore","quiet":true}`)
	require.Equal(t, 403, code, out)
	e = newReviewEnv(t, true)
	e.tag(t, `["for review"]`)
	for _, decision := range []string{"approve", "deny", "changes", "save", "unignore"} {
		code, out = e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"`+decision+`","quiet":true}`)
		require.Equal(t, 400, code, out)
	}
}

func TestQuietSettlementRefusesTheOnlyOrNewestVersion(t *testing.T) {
	e := newReviewEnv(t, true)
	e.tag(t, `["for review"]`)
	code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"ignore","quiet":true}`)
	require.Equal(t, 409, code, out)
	require.Equal(t, "not_older_version", out["code"])
	tags, err := e.h.bs.ArtifactTags(context.Background(), "alpha")
	require.NoError(t, err)
	require.Contains(t, tags[e.id], "for review")
}

func seedNewerReview(t *testing.T, e *reviewEnv, newBoard string) string {
	t.Helper()
	newer := storeManagedArtifact(t, e.h.coralDir, "# newer plan", true, true)
	completeWithArtifactsAs(t, e.h, "alpha", "Alice", "new version", []board.TaskArtifact{{Name: e.name, URI: "coral://artifacts/" + newer}})
	sid := strings.Repeat("5e", 16)
	dir := uploadsDir(e.h.coralDir, sessAlice)
	require.NoError(t, os.MkdirAll(dir, 0700))
	for i, id := range []string{e.id, newer} {
		b := "alpha"
		if i == 1 {
			b = newBoard
		}
		rec, _ := json.Marshal(agentUploadRecord{Board: b, SeriesID: sid, Version: i + 1, agentArtifactMeta: agentArtifactMeta{Name: e.name, Digest: id}})
		require.NoError(t, os.WriteFile(filepath.Join(dir, id+".json"), rec, 0600))
	}
	require.NoError(t, writeSeriesIndex(e.h.coralDir, seriesIndex{ID: sid, Board: "alpha", Versions: []seriesVersionRow{{Digest: e.id, N: 1, Session: sessAlice}, {Digest: newer, N: 2, Session: sessAlice}}}))
	require.NoError(t, e.h.bs.SetArtifactTags(context.Background(), "alpha", newer, []string{"for review"}))
	return newer
}

func TestQuietSettlementRequiresNewerVerifiedVersionOnTheSameTeam(t *testing.T) {
	for _, state := range []string{"pending", board.ReviewApproved, board.ReviewDenied} {
		t.Run(state, func(t *testing.T) {
			e := newReviewEnv(t, true)
			e.tag(t, `["for review"]`)
			newer := seedNewerReview(t, e, "alpha")
			if state != "pending" {
				_, _, err := e.h.bs.DecideArtifactReview(context.Background(), "alpha", newer, state, time.Now())
				require.NoError(t, err)
			}
			code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"ignore","quiet":true}`)
			require.Equal(t, 200, code, out)
			if state == "pending" {
				code, out = e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+newer+"/review", `{"decision":"approve"}`)
				require.Equal(t, 200, code, out)
			}
		})
	}
	for _, scenario := range []string{"newest", "other team", "not a review", "unverified index"} {
		t.Run(scenario, func(t *testing.T) {
			e := newReviewEnv(t, true)
			e.tag(t, `["for review"]`)
			b := "alpha"
			if scenario == "other team" {
				b = "beta"
			}
			newer := seedNewerReview(t, e, b)
			target := e.id
			if scenario == "newest" {
				target = newer
			}
			if scenario == "not a review" {
				require.NoError(t, e.h.bs.SetArtifactTags(context.Background(), "alpha", newer, []string{"custom"}))
			}
			if scenario == "unverified index" {
				require.NoError(t, os.Remove(filepath.Join(uploadsDir(e.h.coralDir, sessAlice), newer+".json")))
			}
			code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+target+"/review", `{"decision":"ignore","quiet":true}`)
			require.Equal(t, 409, code, out)
			require.Equal(t, "not_older_version", out["code"])
			tags, err := e.h.bs.ArtifactTags(context.Background(), "alpha")
			require.NoError(t, err)
			require.Contains(t, tags[target], "for review")
		})
	}
}
