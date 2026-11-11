package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #15317: "Add files" on the team's Artifacts tab and on a goal's page shares a file with the TEAM: no session_id, one message to the board, and a goal_id lands the file on that goal.

func (e *shareEnv) teamUpload(t *testing.T, name, content, goal string) (int, map[string]any) {
	t.Helper()
	url := e.srv.URL + "/api/board/alpha/operator-artifacts"
	if goal != "" {
		url += "?goal_id=" + goal
	}
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(content))
	require.NoError(t, err)
	req.Header.Set("X-Artifact-Name", name)
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (e *shareEnv) teamTell(t *testing.T, goal int64, digests ...string) (int, map[string]any) {
	t.Helper()
	m := map[string]any{"digests": digests}
	if goal != 0 {
		m["goal_id"] = goal
	}
	body, _ := json.Marshal(m)
	resp, err := http.Post(e.srv.URL+"/api/board/alpha/operator-artifacts/message", "application/json", bytes.NewReader(body))
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestATeamFileIsStoredWithTheTeamAndTheWholeBoardIsToldOnce(t *testing.T) {
	e := newShareEnv(t, true)
	code, out := e.teamUpload(t, "brief.md", "# the brief", "")
	require.Equal(t, http.StatusCreated, code, out)
	id, _ := out["id"].(string)
	require.Regexp(t, `^[0-9a-f]{64}$`, id)
	assert.Empty(t, e.operatorMessages(t), "the upload alone tells nobody")

	list := getTeamArtifacts(t, e.srv, "/api/board/alpha/artifacts", http.StatusOK)
	var found *teamArtifact
	for i := range list.Artifacts {
		if list.Artifacts[i].ID == id {
			found = &list.Artifacts[i]
		}
	}
	require.NotNil(t, found, "the team's Artifacts list shows the file")
	require.NotNil(t, found.ProducedBy)
	assert.Equal(t, board.OperatorName, *found.ProducedBy)

	code, out = e.teamTell(t, 0, id)
	require.Equal(t, http.StatusOK, code, out)
	assert.Equal(t, true, out["delivered"])
	assert.Equal(t, "team", out["to"])
	msgs := e.operatorMessages(t)
	require.Len(t, msgs, 1)
	assert.True(t, strings.HasPrefix(msgs[0], "[Coral] The operator shared a file with the team: coral://artifacts/"+id), msgs[0])
	assert.False(t, strings.HasPrefix(msgs[0], "@"), "a team's message names no one")
	assert.True(t, strings.HasSuffix(msgs[0], "brief.md"), "the file name is last, as data: "+msgs[0])
	assert.NotContains(t, msgs[0], "goal #")
}

func TestAFileAddedForAGoalIsOnThatGoalAndTheMessageNamesItByNumber(t *testing.T) {
	e := newShareEnv(t, true)
	g, err := e.h.bs.CreateGoal(context.Background(), "alpha", board.GoalInput{Title: "Ship it\nSECRET TITLE", CreatedBy: "lead"})
	require.NoError(t, err)
	gid := itoa(g.ID)
	code, out := e.teamUpload(t, "spec.md", "# spec", gid)
	require.Equal(t, http.StatusCreated, code, out)
	id, _ := out["id"].(string)

	list := getTeamArtifacts(t, e.srv, "/api/board/alpha/artifacts?goal="+gid, http.StatusOK)
	var found *teamArtifact
	for i := range list.Artifacts {
		if list.Artifacts[i].ID == id {
			found = &list.Artifacts[i]
		}
	}
	require.NotNil(t, found, "the goal's list has the file")
	require.NotNil(t, found.GoalID)
	assert.Equal(t, g.ID, *found.GoalID)

	code, out = e.teamTell(t, g.ID, id)
	require.Equal(t, http.StatusOK, code, out)
	msgs := e.operatorMessages(t)
	require.Len(t, msgs, 1)
	assert.Contains(t, msgs[0], "It is for goal #"+gid+".")
	assert.NotContains(t, msgs[0], "SECRET TITLE", "a goal's words never go into the message")
}

func TestAGoalOfAnotherTeamIsRefusedAndNothingIsStored(t *testing.T) {
	e := newShareEnv(t, true)
	g, err := e.h.bs.CreateGoal(context.Background(), "beta", board.GoalInput{Title: "not alpha's", CreatedBy: "lead"})
	require.NoError(t, err)
	code, out := e.teamUpload(t, "x.md", "# x", itoa(g.ID))
	assert.Equal(t, http.StatusNotFound, code, out)
	code, _ = e.teamUpload(t, "x.md", "# x", "999999")
	assert.Equal(t, http.StatusNotFound, code, "a goal that does not exist is no goal")
	code, _ = e.teamUpload(t, "x.md", "# x", "abc")
	assert.Equal(t, http.StatusNotFound, code)
}

func TestATeamMessageNamesOnlyTeamFilesJustStored(t *testing.T) {
	e := newShareEnv(t, true)
	_, out := e.upload(t, sessAlice, "agent.md", "# for Alice only")
	id, _ := out["id"].(string)
	code, _ := e.teamTell(t, 0, id)
	assert.Equal(t, http.StatusNotFound, code, "a file stored for one agent is not a team's file to announce")
	code, _ = e.teamTell(t, 0, strings.Repeat("a", 64))
	assert.Equal(t, http.StatusNotFound, code)
}

func TestATeamFileNeedsAPersonAndATeamWithAnAgent(t *testing.T) {
	p := newShareEnv(t, false)
	code, _ := p.teamUpload(t, "x.md", "# x", "")
	assert.Equal(t, http.StatusForbidden, code, "an agent's token cannot add a team file")
	e := newShareEnv(t, true)
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/api/board/empty-team/operator-artifacts", strings.NewReader("# x"))
	req.Header.Set("X-Artifact-Name", "x.md")
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusNotFound, resp.StatusCode, "a team with no agent has nowhere to keep the file")
}

