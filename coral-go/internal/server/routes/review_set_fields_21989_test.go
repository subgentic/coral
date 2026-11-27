package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
)

// #21989: the goal list says how many open comment threads each goal has (comments_open), and the artifact list carries the latest Request-changes note (review_note). Both are reads that mark nothing seen.

func TestTheGoalListCountsOpenCommentThreadsPerGoalAndMarksNothingSeen(t *testing.T) {
	h, bs := operatorAsksRig(t)
	_, _, _, ss := setupSessionsTestServerWithConfig(t, config.Load(t.TempDir()))
	ctx := context.Background()
	mk := func(title string) *board.Goal {
		g, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: title, CreatedBy: "Lead"})
		require.NoError(t, err)
		return g
	}
	a, b, c := mk("A"), mk("B"), mk("C")
	owner := func(key, body string, parent *int64) store.ArtifactComment {
		cm, err := ss.CreateArtifactComment(ctx, store.ArtifactComment{ArtifactID: key, Board: "team", ParentID: parent, AnchorJSON: `{"whole":true}`, Body: body, AuthorIssuer: "local", AuthorSubject: "me", AuthorName: "Op", AuthorKind: "owner"})
		require.NoError(t, err)
		return cm
	}
	ka, kb := goalSubject("team", a.ID), goalSubject("team", b.ID)
	t1 := owner(ka, "one", nil)
	owner(ka, "two", nil)
	t3 := owner(ka, "three (resolved)", nil)
	t4 := owner(ka, "four (deleted)", nil)
	owner(kb, "b one", nil)
	_, _, err := ss.SetArtifactCommentResolved(ctx, ka, t3.ID, true, "local", "me")
	require.NoError(t, err)
	_, err = ss.DeleteArtifactComment(ctx, ka, t4.ID)
	require.NoError(t, err)
	_, err = ss.CreateArtifactComment(ctx, store.ArtifactComment{ArtifactID: ka, Board: "team", ParentID: &t1.ID, Body: "a reply", AuthorIssuer: "x", AuthorSubject: "agent", AuthorName: "Dev", AuthorKind: "agent"})
	require.NoError(t, err)
	h.SetGoalThreads(ss.OpenGoalThreads)
	h.SetCommentNews(func(ctx context.Context) (map[string]int, error) {
		rs, err := ss.UnseenAgentReplies(ctx)
		m := map[string]int{}
		for _, r := range rs {
			m[r.ArtifactID] += r.Count
		}
		return m, err
	})

	person := chi.NewRouter()
	person.Get("/api/board/{project}/goals", func(w http.ResponseWriter, req *http.Request) { h.ListGoals(w, asPerson(req)) })
	anyone := chi.NewRouter()
	anyone.Get("/api/board/{project}/goals", h.ListGoals)
	ps, as := httptest.NewServer(person), httptest.NewServer(anyone)
	t.Cleanup(ps.Close)
	t.Cleanup(as.Close)
	rows := func(srv string) map[int64]map[string]any {
		resp, err := http.Get(srv + "/api/board/team/goals")
		require.NoError(t, err)
		defer resp.Body.Close()
		var out struct {
			Goals []map[string]any `json:"goals"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		m := map[int64]map[string]any{}
		for _, g := range out.Goals {
			m[int64(g["id"].(float64))] = g
		}
		return m
	}

	before, err := ss.UnseenAgentReplies(ctx)
	require.NoError(t, err)
	require.Len(t, before, 1, "the agent's reply is unseen news")
	got := rows(ps.URL)
	assert.EqualValues(t, 2, got[a.ID]["comments_open"], "two open: the resolved and the deleted thread do not count")
	assert.EqualValues(t, 1, got[b.ID]["comments_open"])
	assert.Nil(t, got[c.ID]["comments_open"], "a goal with none has no field")
	assert.EqualValues(t, 1, got[a.ID]["new_comments"], "and the unseen reply is still unseen after the read")
	after, err := ss.UnseenAgentReplies(ctx)
	require.NoError(t, err)
	assert.Equal(t, before, after, "a goal-list read marks nothing seen")
	assert.Nil(t, rows(as.URL)[a.ID]["comments_open"], "an agent's or guest's list has no count")
}

func TestAFileWithChangesRequestedCarriesTheLatestNoteAndAnApprovedOneDoesNot(t *testing.T) {
	c := newChangesEnv(t)
	c.h.SetReviewNotes(func(ctx context.Context) (map[string]string, error) {
		return c.ss.LatestChangeNotes(ctx, ChangeWordsPrefix)
	})
	list := func() map[string]any {
		r := chi.NewRouter()
		r.Get("/api/board/{project}/artifacts", func(w http.ResponseWriter, req *http.Request) { c.h.ListTeamArtifacts(w, asPerson(req)) })
		s := httptest.NewServer(r)
		defer s.Close()
		resp, err := http.Get(s.URL + "/api/board/alpha/artifacts")
		require.NoError(t, err)
		defer resp.Body.Close()
		var out struct {
			Artifacts []map[string]any `json:"artifacts"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		for _, a := range out.Artifacts {
			if a["id"] == c.id {
				return a
			}
		}
		t.Fatalf("artifact not listed")
		return nil
	}
	assert.Nil(t, list()["review_note"], "no decision, no note")
	code, out := c.changes(t, `{"decision":"changes","text":"Use 5,000 rows per batch."}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, "Use 5,000 rows per batch.", list()["review_note"])
	_, err := c.ss.CreateArtifactComment(context.Background(), store.ArtifactComment{ArtifactID: c.id, Board: "alpha", AnchorJSON: `{"whole":true}`, Body: changeWordsPrefix + strings.Repeat("x", 800), AuthorIssuer: "local", AuthorSubject: "install-owner-id", AuthorName: "Op", AuthorKind: "owner"})
	require.NoError(t, err)
	n, _ := list()["review_note"].(string)
	assert.Len(t, []rune(n), reviewNoteCap+1, "the newest note, cut at the cap (and an ellipsis)")
	code, out = c.changes(t, `{"decision":"approve"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.Nil(t, list()["review_note"], "an approved file carries none")
}
