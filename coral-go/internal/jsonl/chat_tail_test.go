package jsonl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// Coral Live's chat (#21094): per CLI, a transcript with every kind of entry the CLI writes: only what a person typed and what the agent said in words comes out. A CLI with no row here has no chat (ChatSupported).

const (
	chatSid       = "11111111-0000-4000-8000-0000000000c1"
	toolOutMarker = "TOOLOUT-MARKER-9917"
)

// chatFixture writes one CLI's transcript where its reader looks, and says the words that must come out, oldest first.
type chatFixture struct {
	agent string
	setup func(t *testing.T) (sid, wd string)
	want  []string // the texts, oldest first, as role:text
}

func claudeChatFixture(t *testing.T) (string, string) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	lines := []string{
		`{"type":"user","timestamp":"2026-10-29T10:00:00.000Z","message":{"content":"typed one"}}`,
		`{"type":"assistant","timestamp":"2026-10-29T10:00:01.000Z","message":{"content":[{"type":"thinking","thinking":"` + toolOutMarker + ` thought"},{"type":"text","text":"reply one"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo ` + toolOutMarker + `"}}]}}`,
		`{"type":"user","timestamp":"2026-10-29T10:00:02.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"` + toolOutMarker + ` result"}]}}`,
		`{"type":"user","timestamp":"2026-10-29T10:00:03.000Z","message":{"content":"<system-reminder>` + toolOutMarker + ` reminder</system-reminder>"}}`,
		`{"type":"user","timestamp":"2026-10-29T10:00:04.000Z","message":{"content":"You have 1 unread message on the message board. Run 'coral-board read' to see them."}}`,
		`{"type":"user","timestamp":"2026-10-29T10:00:05.000Z","isMeta":true,"message":{"content":"` + toolOutMarker + ` skill text"}}`,
		`{"type":"system","subtype":"local_command","timestamp":"2026-10-29T10:00:06.000Z","content":"<command-name>/model</command-name><command-args>sonnet</command-args>"}`,
		`{"type":"attachment","timestamp":"2026-10-29T10:00:07.000Z","attachment":{"type":"queued_command","origin":{"kind":"task-notification"},"prompt":"` + toolOutMarker + ` queued"}}`,
		`{"type":"user","timestamp":"2026-10-29T10:00:08.000Z","message":{"content":[{"type":"text","text":"see this"},{"type":"image","source":{"type":"base64","data":"QUJD"}}]}}`,
		`{"type":"assistant","timestamp":"2026-10-29T10:00:09.000Z","message":{"content":[{"type":"text","text":"reply two"}]}}`,
		`{"type":"user","timestamp":"2026-10-29T10:00:10.000Z","message":{"content":"typed two"}}`,
	}
	require.NoError(t, os.WriteFile(filepath.Join(project, chatSid+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644))
	return chatSid, ""
}

func codexChatFixture(t *testing.T) (string, string) {
	dir := t.TempDir()
	sid := "019e9db7-58df-7082-a954-7305c01b1490"
	home := filepath.Join(dir, ".codex")
	sd := filepath.Join(home, "sessions", "2026", "10", "25")
	require.NoError(t, os.MkdirAll(sd, 0o755))
	t.Setenv("CODEX_HOME", home)
	fx, err := os.ReadFile(filepath.Join("testdata", "codex_replies_7419.jsonl"))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(sd, "rollout-2026-10-25T04-56-00-"+sid+".jsonl"), fx, 0o644))
	return sid, ""
}

