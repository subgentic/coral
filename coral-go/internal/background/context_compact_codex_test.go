package background

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17562 (QA's SHOULD on #16861): a Codex /compact starts no turn, so it is confirmed by what Codex leaves instead: its "compacted" event after the time it was typed, or a context that fell. It is said not to
// have been taken (and warned) only when neither shows.
func codexCompactAfterWait(t *testing.T, compacted bool, tokensAfter int) string {
	t.Helper()
	h := newCompactHarness(t, true)
	sn := h.agent("Dev", "s1", "codex", "Dev", 312000, time.Minute)
	h.c.compactedSince = func(string, time.Time) bool { return compacted }
	h.run(0)
	require.Len(t, h.sent(), 1)
	h.tokens["s1"] = tokensAfter
	h.run(compactConfirmWait + time.Second)
	st, ok := h.c.Status(sn)
	require.True(t, ok)
	assert.Len(t, h.sent(), 1, "and it is not typed again")
	return st.Text
}

func TestACodexCompactIsConfirmedByItsCompactedEvent(t *testing.T) {
	text := codexCompactAfterWait(t, true, 312000)
	assert.Contains(t, text, "compacted ")
	assert.NotContains(t, text, "not taken")
	assert.NotContains(t, text, "cannot confirm")
}

func TestACodexCompactIsConfirmedByAFallInItsContext(t *testing.T) {
	text := codexCompactAfterWait(t, false, 90000)
	assert.Contains(t, text, "fell from 312k to 90k")
	assert.NotContains(t, text, "not taken")
}

func TestACodexCompactWithNeitherSignIsSaidNotToHaveBeenTaken(t *testing.T) {
	text := codexCompactAfterWait(t, false, 312000)
	assert.Contains(t, text, "not taken by the CLI")
	assert.Contains(t, text, "no compacted event")
}

func TestTheCompactedRecordIsReadFromTheSessionFile(t *testing.T) {
	typed := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	lines := `{"timestamp":"2026-11-16T09:00:00.000Z","type":"compacted","payload":{"message":""}}
{"timestamp":"2026-11-16T09:30:00.000Z","type":"event_msg","payload":{"text":"the word \"compacted\" in a message"}}
`
	require.NoError(t, os.WriteFile(path, []byte(lines), 0o600))
	read := func() bool {
		f, err := os.Open(path)
		require.NoError(t, err)
		defer f.Close()
		return compactedRecordSince(f, typed)
	}
	assert.False(t, read(), "an older compaction, and a message that only mentions the word, do not confirm this one")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	require.NoError(t, err)
	_, err = f.WriteString(`{"timestamp":"2026-11-16T10:00:20.500Z","type":"compacted","payload":{"message":""}}` + "\n")
	require.NoError(t, err)
	require.NoError(t, f.Close())
	assert.True(t, read(), "a compacted record after it was typed does")
}

// A real compacted record carries the replacement history and runs to megabytes (200 KB to 4 MB seen): a tail cut inside it must not lose it (#17562 review).
func TestALargeCompactedRecordLastInTheFileIsStillRead(t *testing.T) {
	typed := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	big := `{"timestamp":"2026-11-16T10:00:20.500Z","type":"compacted","payload":{"replacement_history":"` + strings.Repeat("x", 3<<20) + `"}}` + "\n"
	pad := strings.Repeat(`{"timestamp":"2026-11-16T09:00:00Z","type":"event_msg","payload":{"text":"older"}}`+"\n", 200000)
	require.NoError(t, os.WriteFile(path, []byte(pad+big), 0o600))
	f, err := os.Open(path)
	require.NoError(t, err)
	defer f.Close()
	assert.True(t, compactedRecordSince(f, typed), "a 3 MB compacted line at the end of a large file confirms")
}

func TestOnlyARegularSessionFileIsOpened(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CODEX_HOME", dir)
	sid := "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001"
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "sessions", "2026", "11", "16"), 0o700))
	target := filepath.Join(dir, "real.jsonl")
	require.NoError(t, os.WriteFile(target, []byte(`{"timestamp":"2026-11-16T10:00:20Z","type":"compacted"}`+"\n"), 0o600))
	require.NoError(t, os.Symlink(target, filepath.Join(dir, "sessions", "2026", "11", "16", "rollout-2026-11-16T10-00-00-"+sid+".jsonl")))
	assert.False(t, codexCompactedSince(sid, time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)), "a link at the session path is not followed")
}
