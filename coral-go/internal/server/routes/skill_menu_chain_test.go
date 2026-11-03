package routes

import (
	"context"
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

func TestASkillPickedFromTheMenuReachesTheAgentAndTheAgentReadsExactlyThatSkill(t *testing.T) {
	e := newSkillsEnv(t)
	e.liveAgent("sid-a")
	row, digest := e.publish(map[string]string{"SKILL.md": menuSkillMD, "references/format.md": "format: one bullet per merged PR"}, store.PublisherOperator)

	// 1. the menu lists the skill (the Operator's own search, as the page asks it)
	code, out := e.call("GET", "/api/skills/search?q=release", "", "operator")
	require.Equal(t, 200, code, out)
	menu, _ := out["skills"].([]any)
	require.Len(t, menu, 1, "the menu offers the approved skill")
	assert.Equal(t, row.ID, menu[0].(map[string]any)["id"])

	// 2. the pick: attach, and the line the message carries
	code, out = e.call("POST", e.attachPath("sid-a"), attachBody(row.ID), "operator")
	require.Equal(t, 200, code, out)
	line, _ := out["line"].(string)
	m := lineIDRe.FindStringSubmatch(line)
	require.NotNil(t, m, "the line is the fixed sentence with the skill's id: %q", line)
	assert.Equal(t, row.ID, m[1], "the line names the skill that was picked")

	// 3. the agent RECEIVES the line: the person sends it, through the real Send route, to the agent's terminal, whole and unchanged (not redacted, not shortened)
	rig := newSleepRig(t)
	require.Equal(t, http.StatusOK, sendToAgent(t, rig, line))
	rig.term.mu.Lock()
	got := append([]string(nil), rig.term.sent[rig.name]...)
	rig.term.mu.Unlock()
	require.NotEmpty(t, got, "the agent's terminal was typed something")
	assert.Contains(t, got[len(got)-1], line, "the agent receives the exact line, id included")

	// 4. the agent does what the line says, with its own identity: its list shows the pin, and `skills get --id` returns the picked skill's text
	code, out = e.call("GET", "/api/agent/skills", "", "agent")
	require.Equal(t, 200, code)
	list, _ := out["skills"].([]any)
	require.Len(t, list, 1)
	assert.Equal(t, "release-notes", list[0].(map[string]any)["name"])

	code, out = e.call("GET", "/api/agent/skills/"+m[1], "", "agent")
	require.Equal(t, 200, code, out)
	assert.Contains(t, out["skill_md"], "ZXQ-4417", "the agent reads the skill's own instructions")
	assert.Equal(t, digest, out["digest"], "and they are the version that was approved and pinned")
	assert.Contains(t, out["frame"], "A skill the Operator approved", "framed as outside text, not Coral's instruction")

	code, out = e.call("GET", "/api/agent/skills/"+m[1]+"?file=references/format.md", "", "agent")
	require.Equal(t, 200, code, out)
	assert.Equal(t, "format: one bullet per merged PR", out["content"], "a file the skill points to is readable too")

	// 5. a stale line does not leak a removed skill: the Operator removes it, and the same command now says so
	code, _ = e.call("DELETE", "/api/skills/"+m[1], "", "operator")
	require.Equal(t, 200, code)
	code, out = e.call("GET", "/api/agent/skills/"+m[1], "", "agent")
	assert.Equal(t, http.StatusGone, code, "a removed skill is not served from an old line: %v", out)
	_ = context.Background()
}
