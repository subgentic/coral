package background

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #18293: a team's folder as the release before #17974 left it holds an agent's file named note-<x>.md. It stays an agent's file (its name gets the '_' the
// agents' names carry now) and a hand-written note beside it stays a note.
func TestAnAgentFileNamedNoteByThePreviousReleaseStaysAnAgentFile(t *testing.T) {
	isolateKnowledgeEnv(t)
	dir := t.TempDir()
	kd := filepath.Join(dir, "agent_knowledge", "alpha")
	require.NoError(t, os.MkdirAll(kd, 0o700))
	agent := "---\ntype: Agent Knowledge\ntitle: note-taker\n---\n\n# note-taker\n\nWrites things down.\n"
	hand := "---\ntype: note\ntitle: \"Deploys\"\n---\n\nShip on Tuesday.\n"
	require.NoError(t, os.WriteFile(filepath.Join(kd, "index.md"), []byte("---\ntype: index\n---\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(kd, "note-taker.md"), []byte(agent), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(kd, "note-deploys.md"), []byte(hand), 0o600))

	assert.Contains(t, LoadAgentKnowledge(dir, "alpha", "note-taker"), "Writes things down.", "the agent's own file is found under its name")
	files := knowledgeFiles(t, dir, "alpha")
	assert.NotContains(t, files, "note-taker.md")
	assert.Equal(t, agent, files["note-taker_.md"], "renamed, content untouched")
	assert.Equal(t, hand, files["note-deploys.md"], "a hand-written note is left alone")
	b, err := ReadKnowledgeBundle(dir, "alpha")
	require.NoError(t, err)
	assert.False(t, IsKnowledgeNote("note-taker_"))
	assert.True(t, IsKnowledgeNote("note-deploys"))
	assert.Contains(t, b.Agents, "note-taker_")
}

// A name that is taken is left as it is: the step warns and never fails an upgrade.
func TestTheLegacyNoteRenameNeverOverwritesAndNeverFails(t *testing.T) {
	isolateKnowledgeEnv(t)
	dir := t.TempDir()
	kd := filepath.Join(dir, "agent_knowledge", "alpha")
	require.NoError(t, os.MkdirAll(kd, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(kd, "index.md"), []byte("---\ntype: index\n---\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(kd, "note-x.md"), []byte("---\ntype: Agent Knowledge\n---\nold\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(kd, "note-x_.md"), []byte("---\ntype: Agent Knowledge\n---\nnewer\n"), 0o600))
	_, err := ReadKnowledgeBundle(dir, "alpha")
	require.NoError(t, err)
	files := knowledgeFiles(t, dir, "alpha")
	assert.Contains(t, files["note-x.md"], "old")
	assert.Contains(t, files["note-x_.md"], "newer")
}