// #15356: a team file is kept under the session of the team's first agent. Taking that agent off the team must not take the team's file off the list.
func TestATeamFileStaysListedWhenTheAgentHoldingItIsRemoved(t *testing.T) {
	e := newShareEnv(t, true)
	code, out := e.teamUpload(t, "brief.md", "# the brief", "")
	require.Equal(t, http.StatusCreated, code, out)
	id, _ := out["id"].(string)
	require.NotEmpty(t, id)

	listed := func() bool {
		list := getTeamArtifacts(t, e.srv, "/api/board/alpha/artifacts", http.StatusOK)
		for _, a := range list.Artifacts {
			if a.ID == id {
				return true
			}
		}
		return false
	}
	require.True(t, listed(), "before the removal the team's list shows the file")

	ok, err := e.h.bs.Unsubscribe(context.Background(), "alpha", "Alice")
	require.NoError(t, err)
	require.True(t, ok)

	assert.True(t, listed(), "after the agent that holds the file is removed, the team's list still shows it")
}

// #15356: the same agent name coming back under a NEW session (a replaced or relaunched agent) overwrites the subscriber's session; the team's file, kept under the old one, must still be listed.
func TestATeamFileStaysListedWhenTheHoldingAgentComesBackUnderANewSession(t *testing.T) {
	e := newShareEnv(t, true)
	code, out := e.teamUpload(t, "brief.md", "# the brief", "")
	require.Equal(t, http.StatusCreated, code, out)
	id, _ := out["id"].(string)
	require.NotEmpty(t, id)

	subscribeSession(t, e.h, "alpha", "Alice", "99999999-aaaa-0000-0000-000000000009")

	list := getTeamArtifacts(t, e.srv, "/api/board/alpha/artifacts", http.StatusOK)
	var found bool
	for _, a := range list.Artifacts {
		found = found || a.ID == id
	}
	assert.True(t, found, "the team's file is still listed after its holder came back under a new session")
}

// #15463 (1): the team's record of who holds its files goes when the board is deleted.
func TestTheTeamFileRecordGoesWhenTheBoardIsDeleted(t *testing.T) {
	e := newShareEnv(t, true)
	code, out := e.teamUpload(t, "brief.md", "# the brief", "")
	require.Equal(t, http.StatusCreated, code, out)
	require.Equal(t, []string{sessAlice}, readTeamFileHolders(e.coralDir, "alpha"), "the upload recorded its holder")
	rec := teamHoldersPath(e.coralDir, "alpha")
	_, err := os.Stat(rec)
	require.NoError(t, err)

	forgetTeamFileHolders(e.coralDir, "alpha") // what DeleteBoard calls once the board is gone
	_, err = os.Stat(rec)
	assert.True(t, os.IsNotExist(err), "the record is removed with the board")
	assert.Empty(t, readTeamFileHolders(e.coralDir, "alpha"))
	forgetTeamFileHolders(e.coralDir, "alpha") // a second time, or a board with none: nothing to say
}

// #15463 (2): a row from a session that is only on the team's record (its agent came back under a new session) names who made the file, or says the agent was removed.
func TestARowFromARecordedSessionNamesItsMakerOrSaysRemoved(t *testing.T) {
	e := newShareEnv(t, true)
	code, out := e.teamUpload(t, "brief.md", "# the brief", "")
	require.Equal(t, http.StatusCreated, code, out)
	id, _ := out["id"].(string)
	subscribeSession(t, e.h, "alpha", "Alice", "99999999-aaaa-0000-0000-000000000009")

	list := getTeamArtifacts(t, e.srv, "/api/board/alpha/artifacts", http.StatusOK)
	var row *teamArtifact
	for i := range list.Artifacts {
		if list.Artifacts[i].ID == id {
			row = &list.Artifacts[i]
		}
	}
	require.NotNil(t, row, "the file is listed")
	require.NotNil(t, row.ProducedBy, "the row has a maker, not an empty name")
	assert.NotEmpty(t, *row.ProducedBy)

	// a record that names no one: an old record, or an upload whose session could not be placed
	up := filepath.Join(uploadsDir(e.coralDir, sessAlice), id+".json")
	data, err := os.ReadFile(up)
	require.NoError(t, err)
	var rec map[string]any
	require.NoError(t, json.Unmarshal(data, &rec))
	delete(rec, "uploader")
	delete(rec, "source") // not an Operator share any more either: a plain upload of a removed agent
	delete(rec, "uploaded_by")
	data, _ = json.Marshal(rec)
	require.NoError(t, os.WriteFile(up, data, 0o600))
	e.h.bs.NoteArtifactsChanged("alpha")
	list = getTeamArtifacts(t, e.srv, "/api/board/alpha/artifacts", http.StatusOK)
	row = nil
	for i := range list.Artifacts {
		if list.Artifacts[i].ID == id {
			row = &list.Artifacts[i]
		}
	}
	require.NotNil(t, row)
	require.NotNil(t, row.ProducedBy)
	assert.Equal(t, removedAgentName, *row.ProducedBy)
}
