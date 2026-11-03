package routes

import (
	"bytes"
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
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The Operator changes a goal's driver and gives a goal to another team (#12693): person only, and a move is a copy on the other team plus a dropped original, with the tasks left where they are.

type goalOpRig struct {
	t   *testing.T
	h   *BoardHandler
	bs  *board.Store
	srv *httptest.Server
}

func newGoalOpRig(t *testing.T) *goalOpRig {
	bs, err := boardtest.Open(t.TempDir() + "/board.db")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewBoardHandler(bs)
	t.Cleanup(h.WaitBackground)
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			switch req.Header.Get("X-Test-Who") {
			case "person":
				req = asPerson(req)
			case "agent":
				req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "claude-a"}))
			case "key":
				req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerAPIKey))
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Post("/api/board/{project}/goals/{goalID}/driver", h.SetGoalDriver)
	r.Post("/api/board/{project}/goals/{goalID}/move", h.MoveGoal)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	g := &goalOpRig{t: t, h: h, bs: bs, srv: srv}
	ctx := context.Background()
	for _, who := range []string{"Operator", "Lead", "Dev"} {
		_, err := bs.Subscribe(ctx, "alpha", who, who, "", nil, "")
		require.NoError(t, err)
	}
	for _, who := range []string{"Operator", "Boss", "Eng"} {
		_, err := bs.Subscribe(ctx, "beta", who, who, "", nil, "")
		require.NoError(t, err)
	}
	return g
}

