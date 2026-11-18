package startup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/secrets"
)

// #18544 (Security SHOULD on #16958): a run keeps what its agent said last redacted BEFORE it is cut, so a secret that straddles the cut is redacted whole and not left as a partial token.
func TestARunsResultIsRedactedBeforeItIsCutSoACutCannotLeavePartOfASecret(t *testing.T) {
	const secret = "ghp_R7xK2mQ9vL4nB8tZ3wY6cD1fH5jP0sA2gE9u"
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	sid := "22222222-0000-4000-8000-000000000001"
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "proj"), 0o755))
	write := func(text string) {
		line, _ := json.Marshal(map[string]any{"type": "assistant", "timestamp": "2026-11-18T10:00:05.000Z", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}})
		require.NoError(t, os.WriteFile(filepath.Join(dir, "proj", sid+".jsonl"), append(line, '\n'), 0o644))
	}
	read := runResultReader(jsonl.NewSessionReader(), secrets.Redactor())

	// the token starts 12 characters before the cut: a cut-first reader keeps "ghp_R7xK2mQ9", too short to be found as a token
	prefix := strings.Repeat("a", runResultMaxRunes-12)
	write(prefix + secret + " and then more words")
	got := read(sid, "", "claude")
	require.NotEmpty(t, got)
	assert.NotContains(t, got, "ghp_", "no part of the token is kept")
	assert.NotContains(t, got, secret[:20])

	// a token wholly inside the kept text is redacted as before
	write("the key is " + secret + " done")
	got = read(sid, "", "claude")
	assert.NotContains(t, got, secret)
	assert.Contains(t, got, "done")

	// a plain long message is still cut to the limit
	write(strings.Repeat("word ", 500))
	assert.LessOrEqual(t, len([]rune(read(sid, "", "claude"))), runResultMaxRunes)
}
