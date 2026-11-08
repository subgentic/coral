package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #14472 (QA review of #14440): two rules that were pinned at the board but not at the route. A mutant that hands the board no redactor ("(text withheld)" everywhere) or no Hub actor (a team's owner
// reads every owner's decisions) passed the route tests.

func (r *threadRig) reply(from, text string) {
	r.t.Helper()
	id := r.task.ID
	_, err := r.bs.PostMessageForTask(context.Background(), "alpha", from, text, nil, "", &id)
	require.NoError(r.t, err)
}

func replyTexts(out map[string]any) []string {
	var texts []string
	entries, _ := out["entries"].([]any)
	for _, e := range entries {
		m := e.(map[string]any)
		if m["kind"] == "reply" {
			texts = append(texts, m["text"].(string))
		}
	}
	return texts
}

func TestTheThreadAnswerShowsTheRealTextRedactedAtTheRouteAndWithholdsWhatItCannotClear(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	redactCommentFailsFor = func(text string) bool { return strings.Contains(text, "unredactable") }
	t.Cleanup(func() { redactCommentFailsFor = nil })
	r := newThreadRig(t)
	r.reply("Dev", "plain words from Dev")
	r.reply("Dev", "the key is sk-ant-api03-"+strings.Repeat("a", 60)+" ok")
	r.reply("Dev", "this one is unredactable")
	code, out := r.get(r.h.Thread, "/api/thread", q("team", "alpha", "task", itoa(r.task.ID)), person)
	require.Equal(t, http.StatusOK, code, "%v", out)
	texts := replyTexts(out)
	assert.Contains(t, texts, "plain words from Dev", "the route hands the board its redactor: a clean text is shown, not withheld")
	for _, x := range texts {
		assert.NotContains(t, x, "sk-ant-", "a secret is redacted before it is cut")
	}
	assert.Contains(t, texts, board.ThreadWithheld, "a text the redactor fails on is withheld")
	// the summaries too: the latest line is the real (redacted) text
	code, sums := r.get(r.h.Threads, "/api/threads", q("team", "alpha", "goal", itoa(r.goal.ID)), person)
	require.Equal(t, http.StatusOK, code, "%v", sums)
	assert.NotContains(t, asJSONString(sums), "sk-ant-")
}

func asJSONString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestTheThreadOfATeamsMachineShowsEachHubOwnerOnlyTheirOwnDecisions(t *testing.T) {
	resetOwnerState(t)
	withRecord(t, tunnel.OwnerKindTeam, teamOrgA, nil)
	withLabel(t, "", nil)
	r := newThreadRig(t)
	ctx := context.Background()
	for _, row := range []struct{ actor, source string }{{"hub:" + teamUIDA, "hub"}, {"hub:" + teamUIDB, "hub"}, {"local", "local"}} {
		require.NoError(t, r.bs.RecordActivity(ctx, board.ActivityMeta{Actor: row.actor, Source: row.source}, board.ActGoalEdit, "goal", itoa(r.goal.ID), "", "alpha"))
	}
	as := func(uid string) func(*http.Request) *http.Request {
		return func(req *http.Request) *http.Request {
			h := teamStamp(teamOrgA, "admin", uid, teamUser)
			for k := range h {
				req.Header.Set(k, h.Get(k))
			}
			actor, ok := actorFor(req, callerHub)
			require.True(t, ok)
			req = withActor(req, actor)
			return req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerHub))
		}
	}
	actors := func(out map[string]any) []string {
		var got []string
		entries, _ := out["entries"].([]any)
		for _, e := range entries {
			m := e.(map[string]any)
			if m["kind"] == "decision" {
				got = append(got, m["actor"].(string))
			}
		}
		return got
	}
	query := q("team", "alpha", "goal", itoa(r.goal.ID))
	code, a := r.get(r.h.Thread, "/api/thread", query, as(teamUIDA))
	require.Equal(t, http.StatusOK, code, "%v", a)
	assert.Equal(t, []string{"hub:" + teamUIDA}, actors(a), "the first owner reads their own decision alone")
	code, b := r.get(r.h.Thread, "/api/thread", query, as(teamUIDB))
	require.Equal(t, http.StatusOK, code, "%v", b)
	assert.Equal(t, []string{"hub:" + teamUIDB}, actors(b), "the second reads theirs alone")
	code, all := r.get(r.h.Thread, "/api/thread", query, person)
	require.Equal(t, http.StatusOK, code, "%v", all)
	assert.Len(t, actors(all), 3, "the person at the computer reads every decision")
	// and the summaries count only theirs
	code, sa := r.get(r.h.Threads, "/api/threads", q("team", "alpha"), as(teamUIDA))
	require.Equal(t, http.StatusOK, code, "%v", sa)
	assert.NotContains(t, asJSONString(sa), teamUIDB)
}