func (g *goalOpRig) call(who, project string, id int64, verb string, body any, extra ...string) (int, map[string]any) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", g.srv.URL+"/api/board/"+project+"/goals/"+itoa(id)+"/"+verb, bytes.NewReader(b))
	require.NoError(g.t, err)
	req.Header.Set("X-Test-Who", who)
	for i := 0; i+1 < len(extra); i += 2 {
		req.Header.Set(extra[i], extra[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(g.t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (g *goalOpRig) goal(project string, driver string) *board.Goal {
	gl, err := g.bs.CreateGoal(context.Background(), project, board.GoalInput{Title: "Ship the release", Outcome: "Version two is out.", DoneWhen: "The tag is pushed.", CreatedBy: "Operator", Driver: driver})
	require.NoError(g.t, err)
	return gl
}

func (g *goalOpRig) lines(project string) string {
	g.h.WaitBackground()
	msgs, err := g.bs.ListMessages(context.Background(), project, 100, 0, 0)
	require.NoError(g.t, err)
	var out []string
	for _, m := range msgs {
		out = append(out, m.SubscriberID+": "+m.Content)
	}
	return strings.Join(out, "\n")
}

func TestTheOperatorChangesAGoalsDriverToAMemberAndTheNewDriverIsTold(t *testing.T) {
	g := newGoalOpRig(t)
	gl := g.goal("alpha", "Lead")

	code, out := g.call("person", "alpha", gl.ID, "driver", map[string]any{"driver": "Dev"})
	require.Equal(t, 200, code, out)
	assert.Equal(t, "Dev", out["driver"])
	now, err := g.bs.GetGoal(context.Background(), "alpha", gl.ID)
	require.NoError(t, err)
	assert.Equal(t, "Dev", now.Driver)
	assert.Contains(t, g.lines("alpha"), "@Dev [Goal #"+itoa(gl.ID)+"] you now drive this goal", "the new driver is told")

	code, out = g.call("person", "alpha", gl.ID, "driver", map[string]any{"driver": "Boss"}) // a member of the other team
	assert.Equal(t, 400, code, "a driver is a member of the goal's team: %v", out)
	now, _ = g.bs.GetGoal(context.Background(), "alpha", gl.ID)
	assert.Equal(t, "Dev", now.Driver, "unchanged")

	code, _ = g.call("person", "alpha", gl.ID, "driver", map[string]any{"driver": ""})
	assert.Equal(t, 200, code)
	now, _ = g.bs.GetGoal(context.Background(), "alpha", gl.ID)
	assert.Equal(t, "", now.Driver, "an empty driver clears it")

	for name, body := range map[string]any{"no field": map[string]any{}, "another field": map[string]any{"driver": "Lead", "title": "x"}} {
		code, _ = g.call("person", "alpha", gl.ID, "driver", body)
		assert.Equal(t, 400, code, name)
	}
	code, _ = g.call("person", "alpha", gl.ID+999, "driver", map[string]any{"driver": "Lead"})
	assert.Equal(t, 404, code)
	code, _ = g.call("person", "beta", gl.ID, "driver", map[string]any{"driver": "Boss"})
	assert.Equal(t, 404, code, "another team's goal looks like no goal")
}

func TestOnlyThePersonMayChangeADriverOrMoveAGoal(t *testing.T) {
	g := newGoalOpRig(t)
	gl := g.goal("alpha", "Lead")
	for _, who := range []string{"agent", "key", ""} {
		code, _ := g.call(who, "alpha", gl.ID, "driver", map[string]any{"driver": "Dev"})
		assert.Equal(t, 403, code, "driver by "+who)
		code, _ = g.call(who, "alpha", gl.ID, "move", map[string]any{"to_project": "beta"})
		assert.Equal(t, 403, code, "move by "+who)
	}
	// Coral Hub's tunnel for someone who is not this computer's owner.
	code, _ := g.call("person", "alpha", gl.ID, "move", map[string]any{"to_project": "beta"}, tunnel.ViaHeader, "1")
	assert.Equal(t, 403, code, "a Hub grantee")
	now, _ := g.bs.GetGoal(context.Background(), "alpha", gl.ID)
	assert.Equal(t, "Lead", now.Driver)
	assert.False(t, now.Closed(), "none of those moved it")
	goals, _ := g.bs.ListGoals(context.Background(), "beta", board.GoalListQuery{})
	assert.Empty(t, goals, "and nothing was made on the other team")
}

func TestMovingAGoalCopiesItToTheOtherTeamDropsTheOldOneAndLeavesItsTasks(t *testing.T) {
	g := newGoalOpRig(t)
	ctx := context.Background()
	old := g.goal("alpha", "Lead")
	require.NoError(t, g.bs.SetGoalImages(ctx, "alpha", old.ID, []board.GoalImage{{Hex: strings.Repeat("a", 64), Name: "shot.png", ContentType: "image/png"}}))
	task, err := g.bs.CreateTask(ctx, "alpha", "Write the notes", "", "medium", "Lead")
	require.NoError(t, err)
	tid := task.ID
	require.NoError(t, g.bs.SetTaskGoal(ctx, "alpha", tid, &old.ID))

	code, out := g.call("person", "alpha", old.ID, "move", map[string]any{"to_project": "beta", "driver": "Boss"})
	require.Equal(t, 200, code, out)
	fresh := out["goal"].(map[string]any)
	newID := int64(fresh["id"].(float64))
	assert.Equal(t, "beta", fresh["board_id"])
	assert.Equal(t, "Ship the release", fresh["title"])
	assert.Equal(t, "Version two is out.", fresh["outcome"])
	assert.Equal(t, "The tag is pushed.", fresh["done_when"])
	assert.Equal(t, "Boss", fresh["driver"])
	assert.EqualValues(t, 1, out["open_tasks_staying"])

	moved, err := g.bs.GetGoal(ctx, "beta", newID)
	require.NoError(t, err)
	require.Len(t, moved.Images, 1, "the pictures are copied")
	assert.Equal(t, strings.Repeat("a", 64), moved.Images[0].Hex)

	was, err := g.bs.GetGoal(ctx, "alpha", old.ID)
	require.NoError(t, err)
	assert.True(t, was.Closed())
	assert.Equal(t, board.GoalDropped, was.State)
	assert.Equal(t, "moved to beta as goal #"+itoa(newID), was.ClosedReason)

	gotTask, err := g.bs.GetTask(ctx, "alpha", tid)
	require.NoError(t, err)
	assert.Equal(t, "alpha", gotTask.BoardID, "the task stays on its team")
	assert.Equal(t, "pending", gotTask.Status, "and is unchanged")

	assert.Contains(t, g.lines("alpha"), "moved to team \"beta\" as goal #"+itoa(newID))
	assert.Contains(t, g.lines("alpha"), "Its 1 open task(s) stay here")
	assert.Contains(t, g.lines("beta"), "moved here from team \"alpha\"")
	assert.Contains(t, g.lines("beta"), "@Boss [Goal #"+itoa(newID)+"] you now drive this goal", "the driver named on the new team is told")
}

func TestAMoveThatCannotHappenChangesNothing(t *testing.T) {
	g := newGoalOpRig(t)
	ctx := context.Background()
	gl := g.goal("alpha", "Lead")
	for name, c := range map[string]struct {
		body map[string]any
		want int
	}{
		"no target":                        {map[string]any{}, 400},
		"the same team":                    {map[string]any{"to_project": "alpha"}, 400},
		"a team that is not":               {map[string]any{"to_project": "nowhere"}, 404},
		"a driver who is not on that team": {map[string]any{"to_project": "beta", "driver": "Lead"}, 400},
	} {
		code, out := g.call("person", "alpha", gl.ID, "move", c.body)
		assert.Equal(t, c.want, code, name+": %v", out)
	}
	now, _ := g.bs.GetGoal(ctx, "alpha", gl.ID)
	assert.False(t, now.Closed(), "the goal is where it was, open")
	goals, _ := g.bs.ListGoals(ctx, "beta", board.GoalListQuery{})
	assert.Empty(t, goals, "nothing was made on the other team")
	_, err := g.bs.GetBoard(ctx, "nowhere")
	assert.ErrorIs(t, err, board.ErrBoardNotFound, "a team that is not is not made by asking to move a goal there")

	_, _, err = g.bs.CloseGoal(ctx, "alpha", gl.ID, "done already", board.GoalDone)
	require.NoError(t, err)
	code, out := g.call("person", "alpha", gl.ID, "move", map[string]any{"to_project": "beta"})
	assert.Equal(t, 409, code, "a closed goal is not moved: %v", out)
}

// A goal that is only proposed is given to the other team as proposed: the move does not make it a goal that team works on (QA's SHOULD on #12693).
func TestAProposedGoalMovesAsProposed(t *testing.T) {
	g := newGoalOpRig(t)
	ctx := context.Background()
	gl, err := g.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "Maybe later", Outcome: "An idea.", State: board.GoalProposed, CreatedBy: "Operator"})
	require.NoError(t, err)

	code, out := g.call("person", "alpha", gl.ID, "move", map[string]any{"to_project": "beta"})
	require.Equal(t, 200, code, out)

	assert.Equal(t, "proposed", out["goal"].(map[string]any)["state"], "it stays proposed on the new team")
	fresh, err := g.bs.GetGoal(ctx, "beta", int64(out["goal"].(map[string]any)["id"].(float64)))
	require.NoError(t, err)
	assert.Equal(t, board.GoalProposed, fresh.State)
}
