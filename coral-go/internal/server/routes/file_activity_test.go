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
)

// #17360 (walk 67): the person's comment on a file and an agent's reply in the thread are rows of Activity, with the file's name and the words, so a search for the comment finds them.
func TestACommentAndAnAgentsReplyAreActivityRows(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	cid := rig.ownerComment("Please add a Print button")
	_, out := rig.send(cid, "Dev")
	require.Equal(t, "sent", states(out)["Dev"])
	code, rep := rig.reply(cid, asAgentSession(1), "Added the Print button.")
	require.Equal(t, http.StatusCreated, code, "%v", rep)

	rows, err := rig.h.bs.ListActivity(context.Background(), board.ActivityFilter{Limit: 50})
	require.NoError(t, err)
	byAction := map[string]board.OperatorAction{}
	for _, r := range rows {
		byAction[r.Action] = r
	}
	c, ok := byAction[board.ActFileComment]
	require.True(t, ok, "the person's comment is a row: %+v", rows)
	assert.Equal(t, "plan.md", c.Title, "with the file's name")
	assert.Equal(t, "Please add a Print button", c.Note, "and the comment's words, so a search finds it")
	r, ok := byAction[board.ActFileReply]
	require.True(t, ok, "the agent's reply is a row: %+v", rows)
	assert.Equal(t, "Added the Print button.", r.Note)
	assert.Equal(t, "Dev", r.Asker, "it names the agent")
	assert.Equal(t, "agent:Dev", r.Actor)
}

// #17174: a file an agent puts in Needs you for review is a row of Activity, with the file's name and the question it asks.
func TestAFileForReviewIsAnActivityRow(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts?session_id=a1&tag=for+review&question=Approve+the+spec%3F", strings.NewReader("spec v1"))
	require.NoError(t, err)
	req.Header.Set("X-Artifact-Name", "spec.md")
	req.Header.Set("X-Artifact-Media-Type", "text/plain")
	resp, err := agentClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Contains(t, []int{http.StatusOK, http.StatusCreated}, resp.StatusCode)
	rows, err := rig.h.bs.ListActivity(context.Background(), board.ActivityFilter{Limit: 50})
	require.NoError(t, err)
	var got []board.OperatorAction
	for _, r := range rows {
		if r.Action == board.ActFileReview {
			got = append(got, r)
		}
	}
	require.Len(t, got, 1, "%+v", rows)
	assert.Equal(t, "spec.md", got[0].Title)
	assert.Equal(t, "Approve the spec?", got[0].Note)
	assert.NotEmpty(t, got[0].Asker, "it names the agent")
}

// #17360: an agent's new version of a file is a row of Activity with the file's name, so the file's history shows it.
func TestANewVersionOfAFileIsAnActivityRow(t *testing.T) {
	rig, _ := ownerRig(t)
	_, bh := setupBoardTestServer(t)
	rig.h.bs = bh.bs
	up := func(text, ref string) string {
		req, err := http.NewRequest(http.MethodPost, rig.srv.URL+"/api/agent/artifacts?session_id=a1", strings.NewReader(text))
		require.NoError(t, err)
		req.Header.Set("X-Artifact-Name", "spec.md")
		req.Header.Set("X-Artifact-Media-Type", "text/plain")
		if ref != "" {
			req.Header.Set(seriesHeader, ref)
		}
		resp, err := agentClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Contains(t, []int{http.StatusOK, http.StatusCreated}, resp.StatusCode, text)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return strings.TrimPrefix(out["uri"].(string), "coral://artifacts/")
	}
	v1 := up("spec v1", "")
	up("spec v2", "coral://artifacts/"+v1)
	rows, err := rig.h.bs.ListActivity(context.Background(), board.ActivityFilter{Limit: 50})
	require.NoError(t, err)
	var got []board.OperatorAction
	for _, r := range rows {
		if r.Action == board.ActFileVersion {
			got = append(got, r)
		}
	}
	require.Len(t, got, 1, "the second upload is a new version, the first is not: %+v", rows)
	assert.Equal(t, "spec.md", got[0].Title)
	assert.Equal(t, "version 2", got[0].Note)
}
