package routes

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/skills"
	"github.com/subgentic/coral/internal/store"
)

func zipBody(t *testing.T, files map[string]string, acked bool) string {
	b, err := json.Marshal(map[string]any{"zip_base64": base64.StdEncoding.EncodeToString(zipOf(t, files)), "scripts_acked": acked})
	require.NoError(t, err)
	return string(b)
}

// freshHour forgets the hour's publishes: an attempt counts whether it succeeds or not (a flood of bad ones is a flood), so a test that makes many bad attempts starts each from nothing.
func (e *skillsEnv) freshHour() {
	e.h.mu.Lock()
	e.h.published = nil
	e.h.mu.Unlock()
}

func (e *skillsEnv) objectPath(files map[string]string) string {
	sk, err := skills.Parse(zipOf(e.t, files))
	require.NoError(e.t, err)
	return filepath.Join(e.dir, "skills", "objects", sk.Digest)
}

func TestAnAgentsPublishedSkillWaitsAndIsKeptInTheSkillStoresOwnFolder(t *testing.T) {
	e := newSkillsEnv(t)
	board := "alpha"
	require.NoError(t, e.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "sid-a", AgentType: "claude", AgentName: "Backend Dev", WorkingDir: "/r", BoardName: &board}))
	files := map[string]string{"SKILL.md": skillMD, "references/pg.md": "notes"}
	code, out := e.call("POST", "/api/agent/skills", zipBody(t, files, false), "agent")
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "pending", out["status"])
	assert.Equal(t, "release-notes", out["name"])
	id := out["id"].(string)

	row, err := e.ss.GetSkill(context.Background(), id)
	require.NoError(t, err)
	assert.Equal(t, "Backend Dev", row.PublisherAgent, "the publisher is the session's agent, not anything in the skill")
	assert.Equal(t, "alpha", row.PublisherTeam)
	info, err := os.Stat(e.objectPath(files))
	require.NoError(t, err, "the zip is in the Skills Store's own folder")
	if runtime.GOOS != "windows" {
		assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
		dir, err := os.Stat(filepath.Join(e.dir, "skills", "objects"))
		require.NoError(t, err)
		assert.Equal(t, os.FileMode(0o700), dir.Mode().Perm())
	}
	_, err = os.Stat(filepath.Join(e.dir, "artifacts", "objects", row.Digest))
	assert.True(t, os.IsNotExist(err), "nothing in the artifact store")

	// waiting: nobody finds or reads it but the Operator
	code, _ = e.get("/api/agent/skills/"+id, "agent")
	assert.Equal(t, 404, code)
	_, found := e.get("/api/agent/skills/search?q=release", "agent")
	assert.Empty(t, found["skills"])
	code, view := e.call("GET", "/api/skills/"+id, "", "operator")
	require.Equal(t, 200, code)
	assert.Equal(t, "notes", view["contents"].(map[string]any)["references/pg.md"])

	// the same bytes again are the same row
	code, again := e.call("POST", "/api/agent/skills", zipBody(t, files, false), "agent")
	require.Equal(t, 200, code)
	assert.Equal(t, id, again["id"])
}

func TestAnAgentsPublishIsRefusedForWhatIsNotAllowedAndLeavesNothingBehind(t *testing.T) {
	e := newSkillsEnv(t)
	for name, c := range map[string]struct {
		files map[string]string
		code  int
		err   string
	}{
		"a script":       {map[string]string{"SKILL.md": skillMD, "scripts/run.sh": "echo hi"}, 422, "agent_files"},
		"an extension":   {map[string]string{"SKILL.md": skillMD, "helper.py": "print(1)"}, 422, "agent_files"},
		"a binary":       {map[string]string{"SKILL.md": skillMD, "assets/x.png": "\x89PNG\x00"}, 422, "agent_files"},
		"a hidden file":  {map[string]string{"SKILL.md": skillMD, ".env": "K=v"}, 400, "invalid_skill"},
		"no SKILL.md":    {map[string]string{"README.md": "hi"}, 400, "invalid_skill"},
		"a bad zip name": {map[string]string{"SKILL.md": skillMD, "CON.txt": "x"}, 400, "invalid_skill"},
	} {
		e.freshHour()
		code, out := e.call("POST", "/api/agent/skills", zipBody(t, c.files, false), "agent")
		assert.Equal(t, c.code, code, name)
		assert.Equal(t, c.err, out["code"], name)
	}
	entries, err := os.ReadDir(filepath.Join(e.dir, "skills", "objects"))
	if err == nil {
		assert.Empty(t, entries, "a refused publish keeps no bytes")
	}
	list, err := e.ss.ListSkills(context.Background(), "")
	require.NoError(t, err)
	assert.Empty(t, list)
	for name, body := range map[string]string{"not json": "zip", "no zip": `{}`, "bad base64": `{"zip_base64":"!!!"}`, "empty": `{"zip_base64":""}`} {
		e.freshHour()
		code, _ := e.call("POST", "/api/agent/skills", body, "agent")
		assert.Equal(t, 400, code, name)
	}
	big := `{"zip_base64":"` + strings.Repeat("A", maxPublishBody) + `"}`
	e.freshHour()
	code, out := e.call("POST", "/api/agent/skills", big, "agent")
	assert.Equal(t, 413, code)
	assert.Equal(t, "skill_too_large", out["code"])
}