func agyChatFixture(t *testing.T) (string, string) {
	dir := t.TempDir()
	t.Setenv("ANTIGRAVITY_DATA_DIR", filepath.Join(dir, "brain"))
	sid := "14c7245b-9fb4-67de-871c-a03f6186ed30"
	logs := filepath.Join(dir, "brain", "conv-1", ".system_generated", "logs")
	require.NoError(t, os.MkdirAll(logs, 0o755))
	lines := []string{
		`{"step_index":0,"type":"USER_INPUT","created_at":"2026-10-29T10:00:00Z","content":"` + at.CoralSessionMarkerPrefix + ` ` + sid + ` typed one"}`,
		`{"step_index":1,"type":"PLANNER_RESPONSE","created_at":"2026-10-29T10:00:09Z","content":"reply one","tool_calls":[{"name":"run_command","args":{"CommandLine":"echo ` + toolOutMarker + `"}}]}`,
		`{"step_index":2,"type":"GENERIC","created_at":"2026-10-29T10:00:10Z","content":"` + toolOutMarker + ` result"}`,
		`{"step_index":3,"type":"PLANNER_RESPONSE","created_at":"2026-10-29T10:00:11Z","content":"reply two"}`,
	}
	require.NoError(t, os.WriteFile(filepath.Join(logs, "transcript.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644))
	return sid, "/ws"
}

func piChatFixture(t *testing.T) (string, string) {
	fx, err := os.ReadFile(filepath.Join("testdata", "pi-1.4.0", "session.jsonl"))
	require.NoError(t, err)
	piFixtureHome(t, piTestSession, fx)
	return piTestSession, "/work/pi-project"
}

func chatFixtures() map[string]struct {
	setup func(t *testing.T) (string, string)
	want  []string
} {
	return map[string]struct {
		setup func(t *testing.T) (string, string)
		want  []string
	}{
		at.Claude: {claudeChatFixture, []string{"user:typed one", "assistant:reply one", "assistant:reply two", "user:typed two"}},
		at.Codex:  {codexChatFixture, nil}, // checked by its own markers below
		at.Agy:    {agyChatFixture, []string{"assistant:reply one", "assistant:reply two"}},
		at.Pi: {piChatFixture, []string{"user:FIXTURE-USER-1 question", "user:FIXTURE-USER-2 question", "assistant:FIXTURE-ASSISTANT-1 answer",
			"user:FIXTURE-USER-3 question", "assistant:FIXTURE-ASSISTANT-2 answer", "user:FIXTURE-USER-4 question", "assistant:FIXTURE-ASSISTANT-3 answer"}},
	}
}

func asLines(ms []ChatMessage) []string {
	var out []string
	for _, m := range ms {
		out = append(out, m.Role+":"+m.Text)
	}
	return out
}

// Every CLI Coral says chat works for has a fixture here, and each fixture shows its tool output, reminders, deliveries, thinking, attachments and slash commands stay out.
func TestChatTailOnlyTypedAndSpokenWordsForEveryCLI(t *testing.T) {
	fx := chatFixtures()
	for _, typ := range []string{at.Claude, at.Codex, at.Agy, at.Antigravity, at.Gemini, at.Pi, at.Opencode, at.Hermes, "terminal", ""} {
		_, has := fx[typ]
		assert.Equal(t, has, ChatSupported(typ), "%q: chat is on only for a CLI with fixtures", typ)
	}
	for typ, f := range fx {
		t.Run(typ, func(t *testing.T) {
			sid, wd := f.setup(t)
			got, ok := NewSessionReader().ChatTail(sid, wd, typ, 12)
			require.True(t, ok)
			lines := asLines(got)
			for _, l := range lines {
				assert.NotContains(t, l, toolOutMarker, "tool output, thinking or a reminder reached the chat")
				assert.NotContains(t, l, "coral-board read", "a Coral delivery reached the chat")
				assert.NotContains(t, l, "Error: 400", "a provider error is not the agent's words")
			}
			if f.want != nil {
				assert.Equal(t, f.want, lines)
			} else {
				require.NotEmpty(t, lines)
				assert.Contains(t, strings.Join(lines, "\n"), "assistant:REPLY7419-TWO")
				for _, l := range lines {
					assert.False(t, strings.Contains(l, "call_") || strings.Contains(l, "fixture.txt\n"), l)
				}
			}
			few, ok := NewSessionReader().ChatTail(sid, wd, typ, 2)
			require.True(t, ok)
			assert.Len(t, few, 2, "the newest 2 only")
			assert.Equal(t, lines[len(lines)-2:], asLines(few))
		})
	}
}

func TestChatTailRefusesAnUnsupportedCLIAndABadSession(t *testing.T) {
	sid, wd := claudeChatFixture(t)
	_, ok := NewSessionReader().ChatTail(sid, wd, at.Opencode, 12)
	assert.False(t, ok)
	_, ok = NewSessionReader().ChatTail("not-an-id", wd, at.Claude, 12)
	assert.False(t, ok)
	_, ok = NewSessionReader().ChatTail(sid, wd, at.Claude, 0)
	assert.False(t, ok)
}

// A long session is read from its end only, and 12 messages come out in order.
func TestChatTailReadsTheEndOfALongSession(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	var b strings.Builder
	for i := 0; i < 20000; i++ {
		b.WriteString(`{"type":"assistant","timestamp":"2026-10-29T10:00:00.000Z","message":{"content":[{"type":"text","text":"old padding padding padding padding"}]}}` + "\n")
	}
	for i := 0; i < 14; i++ {
		b.WriteString(`{"type":"user","timestamp":"2026-10-29T11:00:00.000Z","message":{"content":"new ` + string(rune('a'+i)) + `"}}` + "\n")
	}
	require.NoError(t, os.WriteFile(filepath.Join(project, chatSid+".jsonl"), []byte(b.String()), 0o644))
	var read int64
	lastMessageReadHook = nil
	got, ok := NewSessionReader().ChatTail(chatSid, "", at.Claude, 12)
	require.True(t, ok)
	_ = read
	require.Len(t, got, 12)
	assert.Equal(t, "new c", got[0].Text)
	assert.Equal(t, "new n", got[11].Text)
}
