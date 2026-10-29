package routes

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agentmodels"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #11105 (row 16): a Pi model given as provider/id is checked against what `pi --list-models` lists (the models service's cache), and the person is told when it is unknown instead of Pi being started on a
// name it cannot use. What cannot be checked is let through: a list not fetched yet, a bare id or pattern (Pi matches those itself), a custom model.
func TestPiModelProblem(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewSystemHandler(db, &config.Config{LogDir: t.TempDir()})
	cli := filepath.Join(t.TempDir(), "pi")
	require.NoError(t, os.WriteFile(cli, []byte("#!/bin/sh\n"), 0o755))
	h.models = agentmodels.NewService(func(string) (string, error) { return cli, nil })
	h.models.SetFetcher(func(context.Context, string, string) ([]agentmodels.Model, string, error) {
		return []agentmodels.Model{{Value: "anthropic/claude-fable-5"}, {Value: "openai/gpt-6-luna"}}, "account", nil
	})
	t.Cleanup(h.models.Wait)

	assert.Equal(t, "", h.PiModelProblem(ctx, "anthropic/not-listed"), "the list is not here yet: it cannot be checked, so nothing is refused (and the fetch starts)")
	h.models.Wait()

	assert.Equal(t, "", h.PiModelProblem(ctx, "anthropic/claude-fable-5"))
	assert.Equal(t, "", h.PiModelProblem(ctx, "openai/gpt-6-luna:high"), "a :level suffix is Pi's thinking shorthand")
	assert.Equal(t, "", h.PiModelProblem(ctx, "sonnet"), "a bare id or a pattern is Pi's to match")
	assert.Equal(t, "", h.PiModelProblem(ctx, "claude-fable-5"))
	assert.Equal(t, "", h.PiModelProblem(ctx, ""))
	for _, bad := range []string{"anthropic/not-listed", "nosuchprovider/claude-fable-5", "openai/claude-fable-5"} {
		msg := h.PiModelProblem(ctx, bad)
		assert.Contains(t, msg, bad, "it says which model: "+bad)
		assert.Contains(t, msg, "pi --list-models", "and where the list is")
	}

	// A custom model the operator added for Pi is accepted.
	require.NoError(t, store.NewSessionStore(db).ReplaceCustomModels(ctx, []store.CustomModel{{Family: "pi", Value: "myprov/mine", DisplayName: "Mine"}}))
	assert.Equal(t, "", h.PiModelProblem(ctx, "myprov/mine"))
	assert.NotEqual(t, "", h.PiModelProblem(ctx, "myprov/other"))
}

// At launch: a Pi model Pi does not list is refused naming it and nothing starts; a listed one launches; another agent type is not asked.
func TestLaunchRefusesAPiModelThatPiDoesNotList(t *testing.T) {
	server, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	h.SetPiModelCheck(func(_ context.Context, model string) string {
		if model == "bad/none" {
			return `Pi has no model "bad/none"`
		}
		return ""
	})
	code, out := postThinkingJSON(t, server.URL+"/api/sessions/launch", map[string]any{"working_dir": t.TempDir(), "agent_type": "pi", "model": "bad/none"})
	assert.Equal(t, 500, code, "a model refusal answers as the provider mismatch does (sessions_test.go: TestLaunch...ProviderMismatch): "+out)
	assert.Contains(t, out, `Pi has no model \"bad/none\"`)
	assert.Empty(t, term.sentCommands(), "nothing launched")
	code, out = postThinkingJSON(t, server.URL+"/api/sessions/launch", map[string]any{"working_dir": t.TempDir(), "agent_type": "pi", "model": "anthropic/claude-fable-5"})
	assert.Equal(t, 200, code, out)
	code, out = postThinkingJSON(t, server.URL+"/api/sessions/launch", map[string]any{"working_dir": t.TempDir(), "agent_type": "claude", "model": "bad/none"})
	assert.Equal(t, 200, code, "the check is Pi's: "+out)
}
