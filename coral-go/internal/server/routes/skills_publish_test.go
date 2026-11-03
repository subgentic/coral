package routes

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
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

// #12024 (Security's SHOULD): what an agent publishes is checked for secrets before a byte is kept; the reply names the file, never the secret, and the Operator's own is warned once.
func TestAnAgentsSkillThatHoldsASecretIsRefusedNamingTheFile(t *testing.T) {
	e := newSkillsEnv(t)
	token := "ghp_" + strings.Repeat("a1B2c3D4e5", 4)
	for name, files := range map[string]map[string]string{
		"a reference file": {"SKILL.md": skillMD, "references/deploy.md": "deploy with token " + token},
		"SKILL.md itself":  {"SKILL.md": skillMD + "\nAuthorization: Bearer " + token + "\n"},
		"an env text":      {"SKILL.md": skillMD, "data/config.json": `{"api_key": "` + token + `"}`},
	} {
		e.freshHour()
		code, out := e.call("POST", "/api/agent/skills", zipBody(t, files, false), "agent")
		assert.Equal(t, 422, code, name)
		assert.Equal(t, "holds_secret", out["code"], name)
		assert.NotContains(t, fmt.Sprint(out), token, name+": the reply never carries the secret")
		assert.NotContains(t, fmt.Sprint(out), strings.Repeat("a1B2c3D4e5", 2), name)
		_, err := os.Stat(e.objectPath(files))
		assert.True(t, os.IsNotExist(err), name+": no byte was kept")
	}
	e.freshHour()
	_, out := e.call("POST", "/api/agent/skills", zipBody(t, map[string]string{"SKILL.md": skillMD, "references/deploy.md": "token " + token}, false), "agent")
	assert.Contains(t, fmt.Sprint(out["error"]), "references/deploy.md", "the file is named")
	rows, err := e.ss.ListSkills(context.Background(), "")
	require.NoError(t, err)
	assert.Empty(t, rows, "nothing was recorded")
	// the Operator's own: warned once, then acknowledged and logged
	own := map[string]string{"SKILL.md": skillMD, "references/deploy.md": "token " + token}
	code, out := e.call("POST", "/api/skills", zipBody(t, own, false), "operator")
	assert.Equal(t, 409, code)
	assert.Equal(t, "holds_secret", out["code"])
	assert.Contains(t, fmt.Sprint(out["error"]), "references/deploy.md")
	assert.NotContains(t, fmt.Sprint(out["error"]), "acknowledge_secret", "the import dialog shows this sentence and asks 'Import anyway?': a person has no such parameter to pass (#12418)")
	assert.NotContains(t, fmt.Sprint(out["error"]), "publish again")
	assert.NotContains(t, fmt.Sprint(out), token)
	_, err = os.Stat(e.objectPath(own))
	assert.True(t, os.IsNotExist(err), "nothing was kept until it is acknowledged")
	ack, _ := json.Marshal(map[string]any{"zip_base64": base64.StdEncoding.EncodeToString(zipOf(t, own)), "acknowledge_secret": true})
	code, out = e.call("POST", "/api/skills", string(ack), "operator")
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "approved", out["status"])
	log, err := e.ss.SkillLog(context.Background(), 20)
	require.NoError(t, err)
	var logged *store.SkillLogEntry
	for i := range log {
		if log[i].Event == "secret_acknowledged" {
			logged = &log[i]
		}
	}
	require.NotNil(t, logged, "the acknowledgement is in skills_log")
	assert.Equal(t, "references/deploy.md", logged.Detail)
	assert.Equal(t, out["id"], logged.SkillID)
	assert.NotContains(t, logged.Detail+logged.Actor, token)
}

