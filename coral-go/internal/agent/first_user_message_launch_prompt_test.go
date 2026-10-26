package agent

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7756: the launch prompt Coral gave the agent (the knowledge section, the board's action text) is not what a person typed: a chat that holds only it has no first message, and the first real message after it is kept.
func TestFirstUserMessageSkipsTheLaunchPrompt(t *testing.T) {
	launch := "You are the Lead Developer.\\n\\n---\\n\\n" + KnowledgeSectionHeading + "\\n\\n" + KnowledgeSectionIntro + " Use this to keep continuity.\\n\\n" + launchPromptBoardMarker + " \\\"team\\\". Do NOT run coral-board join."
	base := t.TempDir()
	writeLines(t, filepath.Join(base, "p", "00000000-0000-4000-8000-000000007756.jsonl"),
		`{"type":"user","timestamp":"2026-10-25T00:00:00Z","message":{"role":"user","content":"`+launch+`"}}`,
		`{"type":"assistant","timestamp":"2026-10-25T00:00:01Z","message":{"content":[{"type":"text","text":"Joined."}]}}`)
	writeLines(t, filepath.Join(base, "p", "00000000-0000-4000-8000-000000007757.jsonl"),
		`{"type":"user","timestamp":"2026-10-25T00:00:00Z","message":{"role":"user","content":"`+launch+`"}}`,
		`{"type":"user","timestamp":"2026-10-25T00:00:02Z","message":{"role":"user","content":"## Fix the **login** redirect"}}`,
		`{"type":"assistant","timestamp":"2026-10-25T00:00:03Z","message":{"content":[{"type":"text","text":"ok"}]}}`)
	got, err := (&ClaudeAgent{}).ExtractSessions(base, nil)
	require.NoError(t, err)
	require.Len(t, got, 2)
	first := map[string]string{}
	for _, s := range got {
		first[s.SessionID] = s.FirstUserMessage
	}
	assert.Equal(t, "", first["00000000-0000-4000-8000-000000007756"], "a chat with only the launch prompt has no first message")
	assert.Equal(t, "## Fix the **login** redirect", first["00000000-0000-4000-8000-000000007757"])
}

func TestIsLaunchPromptText(t *testing.T) {
	assert.True(t, IsLaunchPromptText("--- ## x\n"+KnowledgeSectionHeading+"\n\n"+KnowledgeSectionIntro+" more"))
	assert.True(t, IsLaunchPromptText("IMPORTANT: "+launchPromptBoardMarker+` "team".`))
	assert.False(t, IsLaunchPromptText("Why is the knowledge section empty?"))
	assert.False(t, IsLaunchPromptText(KnowledgeSectionHeading+" without its sentence"))
}
