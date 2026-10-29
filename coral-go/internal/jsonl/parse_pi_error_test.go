package jsonl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11092 (Pi parity row 9): the provider's error for Pi's last turn is the errorMessage of its newest assistant message (Pi 1.4.0, stopReason "error"), read from the session file in Coral's folder.
func TestPiLastErrorIsTheLastTurnsProviderError(t *testing.T) {
	data := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", data)
	const sid = "11111111-2222-4333-8444-555555555555"
	dir := filepath.Join(data, "pi-sessions", sid)
	require.NoError(t, os.MkdirAll(dir, 0o700))
	write := func(lines ...string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o600))
	}
	hdr := `{"type":"session","version":3,"id":"x","cwd":"/w"}`
	user := `{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`
	bad := `{"type":"message","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"OpenAI API error (400): {\"type\":\"invalid_request_error\",\"code\":\"model_not_found\",\"message\":\"The 'gpt-4' model is not supported.\"}"}}`
	good := `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}`

	assert.Equal(t, "", PiLastError(sid), "no file yet")
	write(hdr, user, bad)
	assert.Contains(t, PiLastError(sid), "model_not_found", "the last turn failed")
	write(hdr, user, bad, user)
	assert.Equal(t, "", PiLastError(sid), "a retry is under way")
	write(hdr, user, bad, user, good)
	assert.Equal(t, "", PiLastError(sid), "answered since")
	write(hdr, user, good, user, bad)
	assert.Contains(t, PiLastError(sid), "model_not_found", "a new failure after an answer")
	aborted := `{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"x"}],"stopReason":"aborted","errorMessage":"Operation aborted"}}`
	write(hdr, user, aborted)
	assert.Equal(t, "", PiLastError(sid), "Stop is the person's own doing, not a provider failure")
	assert.Equal(t, "", PiLastError("not-a-session-id"), "never a path built from a bad id")
}

// The person's Stop: Pi 1.4.0 ends the turn with stopReason "aborted" and errorMessage "Operation aborted" (seen on a real Pi after Esc mid-turn). The chat gets Claude's interrupt record, so it
// shows the interrupt and the working row ends.
func TestPiAbortedTurnIsAnInterruptInTheChat(t *testing.T) {
	toolUses := map[string]string{}
	entry := map[string]any{"type": "message", "timestamp": "2026-10-29T20:00:00.000Z", "message": map[string]any{
		"role": "assistant", "stopReason": "aborted", "errorMessage": "Operation aborted",
		"content": []any{map[string]any{"type": "thinking", "thinking": "counting"}}}}
	got := parsePiEntry(entry, toolUses)
	require.Len(t, got, 2, "the thinking Pi had done, then the interrupt")
	assert.Equal(t, "assistant", got[0]["type"])
	assert.NotEqual(t, true, got[0]["is_error"], "an interrupt is not an error")
	assert.Equal(t, "user", got[1]["type"])
	assert.Equal(t, "[Request interrupted by user]", got[1]["content"])
	// With nothing said before it, the interrupt is still there.
	entry["message"].(map[string]any)["content"] = []any{}
	got = parsePiEntry(entry, toolUses)
	require.Len(t, got, 1)
	assert.Equal(t, "[Request interrupted by user]", got[0]["content"])
}
