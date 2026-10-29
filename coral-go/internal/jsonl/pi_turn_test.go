package jsonl

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11091: a Pi agent's working or idle state, and its model and thinking level, come from its session file. A user turn (and a tool result, and an assistant message that ended in a tool call) is a turn
// going on; an assistant message that ended with stop, length, aborted or error is the end of it. model_change, thinking_level_change and each assistant message's model and thinkingLevel are what the chips show.
type piLines struct {
	t    *testing.T
	file string
	n    int
}

func newPiLines(t *testing.T, sessionID string) *piLines {
	dir := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", dir)
	t.Setenv("PI_CODING_AGENT_DIR", filepath.Join(dir, "no-pi-home"))
	sd := filepath.Join(dir, "pi-sessions", sessionID)
	require.NoError(t, os.MkdirAll(sd, 0o700))
	p := &piLines{t: t, file: filepath.Join(sd, "2026-10-29T10-00-00-000Z_01a18931-58c2-74fc-8a74-bed622970705.jsonl")}
	p.add(`{"type":"session","version":3,"id":"00000000-0000-4000-8000-0000000000f1","timestamp":"2026-10-29T10:00:00.000Z","cwd":"/work"}`)
	return p
}

func (p *piLines) add(line string) {
	f, err := os.OpenFile(p.file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	require.NoError(p.t, err)
	defer f.Close()
	_, err = f.WriteString(line + "\n")
	require.NoError(p.t, err)
	p.n++
}

func (p *piLines) at() string { return fmt.Sprintf("2026-10-29T10:%02d:00.000Z", p.n) }

func (p *piLines) user(text string) {
	p.add(fmt.Sprintf(`{"type":"message","id":"u%d","parentId":null,"timestamp":%q,"message":{"role":"user","content":[{"type":"text","text":%q}],"timestamp":1}}`, p.n, p.at(), text))
}

func (p *piLines) assistant(stop, model, thinking string) {
	p.add(fmt.Sprintf(`{"type":"message","id":"a%d","parentId":null,"timestamp":%q,"message":{"role":"assistant","content":[{"type":"text","text":"x"}],"provider":"openai","model":%q,"thinkingLevel":%q,"stopReason":%q,"usage":{"input":1,"output":1,"totalTokens":2}}}`, p.n, p.at(), model, thinking, stop))
}

func (p *piLines) toolResult() {
	p.add(fmt.Sprintf(`{"type":"message","id":"r%d","parentId":null,"timestamp":%q,"message":{"role":"toolResult","toolCallId":"c","toolName":"bash","content":[{"type":"text","text":"ok"}],"isError":false}}`, p.n, p.at()))
}

func TestPiTurnStateFollowsTheSessionFile(t *testing.T) {
	sid := "8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d"
	f := newPiLines(t, sid)
	r := NewSessionReader()
	turn := func() (string, bool) { k, _, act := r.ReadPiTurn(sid, "/work"); return k, act }

	k, _ := turn()
	assert.Equal(t, "", k, "a new session has no turn yet")

	f.user("hello")
	k, act := turn()
	assert.Equal(t, "prompt_submit", k, "a user turn starts one: working")
	assert.False(t, act)

	f.assistant("toolUse", "gpt-6-luna", "medium")
	k, act = turn()
	assert.Equal(t, "prompt_submit", k, "an assistant message that ended in a tool call: still working")
	assert.True(t, act, "it is the turn going on, not a new turn")

	f.toolResult()
	k, act = turn()
	assert.Equal(t, "prompt_submit", k)
	assert.True(t, act)

	f.assistant("stop", "gpt-6-luna", "medium")
	k, _ = turn()
	assert.Equal(t, "stop", k, "stop ends the turn: idle")

	f.user("again")
	k, act = turn()
	assert.Equal(t, "prompt_submit", k, "a user turn after a stop is working")
	assert.False(t, act)

	f.assistant("error", "gpt-6-luna", "medium")
	k, _ = turn()
	assert.Equal(t, "stop", k, "an error ends the turn: idle, not stuck working")

	for _, stop := range []string{"length", "aborted"} {
		f.user("more")
		f.assistant(stop, "gpt-6-luna", "medium")
		k, _ = turn()
		assert.Equal(t, "stop", k, stop)
	}
}

func TestPiModelAndThinkingChips(t *testing.T) {
	sid := "7a6b5c4d-3e2f-4a1b-8c0d-9e8f7a6b5c4d"
	f := newPiLines(t, sid)
	r := NewSessionReader()
	assert.Equal(t, "", r.TranscriptModel(sid), "nothing read yet")

	f.add(`{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-10-29T10:01:00.000Z","provider":"anthropic","modelId":"claude-opus-4-8"}`)
	f.add(`{"type":"thinking_level_change","id":"t1","parentId":null,"timestamp":"2026-10-29T10:02:00.000Z","thinkingLevel":"high"}`)
	r.ReadPiTurn(sid, "/work")
	assert.Equal(t, "claude-opus-4-8", r.TranscriptModel(sid), "the model Pi was switched to, before any reply")
	assert.Equal(t, "high", r.TranscriptThinking(sid))

	f.user("hi")
	f.assistant("stop", "gpt-6-luna", "low")
	r.ReadPiTurn(sid, "/work")
	assert.Equal(t, "gpt-6-luna", r.TranscriptModel(sid), "the newest assistant message's model wins: it is the one that answered")
	assert.Equal(t, "low", r.TranscriptThinking(sid))
	assert.False(t, r.TranscriptTurnAt(sid).IsZero(), "and says when it answered, for a setting made after it")

	f.add(`{"type":"model_change","id":"m2","parentId":null,"timestamp":"2026-10-29T10:09:00.000Z","provider":"openai","modelId":"gpt-6-sol"}`)
	r.ReadPiTurn(sid, "/work")
	assert.Equal(t, "gpt-6-sol", r.TranscriptModel(sid), "a /model switch is seen at once, before the next reply")

	// Values that do not look like a model or a level are dropped, never shown.
	f.add(`{"type":"model_change","id":"m3","parentId":null,"timestamp":"2026-10-29T10:10:00.000Z","provider":"x","modelId":"<script>alert(1)</script>"}`)
	f.add(`{"type":"thinking_level_change","id":"t2","parentId":null,"timestamp":"2026-10-29T10:11:00.000Z","thinkingLevel":"HIGH; rm -rf"}`)
	r.ReadPiTurn(sid, "/work")
	assert.Equal(t, "gpt-6-sol", r.TranscriptModel(sid))
	assert.Equal(t, "low", r.TranscriptThinking(sid))
	_ = strings.TrimSpace
}
