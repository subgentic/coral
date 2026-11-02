package routes

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
)

func activityOfSkills(t *testing.T, bs *board.Store) []board.OperatorAction {
	rows, err := bs.ListActivity(context.Background(), board.ActivityFilter{Limit: 100})
	require.NoError(t, err)
	var out []board.OperatorAction
	for i := len(rows) - 1; i >= 0; i-- { // oldest first
		if rows[i].ItemKind == board.ItemSkill {
			out = append(out, rows[i])
		}
	}
	return out
}

func actionsOf(rows []board.OperatorAction) []string {
	var a []string
	for _, r := range rows {
		a = append(a, r.Action)
	}
	return a
}

// #12129: the Operator's decisions about skills (approve, reject, remove, import, and the acknowledgements that come with them) are rows of the Activity record, kept a year with the rest; an agent's publish and a
// refused decision are not.
func TestTheOperatorsSkillDecisionsAreInTheActivityRecord(t *testing.T) {
	e := newSkillsEnv(t)
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	e.h.SetActivity(bs)
	ctx := context.Background()

	// an agent's publish is not the Operator's action
	pend, digest := e.publish(map[string]string{"SKILL.md": skillMD}, store.PublisherAgent)
	code, _ := e.call("POST", "/api/agent/skills", zipBody(t, map[string]string{"SKILL.md": strings.Replace(skillMD, "release-notes", "other-notes", 1)}, false), "agent")
	require.Equal(t, 200, code)
	assert.Empty(t, activityOfSkills(t, bs))

	// a refused approval (a digest that is not the one reviewed) leaves no row
	code, _ = e.call("POST", "/api/skills/"+pend.ID+"/approve", `{"digest":"`+strings.Repeat("0", 64)+`"}`, "operator")
	require.Equal(t, 409, code)
	assert.Empty(t, activityOfSkills(t, bs))

	code, _ = e.call("POST", "/api/skills/"+pend.ID+"/approve", `{"digest":"`+digest+`"}`, "operator")
	require.Equal(t, 200, code)
	rows := activityOfSkills(t, bs)
	require.Len(t, rows, 1)
	assert.Equal(t, board.ActSkillApprove, rows[0].Action)
	assert.Equal(t, pend.ID, rows[0].ItemID)
	assert.Equal(t, digest, rows[0].Version, "the digest acted on")
	assert.Equal(t, "local", rows[0].Actor)
	assert.Equal(t, "release-notes version 1", rows[0].Title)
	assert.Equal(t, "alpha", rows[0].Team, "the team that published it")

	// scripts: the decision and the second click are two rows
	scriptedFiles := map[string]string{"SKILL.md": scriptedMD, "scripts/check.sh": "echo hi\n"}
	sc, scDigest := e.publish(scriptedFiles, store.PublisherOperator)
	_, err = e.ss.DB().ExecContext(ctx, `UPDATE skills SET status = 'pending' WHERE id = ?`, sc.ID)
	require.NoError(t, err)
	code, _ = e.call("POST", "/api/skills/"+sc.ID+"/approve", `{"digest":"`+scDigest+`","scripts_acked":true}`, "operator")
	require.Equal(t, 200, code)
	assert.Equal(t, []string{board.ActSkillApprove, board.ActSkillApprove, board.ActSkillScriptsAck}, actionsOf(activityOfSkills(t, bs)))

	// reject and remove
	rej, _ := e.publish(map[string]string{"SKILL.md": strings.Replace(skillMD, "release-notes", "to-reject", 1)}, store.PublisherAgent)
	code, _ = e.call("POST", "/api/skills/"+rej.ID+"/reject", "", "operator")
	require.Equal(t, 200, code)
	code, _ = e.call("DELETE", "/api/skills/"+pend.ID, "", "operator")
	require.Equal(t, 200, code)
	acts := actionsOf(activityOfSkills(t, bs))
	assert.Equal(t, board.ActSkillReject, acts[len(acts)-2])
	assert.Equal(t, board.ActSkillRemove, acts[len(acts)-1])

	// import, with the scripts and the secret acknowledged: the note names the file, never the secret
	token := "ghp_" + strings.Repeat("a1B2c3D4e5", 4)
	own := map[string]string{"SKILL.md": strings.Replace(skillMD, "release-notes", "my-own", 1), "scripts/run.sh": "echo hi\n", "references/deploy.md": "token " + token}
	body, _ := json.Marshal(map[string]any{"zip_base64": base64.StdEncoding.EncodeToString(zipOf(t, own)), "scripts_acked": true, "acknowledge_secret": true})
	before := len(activityOfSkills(t, bs))
	code, out := e.call("POST", "/api/skills", string(body), "operator")
	require.Equal(t, 200, code, "%v", out)
	rows = activityOfSkills(t, bs)[before:]
	assert.Equal(t, []string{board.ActSkillImport, board.ActSkillScriptsAck, board.ActSkillSecretAck}, actionsOf(rows))
	assert.Equal(t, "'references/deploy.md'", rows[2].Note)
	for _, r := range rows {
		assert.NotContains(t, r.Note+r.Title, token, "no part of the secret is in the record")
	}
	check, err := bs.VerifyActivity(ctx)
	require.NoError(t, err)
	assert.True(t, check.Intact, "the chain of the record holds")
}

// #12129: the access-log trim leaves the decisions: only the agents' search, list and get rows go.
func TestTheAccessLogTrimKeepsTheDecisions(t *testing.T) {
	e := newSkillsEnv(t)
	ctx := context.Background()
	row, _ := e.publish(map[string]string{"SKILL.md": skillMD}, store.PublisherOperator)
	require.NoError(t, e.ss.RemoveSkill(ctx, row.ID))
	for i := 0; i < 10100; i++ {
		_, err := e.ss.DB().ExecContext(ctx, `INSERT INTO skills_log (at, event, skill_id, digest, actor_kind, actor, detail) VALUES (?, 'search', '', '', 'agent', 'Dev', 'hits=0')`, "2026-11-02T00:00:00Z")
		require.NoError(t, err)
	}
	require.NoError(t, e.ss.LogSkillAccess(ctx, "get", row.ID, row.Digest, store.PublisherAgent, "Dev", "skill"))
	var n int
	require.NoError(t, e.ss.DB().GetContext(ctx, &n, `SELECT COUNT(*) FROM skills_log WHERE event IN ('publish', 'remove')`))
	assert.Equal(t, 2, n, "the publish and the remove stay after 10,100 search rows and a trim")
	var searches int
	require.NoError(t, e.ss.DB().GetContext(ctx, &searches, `SELECT COUNT(*) FROM skills_log WHERE event = 'search'`))
	assert.LessOrEqual(t, searches, 10000, "the agents' rows are bounded as before")
}
