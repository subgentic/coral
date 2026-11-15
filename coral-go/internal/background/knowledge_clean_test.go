package background

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An agent's document is the document alone (#17544): an apology before it, a code fence round it and its raw front matter in a block are what the model said about its work, not what the
// agent learned; the index is titled by the team, not by its board id; and a worker that only names the Orchestrator in its prompt is not the orchestrator.
func TestADistilledDocumentKeepsNoChatterAndTheIndexIsTitledByTheTeam(t *testing.T) {
	chatter := "I couldn't save the file, because the write to the scratchpad path was denied. Here is the document in full instead:\n\n```markdown\n---\ntype: Agent Knowledge\ntitle: Developer 2\ntags: [worker]\n---\n\n# Developer 2\n\nUses go test.\n```\n"
	got := cleanKnowledgeDoc(chatter)
	assert.True(t, strings.HasPrefix(got, "---\ntype: Agent Knowledge"), got)
	assert.NotContains(t, got, "couldn't save")
	assert.NotContains(t, got, "```")
	assert.Contains(t, got, "Uses go test.")

	assert.Equal(t, "---\ntype: X\n---\n\nbody\n", cleanKnowledgeDoc("---\ntype: X\n---\n\nbody\n"), "a clean document is left as it is")
	assert.Equal(t, "", cleanKnowledgeDoc("I could not do that."), "words with no document in them are no document")

	assert.Equal(t, "worker", inferRole("Message the Orchestrator when a task is done."))
	assert.Equal(t, "orchestrator", inferRole("You are the Orchestrator of this team."))

	agents := []agentMeta{{name: "Developer 2", role: "worker", transcript: "work"}}
	bundle := &KnowledgeBundle{TeamName: "b-kcvwz7n4h7", TeamTitle: "coral-test", Agents: map[string]*AgentConcept{}}
	call := func(prompt, content string) (string, error) {
		if strings.Contains(prompt, "converting agent knowledge") {
			return chatter, nil
		}
		return "extract", nil
	}
	out, err := distillAgentsWith(bundle, agents, call, t.TempDir(), func(string, *KnowledgeBundle) error { return nil }, nil)
	require.NoError(t, err)
	assert.Contains(t, out.IndexMD, "title: coral-test")
	assert.Contains(t, out.IndexMD, "# coral-test — Team Knowledge")
	assert.NotContains(t, out.IndexMD, "b-kcvwz7n4h7 — Team Knowledge")
	assert.NotContains(t, out.Agents["Developer 2"].FinalMD, "couldn't save")
	assert.Equal(t, "coral-test", teamTitle("b-kcvwz7n4h7", "/Users/x/coral-test"))
	assert.Equal(t, "This team", teamTitle("b-kcvwz7n4h7", ""))
	assert.Equal(t, "my-team", teamTitle("my-team", "/x/y"))
}
