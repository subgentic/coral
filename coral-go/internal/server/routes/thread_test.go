package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
)

// #14440 (Threading S3): GET /api/thread and GET /api/threads are the Operator's alone and strict about their keys, with the rules of Security's conditions on #14430 each pinned: owner only (an agent, a
// Hub grantee refused), team required, goal or task (not neither, not a bad number), closed sets for order and state, no unknown key, a team's ids found only in that team.

type threadRig struct {
	t    *testing.T
	h    *BoardHandler
	bs   *board.Store
	goal *board.Goal
	task *board.Task
}

func newThreadRig(t *testing.T) *threadRig {
	t.Helper()
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ctx := context.Background()
	goal, err := bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "Ship the importer", CreatedBy: "Lead"})
	require.NoError(t, err)
	task, err := bs.CreateTask(ctx, "alpha", "Write the importer", "", "medium", "Lead")
	require.NoError(t, err)
	gid := goal.ID
	require.NoError(t, bs.SetTaskGoal(ctx, "alpha", task.ID, &gid))
	return &threadRig{t: t, h: NewBoardHandler(bs), bs: bs, goal: goal, task: task}
}

func (r *threadRig) get(handler http.HandlerFunc, path string, query url.Values, mod func(*http.Request) *http.Request) (int, map[string]any) {
	r.t.Helper()
	req := httptest.NewRequest(http.MethodGet, path+"?"+query.Encode(), nil)
	if mod != nil {
		req = mod(req)
	}
	rec := httptest.NewRecorder()
	handler(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func person(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), callerKindKey{}, callerDashCookie))
}

func q(kv ...string) url.Values {
	v := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		v.Set(kv[i], kv[i+1])
	}
	return v
}

func TestTheThreadReadsAreTheOperatorsAloneAndAnAgentOrAGranteeIsRefused(t *testing.T) {
	resetOwnerState(t)
	withLabel(t, ownerLabel, nil)
	r := newThreadRig(t)
	query := q("team", "alpha", "task", itoa(r.task.ID))
	// the person at this computer
	code, out := r.get(r.h.Thread, "/api/thread", query, person)
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "task", out["thread"].(map[string]any)["kind"])
	code, out = r.get(r.h.Threads, "/api/threads", q("team", "alpha"), person)
	require.Equal(t, http.StatusOK, code, "%v", out)
	// an agent's token is refused on both reads, whatever its request
	asAgent := func(req *http.Request) *http.Request {
		const sid = "11111111-2222-4333-8444-555555555555"
		return person(req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sid, SessionName: "claude-" + sid})))
	}
	for name, fn := range map[string]func() (int, map[string]any){
		"thread":  func() (int, map[string]any) { return r.get(r.h.Thread, "/api/thread", query, asAgent) },
		"threads": func() (int, map[string]any) { return r.get(r.h.Threads, "/api/threads", q("team", "alpha"), asAgent) },
	} {
		code, out := fn()
		assert.Equal(t, http.StatusForbidden, code, "%s: %v", name, out)
		assert.Nil(t, out["entries"], name)
		assert.Nil(t, out["threads"], name)
		assert.Equal(t, readRefusal, out["error"], "%s: a read says it is a read that was refused (#15740)", name)
	}
	// a Coral Hub sign-in that is not the owner of this computer's link is refused too; the owner is served
	hub := func(headers map[string]string) func(*http.Request) *http.Request {
		return func(req *http.Request) *http.Request {
			for k, v := range headers {
				req.Header.Set(k, v)
			}
			actor, ok := actorFor(req, callerHub)
			require.True(t, ok)
			req = withActor(req, actor)
			return req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerHub))
		}
	}
	code, out = r.get(r.h.Thread, "/api/thread", query, hub(granteeHeaders()))
	assert.Equal(t, http.StatusForbidden, code, "%v", out)
	code, out = r.get(r.h.Threads, "/api/threads", q("team", "alpha"), hub(granteeHeaders()))
	assert.Equal(t, http.StatusForbidden, code, "%v", out)
	code, out = r.get(r.h.Thread, "/api/thread", query, hub(ownerHeaders(ownerLabel)))
	assert.Equal(t, http.StatusOK, code, "the Hub owner is served: %v", out)
	// a request with no caller kind at all (nobody the server can name as a person) is not served either
	code, _ = r.get(r.h.Thread, "/api/thread", query, nil)
	assert.Equal(t, http.StatusForbidden, code)
}

