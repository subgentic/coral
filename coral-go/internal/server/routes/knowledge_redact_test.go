package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/pkg/redact"
)

// #4414: a knowledge file written before knowledge was redacted reaches a launch prompt redacted.
func TestInjectedKnowledgeIsRedacted(t *testing.T) {
	iso := t.TempDir()
	for _, k := range []string{"TMPDIR", "TMP", "TEMP"} {
		t.Setenv(k, iso)
	}
	t.Setenv("HOME", filepath.Join(iso, "home"))
	t.Setenv("USERPROFILE", filepath.Join(iso, "home"))
	t.Setenv("CORAL_DATA_DIR", filepath.Join(iso, "data"))
	dir := t.TempDir()
	const token = "ghp_A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5F6g7H8"
	kd := filepath.Join(dir, "agent_knowledge", "my-team")
	require.NoError(t, os.MkdirAll(kd, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(kd, "devops.md"), []byte("deploy with "+token), 0o600))

	got := InjectKnowledgeIntoPrompt(dir, "my-team", "DevOps", "You are DevOps.")
	assert.NotContains(t, got, token)
	assert.Contains(t, got, "deploy with "+redact.Marker)
}

// #4414 INFO 2: the dashboard's Save says whether a secret was replaced before the knowledge was saved.
func TestSaveKnowledgeSaysWhenItRedacted(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	dir := h.cfg.CoralDir()
	require.NoError(t, background.WriteKnowledgeIndex(dir, "my-team", "# Team"))
	const token = "ghp_A1b2C3d4E5A1b2C3d4E5A1b2C3d4E5F6g7H8"
	save := func(content string) map[string]any {
		body, _ := json.Marshal(map[string]string{"content": content})
		req := httptest.NewRequest(http.MethodPut, "/api/teams/detail/my-team/knowledge/DevOps", bytes.NewReader(body))
		rctx := chi.NewRouteContext()
		rctx.URLParams.Add("name", "my-team")
		rctx.URLParams.Add("agentName", "DevOps")
		req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
		rr := httptest.NewRecorder()
		h.SaveAgentKnowledge(rr, req)
		require.Equal(t, http.StatusOK, rr.Code, rr.Body.String())
		var out map[string]any
		require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &out))
		return out
	}
	assert.Equal(t, map[string]any{"ok": true, "redacted": true}, save("deploy with "+token))
	assert.NotContains(t, background.LoadAgentKnowledge(dir, "my-team", "DevOps"), token)
	assert.Equal(t, map[string]any{"ok": true, "redacted": false}, save("deploy with make"))
}

// #15272 (Security's INFO): a failed run's error stays on the Knowledge tab, so a key a CLI echoed in it is replaced like the rest of what the status carries.
func TestAKnowledgeStatusErrorNeverCarriesAKey(t *testing.T) {
	token := "ghp_" + "A1b2C3d4E5" + "A1b2C3d4E5A1b2C3d4E5F6g7H8" // built at run time: no key-shaped literal in the repo; entropy enough for the one set of rules (internal/secrets) to call it a key, which a repeated aB3 is not
	j := knowledgeJob{TeamName: "t", Status: "failed", Error: "claude CLI failed: exit status 1: bad token " + token,
		FailedAgents: []background.DistillFailure{{Agent: "Ada", Error: "denied for " + token}}}
	out := j.status()
	assert.NotContains(t, out.Error, token)
	assert.Contains(t, out.Error, redact.Marker)
	assert.NotContains(t, out.FailedAgents[0].Error, token)
}

// #15539 (Security's SHOULD on #15538): the plain redactor has no keyword rules, so a CLI error that echoes `api_key=<value>` would show on the Knowledge tab; the status uses the credential rules.
func TestAKnowledgeStatusErrorHidesAKeywordedValue(t *testing.T) {
	value := "mellow" + "harbor" + "tide" + "42" // built at run time: 18 characters, no known key shape and too little entropy for the plain rules; only the keyword rules (the name before it) call it a credential
	for _, field := range []string{"api_key=", "password: ", `"secret":"`} {
		j := knowledgeJob{TeamName: "t", Status: "failed", Error: "claude CLI failed: exit status 1: " + field + value,
			FailedAgents: []background.DistillFailure{{Agent: "Ada", Error: "denied, " + field + value}}}
		out := j.status()
		assert.NotContains(t, out.Error, value, field)
		assert.NotContains(t, out.FailedAgents[0].Error, value, field)
		assert.Contains(t, out.Error, redact.Marker, field)
	}
}
