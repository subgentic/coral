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

// Security on #17485 (#17974): the create itself refuses an existing file, so a save that lands between the look and the create is refused, not overwritten.
func TestTwoSavesOfOneTitleCannotOverwriteEachOther(t *testing.T) {
	isolateKnowledgeEnv(t)
	dir := t.TempDir()
	noteBeforeCreate = func() { // the other save wins the race
		noteBeforeCreate = nil
		_, _, err := AddKnowledgeNote(dir, "alpha", "Deploys", "the first save's words")
		require.NoError(t, err)
	}
	t.Cleanup(func() { noteBeforeCreate = nil })
	_, _, err := AddKnowledgeNote(dir, "alpha", "Deploys", "the second save's words")
	require.ErrorIs(t, err, ErrNoteExists)
	b, err := ReadKnowledgeBundle(dir, "alpha")
	require.NoError(t, err)
	assert.Contains(t, b.Agents["note-deploys"].FinalMD, "the first save's words")
	assert.NotContains(t, b.Agents["note-deploys"].FinalMD, "second")
}

// A note's file and an agent's can never be the same file: an agent named note-deploys neither overwrites the note nor reads as one (#17974).
func TestANoteAndAnAgentNamedLikeItAreTwoFiles(t *testing.T) {
	isolateKnowledgeEnv(t)
	dir := t.TempDir()
	name, _, err := AddKnowledgeNote(dir, "alpha", "Deploys", "the note's words")
	require.NoError(t, err)
	require.Equal(t, "note-deploys", name)
	_, err = WriteKnowledgeFile(dir, "alpha", "note-deploys", "the agent's words")
	require.NoError(t, err)
	b, err := ReadKnowledgeBundle(dir, "alpha")
	require.NoError(t, err)
	assert.Contains(t, b.Agents["note-deploys"].FinalMD, "the note's words", "the note is as it was")
	assert.NotContains(t, b.Agents["note-deploys"].FinalMD, "the agent's")
	assert.True(t, IsKnowledgeNote("note-deploys"))
	var agentFile string
	for n, a := range b.Agents {
		if strings.Contains(a.FinalMD, "the agent's words") {
			agentFile = n
		}
	}
	require.NotEmpty(t, agentFile, "the agent's words went to a file of their own")
	assert.False(t, IsKnowledgeNote(agentFile), "and it is not read as a note")
	// a title whose slug ends in '_' (a device name) still gives a note name no agent file can have
	n2, _, err := AddKnowledgeNote(dir, "alpha", "con", "x")
	require.NoError(t, err)
	assert.True(t, IsKnowledgeNote(n2), n2)
	assert.False(t, strings.HasSuffix(n2, "_"))
}
