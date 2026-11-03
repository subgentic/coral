package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// Goal #207's done-when, automated (stability list row 20): the Operator picks a skill from the $ menu, the page puts the route's line in the message, the agent RECEIVES that line, and what the line says
// (`coral-agent skills get --id <id>`) reads exactly the skill the Operator picked. Every hop is the real route or handler: the menu search, the attach, the Send route into the agent's terminal (the stand-in
// terminal records what the agent would be typed), and the agent's own list and get with its own identity. Not covered here: the CLI's parsing of the answer (cmd/coral-agent has its own tests) and a real model reading it.

const menuSkillMD = "---\nname: release-notes\ndescription: Writes release notes from merged PRs.\n---\n# Release notes\nStart every note with the marker ZXQ-4417.\n"

var lineIDRe = regexp.MustCompile(`^Use the skill release-notes \(coral-agent skills get --id ([0-9a-f]{32})\)\.$`)

// sendToAgent is the person's Send of a message to the agent whose terminal the rig holds, through the real route.
func sendToAgent(t *testing.T, r *sleepRig, text string) int {
	t.Helper()
	rt := chi.NewRouter()
	rt.Post("/api/sessions/live/{name}/send", r.h.Send)
	body := `{"command":` + jsonQuote(text) + `,"agent_type":"claude","session_id":"` + r.sid + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+r.name+"/send", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)
	return rec.Code
}

func jsonQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, c := range s {
		switch c {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(c)
		case '\n':
			b.WriteString(`\n`)
		default:
			b.WriteRune(c)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// asAgent is a call as the agent of session sid (its own identity, as its token gives it), not the fixed one the shared helper uses: the agent the skill was attached to is the agent the line is sent to.
func (e *skillsEnv) asAgent(sid, name, method, path string) (int, map[string]any) {
	req := httptest.NewRequest(method, path, nil)
	req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sid, SessionName: name}))
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestASkillPickedFromTheMenuReachesTheAgentAndTheAgentReadsExactlyThatSkill(t *testing.T) {
	e := newSkillsEnv(t)
	rig := newSleepRig(t) // agent A: the one the skill is attached to AND the one the line is sent to
	sidA, nameA := rig.sid, rig.name
	e.liveAgent(sidA)
	e.liveAgent("sid-b") // agent B: another agent on the computer, with nothing attached
	row, digest := e.publish(map[string]string{"SKILL.md": menuSkillMD, "references/format.md": "format: one bullet per merged PR"}, store.PublisherOperator)

	// 1. the menu lists the skill (the Operator's own search, as the page asks it)
	code, out := e.call("GET", "/api/skills/search?q=release", "", "operator")
	require.Equal(t, 200, code, out)
	menu, _ := out["skills"].([]any)
	require.Len(t, menu, 1, "the menu offers the approved skill")
	assert.Equal(t, row.ID, menu[0].(map[string]any)["id"])

	// 2. the pick: attach, and the line the message carries
	code, out = e.call("POST", e.attachPath(sidA), attachBody(row.ID), "operator")
	require.Equal(t, 200, code, out)
	line, _ := out["line"].(string)
	m := lineIDRe.FindStringSubmatch(line)
	require.NotNil(t, m, "the line is the fixed sentence with the skill's id: %q", line)
	assert.Equal(t, row.ID, m[1], "the line names the skill that was picked")

	// 3. the agent RECEIVES the line: the person sends it, through the real Send route, to the agent's terminal, whole and unchanged (not redacted, not shortened)
	require.Equal(t, http.StatusOK, sendToAgent(t, rig, line))
	rig.term.mu.Lock()
	got := append([]string(nil), rig.term.sent[nameA]...)
	rig.term.mu.Unlock()
	require.NotEmpty(t, got, "the agent's terminal was typed something")
	assert.Contains(t, got[len(got)-1], line, "the agent receives the exact line, id included")

	// 4. the agent does what the line says, with its own identity: its list shows the pin, and `skills get --id` returns the picked skill's text
	code, out = e.asAgent(sidA, nameA, "GET", "/api/agent/skills")
	require.Equal(t, 200, code)
	list, _ := out["skills"].([]any)
	require.Len(t, list, 1, "agent A's own list shows the pin")
	assert.Equal(t, "release-notes", list[0].(map[string]any)["name"])
	code, out = e.asAgent("sid-b", "claude-sid-b", "GET", "/api/agent/skills")
	require.Equal(t, 200, code)
	other, _ := out["skills"].([]any)
	assert.Empty(t, other, "agent B has no pin: a line sent to B is not answered from A's attach")

	code, out = e.asAgent(sidA, nameA, "GET", "/api/agent/skills/"+m[1])
	require.Equal(t, 200, code, out)
	assert.Contains(t, out["skill_md"], "ZXQ-4417", "the agent reads the skill's own instructions")
	assert.Equal(t, digest, out["digest"], "and they are the version that was approved and pinned")
	assert.Contains(t, out["frame"], "A skill the Operator approved", "framed as outside text, not Coral's instruction")

	code, out = e.asAgent(sidA, nameA, "GET", "/api/agent/skills/"+m[1]+"?file=references/format.md")
	require.Equal(t, 200, code, out)
	assert.Equal(t, "format: one bullet per merged PR", out["content"], "a file the skill points to is readable too")

	// 5. a stale line does not leak a removed skill: the Operator removes it, and the same command now says so
	code, _ = e.call("DELETE", "/api/skills/"+m[1], "", "operator")
	require.Equal(t, 200, code)
	code, out = e.asAgent(sidA, nameA, "GET", "/api/agent/skills/"+m[1])
	assert.Equal(t, http.StatusGone, code, "a removed skill is not served from an old line: %v", out)
	_ = context.Background()
}
