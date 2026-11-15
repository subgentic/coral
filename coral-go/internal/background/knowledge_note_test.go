package background

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A person adds a note by hand to a team with no knowledge yet; the team then has a bundle that reads back, with the note in it (#17485).
func TestANoteAddedByHandIsInTheTeamsKnowledge(t *testing.T) {
	isolateKnowledgeEnv(t)
	dir := t.TempDir()
	name, redacted, err := AddKnowledgeNote(dir, "alpha", `Deploys: "never" on Fridays`, "Ship on Tuesday.\n\nCall the on-call first.")
	require.NoError(t, err)
	assert.False(t, redacted)
	assert.Equal(t, "note-deploys-never-on-fridays", name)
	b, err := ReadKnowledgeBundle(dir, "alpha")
	require.NoError(t, err)
	require.NotNil(t, b, "a team with only notes still reads back as a bundle")
	md := b.Agents[name].FinalMD
	assert.Contains(t, md, "type: note")
	assert.Contains(t, md, `title: "Deploys: \"never\" on Fridays"`)
	assert.Contains(t, md, "Call the on-call first.")
	assert.True(t, IsKnowledgeNote(name))
}

func TestANoteNeedsATitleAndTextNeverReplacesANoteAndIsRedacted(t *testing.T) {
	isolateKnowledgeEnv(t)
	dir := t.TempDir()
	for _, c := range []struct{ title, text string }{{"", "x"}, {"  ", "x"}, {"two\nlines", "x"}, {"!!!", "x"}, {strings.Repeat("a", 121), "x"}, {"ok", " "}, {"ok", strings.Repeat("a", MaxNoteText+1)}} {
		_, _, err := AddKnowledgeNote(dir, "alpha", c.title, c.text)
		assert.Error(t, err, "%q / %d chars", c.title, len(c.text))
	}
	_, err := os.Stat(filepath.Join(dir, "agent_knowledge", "alpha"))
	if err == nil {
		assert.Empty(t, knowledgeFiles(t, dir, "alpha"), "a refused note leaves nothing behind")
	}
	_, _, err = AddKnowledgeNote(dir, "alpha", "Same title", "first")
	require.NoError(t, err)
	_, _, err = AddKnowledgeNote(dir, "alpha", "Same Title", "second")
	assert.ErrorIs(t, err, ErrNoteExists)
	assert.Contains(t, knowledgeFiles(t, dir, "alpha")["note-same-title.md"], "first", "the first note is untouched")
	_, redacted, err := AddKnowledgeNote(dir, "alpha", "Keys", "the token is "+knowledgeToken)
	require.NoError(t, err)
	assert.True(t, redacted)
	assert.NotContains(t, knowledgeFiles(t, dir, "alpha")["note-keys.md"], knowledgeToken)
	_, _, err = AddKnowledgeNote(dir, "../evil", "x", "y")
	assert.ErrorIs(t, err, ErrBadKnowledgeTeam)
}

// A distillation writes the agents' files and the index and leaves a note alone.
func TestADistillationLeavesAHandWrittenNoteAlone(t *testing.T) {
	isolateKnowledgeEnv(t)
	dir := t.TempDir()
	name, _, err := AddKnowledgeNote(dir, "alpha", "Mine", "my words")
	require.NoError(t, err)
	b := &KnowledgeBundle{TeamName: "alpha", IndexMD: "new index", Agents: map[string]*AgentConcept{"lead": {AgentName: "lead", FinalMD: "lead notes"}}}
	require.NoError(t, writeKnowledgeBundle(dir, b))
	files := knowledgeFiles(t, dir, "alpha")
	assert.Contains(t, files[name+".md"], "my words")
	assert.Equal(t, "new index", files["index.md"])
}
