package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #13899: the Orchestrator of a team starts on its own default model and thinking level when one is set; empty means it starts like the workers. Order for each, first that is set wins: the one named in the
// launch (--model, --thinking, a team member's own), for an Orchestrator default_orchestrator_*_<type>, the workers' default_*_<type>, none. A level the type does not take is dropped. Terminal agents get none.

func TestTheModelAnOrchestratorStartsOnFollowsTheOrder(t *testing.T) {
	both := map[string]string{"default_model_claude": "claude-sonnet-5-5", "default_orchestrator_model_claude": "claude-opus-5-5"}
	workersOnly := map[string]string{"default_model_claude": "claude-sonnet-5-5"}
	orchOnly := map[string]string{"default_orchestrator_model_claude": "claude-opus-5-5"}
	for name, tc := range map[string]struct {
		settings  map[string]string
		agentType string
		named     string
		orch      bool
		want      string
	}{
		"orchestrator with both set takes its own":           {both, "claude", "", true, "claude-opus-5-5"},
		"worker with both set takes the workers'":            {both, "claude", "", false, "claude-sonnet-5-5"},
		"a model named in the launch wins for an orch":       {both, "claude", "claude-haiku-5-5", true, "claude-haiku-5-5"},
		"a model named in the launch wins for a worker":      {both, "claude", "claude-haiku-5-5", false, "claude-haiku-5-5"},
		"orchestrator with no own default takes workers'":    {workersOnly, "claude", "", true, "claude-sonnet-5-5"},
		"orchestrator default only, a worker gets none":      {orchOnly, "claude", "", false, ""},
		"orchestrator default only, the orchestrator has it": {orchOnly, "claude", "", true, "claude-opus-5-5"},
		"nothing set": {nil, "claude", "", true, ""},
		"another type's orchestrator default is not used": {both, "codex", "", true, ""},
		"terminal agents never get a model":               {both, "terminal", "", true, ""},
	} {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, tc.want, defaultModelForRole(tc.settings, tc.agentType, tc.named, tc.orch))
		})
	}
}

func TestTheThinkingLevelAnOrchestratorStartsOnFollowsTheOrder(t *testing.T) {
	both := map[string]string{"default_thinking_claude": "medium", "default_orchestrator_thinking_claude": "high"}
	workersOnly := map[string]string{"default_thinking_claude": "medium"}
	badOrch := map[string]string{"default_thinking_claude": "medium", "default_orchestrator_thinking_claude": "warp-speed"}
	codex := map[string]string{"default_thinking_codex": "low", "default_orchestrator_thinking_codex": "xhigh"}
	for name, tc := range map[string]struct {
		settings  map[string]string
		agentType string
		named     string
		orch      bool
		want      string
	}{
		"orchestrator with both set takes its own":                                      {both, "claude", "", true, "high"},
		"worker takes the workers'":                                                     {both, "claude", "", false, "medium"},
		"a level named in the launch wins":                                              {both, "claude", "low", true, "low"},
		"a named level the type does not take is dropped":                               {both, "claude", "warp-speed", true, ""},
		"orchestrator with no own default takes the workers'":                           {workersOnly, "claude", "", true, "medium"},
		"an orchestrator level the type does not take is skipped, the workers' applies": {badOrch, "claude", "", true, "medium"},
		"codex has its own levels":                                                      {codex, "codex", "", true, "xhigh"},
		"a type with no levels gets none":                                               {map[string]string{"default_orchestrator_thinking_gemini": "high"}, "gemini", "", true, ""},
		"terminal agents get none":                                                      {both, "terminal", "", true, ""},
	} {
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, tc.want, defaultThinkingForRole(tc.settings, tc.agentType, tc.named, tc.orch))
		})
	}
}

func TestWhoIsAnOrchestratorIsTheBoardsOwnTest(t *testing.T) {
	assert.True(t, isOrchestratorRole("Orchestrator", "claude"))
	assert.True(t, isOrchestratorRole("Team Orchestrator", "codex"))
	assert.False(t, isOrchestratorRole("Dev", "claude"))
	assert.False(t, isOrchestratorRole("", "claude"), "a single launch with no name is a worker")
}

// The same order through the real launch and team launch, on what the CLI is started with.
func TestAnOrchestratorsLaunchTakesItsModelAndAWorkersTheWorkers(t *testing.T) {
	cfg := &config.Config{LogDir: t.TempDir()}
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	require.NoError(t, ss.SetSetting(ctx, "default_model_claude", "claude-sonnet-5-5"))
	require.NoError(t, ss.SetSetting(ctx, "default_orchestrator_model_claude", "claude-opus-5-5"))
	terminal := newMockTerminal()
	h := NewSessionsHandler(db, cfg, nil, terminal, nil)
	last := func() string {
		cmds := terminal.sentCommands()
		require.NotEmpty(t, cmds)
		return cmds[len(cmds)-1]
	}
	single := func(name, model string) string {
		body := map[string]any{"working_dir": t.TempDir(), "agent_type": "claude", "display_name": name}
		if model != "" {
			body["model"] = model
		}
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		h.Launch(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b)))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		return last()
	}
	assert.Contains(t, single("Orchestrator", ""), "claude-opus-5-5", "a single launch named Orchestrator")
	assert.Contains(t, single("Dev", ""), "claude-sonnet-5-5", "a worker")
	assert.Contains(t, single("Orchestrator", "claude-haiku-5-5"), "claude-haiku-5-5", "a named model wins")
	// a team launch: each member by its own role
	before := len(terminal.sentCommands())
	b, _ := json.Marshal(map[string]any{"board_name": "dm", "new_board": true, "working_dir": t.TempDir(), "agent_type": "claude",
		"agents": []map[string]any{{"name": "Orchestrator", "prompt": "lead"}, {"name": "Dev", "prompt": "work"}, {"name": "Dev2", "prompt": "work", "model": "claude-haiku-5-5"}}})
	rec := httptest.NewRecorder()
	h.LaunchTeam(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch-team", bytes.NewReader(b)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	cmds := terminal.sentCommands()[before:]
	require.Len(t, cmds, 3)
	joined := strings.Join(cmds, "\n")
	assert.Equal(t, 1, strings.Count(joined, "claude-opus-5-5"), "only the Orchestrator member")
	assert.Equal(t, 1, strings.Count(joined, "claude-sonnet-5-5"), "only the plain worker")
	assert.Equal(t, 1, strings.Count(joined, "claude-haiku-5-5"), "the member that named its own")
}

func TestTheOrchestratorSettingsAreSettingsOfTheFamily(t *testing.T) {
	for _, key := range []string{"default_orchestrator_model_claude", "default_orchestrator_model_codex", "default_orchestrator_thinking_claude", "default_orchestrator_thinking_codex"} {
		_, ok := lookupSetting(key)
		assert.True(t, ok, key)
	}
	for _, key := range []string{"default_orchestrator_model_nonsense", "default_orchestrator_thinking_", "default_orchestrator_model_"} {
		_, ok := lookupSetting(key)
		assert.False(t, ok, key)
	}
	// a thinking level the type does not take is refused when saved
	body := map[string]any{"default_orchestrator_thinking_claude": "warp-speed"}
	assert.Error(t, checkSettingKeys(body))
	body = map[string]any{"default_orchestrator_thinking_claude": "high", "default_orchestrator_model_claude": "claude-opus-5-5"}
	assert.NoError(t, checkSettingKeys(body))
}