// #12024 (Security's SHOULD): the bytes of a rejected or removed skill are deleted; the refusal memory is the digest, which stays.
func TestRejectingOrRemovingASkillDeletesItsBytes(t *testing.T) {
	e := newSkillsEnv(t)
	rej := map[string]string{"SKILL.md": skillMD}
	_, out := e.call("POST", "/api/agent/skills", zipBody(t, rej, false), "agent")
	rejID := out["id"].(string)
	_, err := os.Stat(e.objectPath(rej))
	require.NoError(t, err, "kept while it waits")
	code, _ := e.call("POST", "/api/skills/"+rejID+"/reject", "", "operator")
	require.Equal(t, 200, code)
	_, err = os.Stat(e.objectPath(rej))
	assert.True(t, os.IsNotExist(err), "rejected: the bytes are gone")
	e.freshHour()
	code, out = e.call("POST", "/api/agent/skills", zipBody(t, rej, false), "agent")
	assert.Equal(t, 409, code)
	assert.Equal(t, "refused_before", out["code"], "the digest is still remembered")

	rem := map[string]string{"SKILL.md": scriptedMD}
	_, out = e.call("POST", "/api/skills", zipBody(t, rem, false), "operator")
	remID := out["id"].(string)
	_, err = os.Stat(e.objectPath(rem))
	require.NoError(t, err)
	code, _ = e.call("DELETE", "/api/skills/"+remID, "", "operator")
	require.Equal(t, 200, code)
	_, err = os.Stat(e.objectPath(rem))
	assert.True(t, os.IsNotExist(err), "removed: the bytes are gone")
	// the Operator can publish the removed bytes again: a new version, kept again
	code, _ = e.call("POST", "/api/skills", zipBody(t, rem, false), "operator")
	assert.Equal(t, 200, code)
	_, err = os.Stat(e.objectPath(rem))
	assert.NoError(t, err)
}

// #12024 (Security's INFO): two publishes of the same new bytes at once both succeed with the same record, and the limit maps forget a caller that stopped.
func TestTwoPublishesOfTheSameBytesAtOnceBothSucceedAndTheLimitMapsAreTrimmed(t *testing.T) {
	e := newSkillsEnv(t)
	body := zipBody(t, map[string]string{"SKILL.md": skillMD, "references/pg.md": strings.Repeat("text ", 20000)}, false)
	ids := make(chan string, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, out := e.call("POST", "/api/skills", body, "operator")
			if code == 200 {
				ids <- out["id"].(string)
			} else {
				ids <- fmt.Sprint("status ", code)
			}
		}()
	}
	wg.Wait()
	close(ids)
	seen := map[string]bool{}
	for id := range ids {
		seen[id] = true
	}
	assert.Len(t, seen, 1, "one record, and no 500 'damaged' for the one that came second: %v", seen)

	now := time.Now()
	e.h.nowFunc = func() time.Time { return now }
	require.True(t, e.h.allowPublish("session-that-leaves"))
	require.True(t, e.h.allow("agent:session-that-leaves"))
	now = now.Add(2 * time.Hour)
	require.True(t, e.h.allowPublish("another"))
	require.True(t, e.h.allow("operator:operator"))
	e.h.mu.Lock()
	defer e.h.mu.Unlock()
	assert.NotContains(t, e.h.published, "session-that-leaves", "a session that stopped publishing leaves nothing behind")
	assert.NotContains(t, e.h.recent, "agent:session-that-leaves")
}

// The sign-in link census (#12261): a skill whose file holds a sign-in link (login_token=) is refused whoever publishes it, naming the file, and no byte is kept; a file without one is unaffected.
func TestASkillThatHoldsASignInLinkIsRefusedNamingTheFile(t *testing.T) {
	e := newSkillsEnv(t)
	link := "http://127.0.0.1:8420/auth?login_token=test-token-placeholder"
	for name, files := range map[string]map[string]string{
		"a reference file": {"SKILL.md": skillMD, "references/open.md": "open " + link},
		"SKILL.md itself":  {"SKILL.md": skillMD + "\nsign in at " + link + "\n"},
		"url-encoded":      {"SKILL.md": skillMD, "data/x.txt": "http://h/?login_token%3Dtest-token-placeholder"},
	} {
		e.freshHour()
		code, out := e.call("POST", "/api/agent/skills", zipBody(t, files, false), "agent")
		assert.Equal(t, 400, code, name)
		assert.Equal(t, "sign_in_link", out["code"], name)
		assert.NotContains(t, fmt.Sprint(out), "test-token-placeholder", name+": the reply never carries the link")
		_, err := os.Stat(e.objectPath(files))
		assert.True(t, os.IsNotExist(err), name+": no byte was kept")
		code, out = e.call("POST", "/api/skills", zipBody(t, files, false), "operator")
		assert.Equal(t, 400, code, name+": the Operator's own too")
		assert.Equal(t, "sign_in_link", out["code"], name)
	}
	e.freshHour()
	_, out := e.call("POST", "/api/agent/skills", zipBody(t, map[string]string{"SKILL.md": skillMD, "references/ok.md": "no link here"}, false), "agent")
	assert.NotEqual(t, "sign_in_link", out["code"], "a skill with no link is not refused for one")
	rows, err := e.ss.ListSkills(context.Background(), "")
	require.NoError(t, err)
	assert.Len(t, rows, 1, "only the clean one was recorded")
}