func TestTheThreadReadsAreStrictAboutTheirQuery(t *testing.T) {
	r := newThreadRig(t)
	gid, tid := itoa(r.goal.ID), itoa(r.task.ID)
	for name, c := range map[string]struct {
		threads bool
		query   url.Values
		want    int
	}{
		"team is required":                  {false, q("task", tid), 400},
		"team must be a team name":          {false, q("team", "../x", "task", tid), 400},
		"neither goal nor task":             {false, q("team", "alpha"), 400},
		"a goal that is not a number":       {false, q("team", "alpha", "goal", "abc"), 400},
		"a goal of zero":                    {false, q("team", "alpha", "goal", "0"), 400},
		"a negative task":                   {false, q("team", "alpha", "task", "-1"), 400},
		"an unknown key":                    {false, q("team", "alpha", "task", tid, "x", "1"), 400},
		"an order outside the set":          {false, q("team", "alpha", "task", tid, "order", "sideways"), 400},
		"a limit that is not a number":      {false, q("team", "alpha", "task", tid, "limit", "many"), 400},
		"a cursor this read did not give":   {false, q("team", "alpha", "task", tid, "after", "garbage"), 400},
		"a goal of another team":            {false, q("team", "beta", "goal", gid), 404},
		"a task of another team":            {false, q("team", "beta", "task", tid), 404},
		"a task that is not there":          {false, q("team", "alpha", "task", "99999"), 404},
		"threads: team is required":         {true, q("goal", gid), 400},
		"threads: a state outside the set":  {true, q("team", "alpha", "state", "pending"), 400},
		"threads: an unknown key":           {true, q("team", "alpha", "order", "asc"), 400},
		"threads: task is not a key":        {true, q("team", "alpha", "task", tid), 400},
		"threads: a goal of another team":   {true, q("team", "beta", "goal", gid), 404},
		"threads: a cursor not given":       {true, q("team", "alpha", "after", "garbage"), 400},
		"threads: a limit of zero":          {true, q("team", "alpha", "limit", "0"), 400},
		"threads: the closed states are ok": {true, q("team", "alpha", "state", "waiting"), 200},
		"a good task read":                  {false, q("team", "alpha", "task", tid, "order", "desc", "limit", "5"), 200},
		"a good goal read narrowed":         {false, q("team", "alpha", "goal", gid, "task", tid), 200},
	} {
		var code int
		if c.threads {
			code, _ = r.get(r.h.Threads, "/api/threads", c.query, person)
		} else {
			code, _ = r.get(r.h.Thread, "/api/thread", c.query, person)
		}
		assert.Equal(t, c.want, code, name)
	}
}

// What leaves the machine is cut and redacted: a reply's text over the cap comes back as an excerpt marked truncated, and a limit above the maximum is cut to it.
func TestTheThreadAnswerCutsALongReplyAndTheLimit(t *testing.T) {
	r := newThreadRig(t)
	ctx := context.Background()
	long := ""
	for i := 0; i < 100; i++ {
		long += "word "
	}
	tid := r.task.ID
	_, err := r.bs.PostMessageForTask(ctx, "alpha", "Dev", long, nil, "", &tid)
	require.NoError(t, err)
	code, out := r.get(r.h.Thread, "/api/thread", q("team", "alpha", "task", itoa(r.task.ID), "limit", "100000"), person)
	require.Equal(t, http.StatusOK, code)
	var reply map[string]any
	for _, e := range out["entries"].([]any) {
		if e.(map[string]any)["kind"] == "reply" {
			reply = e.(map[string]any)
		}
	}
	require.NotNil(t, reply)
	assert.Equal(t, true, reply["truncated"])
	assert.LessOrEqual(t, len([]rune(reply["text"].(string))), board.ThreadTextCap)
}
