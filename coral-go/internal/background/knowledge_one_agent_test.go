package background

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #19560 (the Operator): one agent of a team can be distilled alone. Only its transcript is read, only its document is written (the team's index and the others stay), the same redaction applies,
// and a session that is not on the team (unknown, or on another team) is refused with the same answer.
func TestOneAgentIsDistilledAlone(t *testing.T) {
	isolateKnowledgeEnv(t)
	f := newKnowledgeTeamFixture(t, "one-agent-team")
	a, b := "aaaaaaaa-1960-4000-8000-000000000001", "bbbbbbbb-1960-4000-8000-000000000002"
	f.launch(a, "Alpha", true)
	f.launch(b, "Beta", true)
	other := newKnowledgeTeamFixtureOn(t, f, "another-team")
	c := "cccccccc-1960-4000-8000-000000000003"
	other.launch(c, "Gamma", true)

	// who is on the team: members yes; the other team's agent and an unknown id no
	assert.True(t, KnowledgeAgentOnTeam(f.ctx, f.ss, f.ts, "one-agent-team", a))
	assert.False(t, KnowledgeAgentOnTeam(f.ctx, f.ss, f.ts, "one-agent-team", c), "an agent of another team is refused")
	assert.False(t, KnowledgeAgentOnTeam(f.ctx, f.ss, f.ts, "one-agent-team", "dddddddd-1960-4000-8000-00000000dead"), "an unknown session is refused")
	assert.False(t, KnowledgeAgentOnTeam(f.ctx, f.ss, f.ts, "one-agent-team", ""))

	// a team's earlier knowledge: an index and two documents
	coral := t.TempDir()
	dir := filepath.Join(coral, "agent_knowledge", "one-agent-team")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	for name, body := range map[string]string{"index.md": "OLD INDEX", "alpha.md": "OLD ALPHA", "beta.md": "OLD BETA"} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600))
	}

	agents, err := teamKnowledgeAgentsMeta(f.ctx, f.ss, f.ts, "one-agent-team", false)
	require.NoError(t, err)
	for _, m := range agents {
		assert.Empty(t, m.transcript, "the membership check reads no transcript")
	}
	only, err := onlyKnowledgeAgent(agents, a)
	require.NoError(t, err)
	require.Len(t, only, 1)
	only[0].transcript = "Alpha worked on the parser. " + knowledgeToken
	_, err = onlyKnowledgeAgent(agents, c)
	assert.ErrorIs(t, err, ErrKnowledgeAgentNotOnTeam)

	var prompts []string
	call := func(prompt, content string) (string, error) {
		prompts = append(prompts, prompt)
		if strings.Contains(prompt, "OKF") {
			return "---\ntype: Agent Knowledge\n---\n# Alpha\nuses " + knowledgeToken, nil
		}
		return "extracted " + knowledgeToken, nil
	}
	bundle := &KnowledgeBundle{TeamName: "one-agent-team", Agents: map[string]*AgentConcept{}}
	_, err = distillAgentsOpts(bundle, only, call, coral, writeAgentKnowledge, nil, true)
	require.NoError(t, err)
	assert.Len(t, prompts, 2, "one extraction and one formatting call: no collaboration pass, nothing for Beta")
	for _, p := range prompts {
		assert.NotContains(t, p, "Beta")
	}

	files := knowledgeFiles(t, coral, "one-agent-team")
	assert.Equal(t, "OLD INDEX", files["index.md"], "the team's index is not rewritten")
	assert.Equal(t, "OLD BETA", files["beta.md"], "another agent's document is not touched")
	assert.NotEqual(t, "OLD ALPHA", files["alpha.md"], "its own document is new")
	assert.NotContains(t, files["alpha.md"], knowledgeToken, "the same redaction as a team run")
}

// newKnowledgeTeamFixtureOn is a second team on the same stores as f.
func newKnowledgeTeamFixtureOn(t *testing.T, f *knowledgeTeamFixture, board string) *knowledgeTeamFixture {
	g := &knowledgeTeamFixture{t: t, ctx: f.ctx, ss: f.ss, ts: f.ts, dir: t.TempDir()}
	team, err := g.ts.CreateTeam(g.ctx, &store.Team{Name: board, Status: "running", WorkingDir: g.dir})
	require.NoError(t, err)
	g.team = team
	return g
}