func TestOnlyAnAgentWithItsTokenPublishesToTheAgentRoute(t *testing.T) {
	e := newSkillsEnv(t)
	body := zipBody(t, map[string]string{"SKILL.md": skillMD}, false)
	code, out := e.call("POST", "/api/agent/skills", body, "")
	assert.Equal(t, 401, code)
	assert.Equal(t, "session_token_required", out["error"])
	for _, who := range []string{"operator", "key"} {
		code, _ = e.call("POST", "/api/agent/skills", body, who)
		assert.Contains(t, []int{401, 403}, code, who+": the Operator's own publish is POST /api/skills")
	}
}

func TestAnAgentMayPublishFiveSkillsAnHour(t *testing.T) {
	e := newSkillsEnv(t)
	now := time.Now()
	e.h.nowFunc = func() time.Time { return now }
	for i := 0; i < publishesPerHour; i++ {
		files := map[string]string{"SKILL.md": strings.Replace(skillMD, "release-notes", "notes-"+string(rune('a'+i)), 1)}
		code, out := e.call("POST", "/api/agent/skills", zipBody(t, files, false), "agent")
		require.Equal(t, 200, code, "%d %v", i, out)
	}
	code, out := e.call("POST", "/api/agent/skills", zipBody(t, map[string]string{"SKILL.md": strings.Replace(skillMD, "release-notes", "notes-z", 1)}, false), "agent")
	assert.Equal(t, 429, code)
	assert.Equal(t, "rate_limited", out["code"])
	now = now.Add(61 * time.Minute)
	e.h.mu.Lock()
	e.h.recent = map[string][]time.Time{}
	e.h.mu.Unlock()
	require.NoError(t, e.ss.RejectSkill(context.Background(), firstPending(t, e)), "the per-agent pending cap is five: one decision makes room")
	code, _ = e.call("POST", "/api/agent/skills", zipBody(t, map[string]string{"SKILL.md": strings.Replace(skillMD, "release-notes", "notes-z", 1)}, false), "agent")
	assert.Equal(t, 200, code, "an hour later it is open again")
}

func firstPending(t *testing.T, e *skillsEnv) string {
	rows, err := e.ss.ListSkills(context.Background(), store.SkillPending)
	require.NoError(t, err)
	require.NotEmpty(t, rows)
	return rows[0].ID
}

func TestAnAgentCannotPublishWhatTheOperatorRejected(t *testing.T) {
	e := newSkillsEnv(t)
	body := zipBody(t, map[string]string{"SKILL.md": skillMD}, false)
	code, out := e.call("POST", "/api/agent/skills", body, "agent")
	require.Equal(t, 200, code)
	require.NoError(t, e.ss.RejectSkill(context.Background(), out["id"].(string)))
	code, out = e.call("POST", "/api/agent/skills", body, "agent")
	assert.Equal(t, 409, code)
	assert.Equal(t, "refused_before", out["code"])
}

func TestTheOperatorPublishesTheirOwnSkillApprovedAtOnceAndScriptsNeedTheSecondClick(t *testing.T) {
	e := newSkillsEnv(t)
	plain := map[string]string{"SKILL.md": skillMD, "references/pg.md": "x"}
	for _, who := range []string{"agent", "key", ""} {
		code, _ := e.call("POST", "/api/skills", zipBody(t, plain, false), who)
		assert.Equal(t, 403, code, who)
	}
	code, out := e.call("POST", "/api/skills", zipBody(t, plain, false), "operator")
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "approved", out["status"])
	code, _ = e.get("/api/agent/skills/"+out["id"].(string), "agent")
	assert.Equal(t, 200, code, "approved at once: an agent reads it")

	scripted := map[string]string{"SKILL.md": scriptedMD, "scripts/check.sh": "echo hi\n", "assets/logo.png": "\x89PNG\x00"}
	code, out = e.call("POST", "/api/skills", zipBody(t, scripted, false), "operator")
	assert.Equal(t, 409, code)
	assert.Equal(t, "scripts_not_acknowledged", out["code"])
	_, err := os.Stat(e.objectPath(scripted))
	assert.True(t, os.IsNotExist(err), "nothing was kept for the refused one")
	code, out = e.call("POST", "/api/skills", zipBody(t, scripted, true), "operator")
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "approved", out["status"])
}

func TestTheSkillsFolderIsNotFollowedAndDamagedBytesAreNotReplaced(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("links need rights on Windows")
	}
	e := newSkillsEnv(t)
	elsewhere := t.TempDir()
	require.NoError(t, os.Symlink(elsewhere, filepath.Join(e.dir, "skills")))
	code, _ := e.call("POST", "/api/skills", zipBody(t, map[string]string{"SKILL.md": skillMD}, false), "operator")
	assert.Equal(t, 500, code, "a link in place of the folder is refused")
	entries, _ := os.ReadDir(elsewhere)
	assert.Empty(t, entries, "nothing was written where the link points")
	require.NoError(t, os.Remove(filepath.Join(e.dir, "skills")))

	files := map[string]string{"SKILL.md": skillMD}
	require.NoError(t, os.MkdirAll(filepath.Join(e.dir, "skills", "objects"), 0o700))
	require.NoError(t, os.WriteFile(e.objectPath(files), []byte("not the zip"), 0o600))
	code, _ = e.call("POST", "/api/skills", zipBody(t, files, false), "operator")
	assert.Equal(t, 500, code, "bytes under the digest that are not the zip are never replaced")
	b, _ := os.ReadFile(e.objectPath(files))
	assert.Equal(t, "not the zip", string(b))
}
