package routes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21811: a goal closed with a result keeps the result link in its closing reason (the goals page shows it); the link must be a file of the team; a long reason is cut, not refused.
func TestAGoalClosesWithItsResultLinkOrTheReasonThereIsNone(t *testing.T) {
	dir := t.TempDir()
	id := strings.Repeat("cd", 32)
	up := filepath.Join(dir, "artifacts", "uploads", "s1")
	require.NoError(t, os.MkdirAll(up, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(up, id+".json"), []byte(`{"name":"r.md","digest":"sha256:`+id+`","board":"team"}`), 0o600))

	got, refused := goalCloseReason(dir, "team", "fine-tune shipped", "coral://artifacts/"+id, "")
	require.Empty(t, refused)
	assert.Equal(t, "fine-tune shipped Result: coral://artifacts/"+id, got)

	_, refused = goalCloseReason(dir, "other-team", "x", "coral://artifacts/"+id, "")
	assert.Contains(t, refused, "not a file of this team", "another team's file")
	_, refused = goalCloseReason(dir, "team", "x", "coral://artifacts/not-a-digest", "")
	assert.Contains(t, refused, "coral://artifacts/<digest>")

	got, refused = goalCloseReason(dir, "team", "dropped", "", "nothing was made")
	require.Empty(t, refused)
	assert.Equal(t, "dropped No result file: nothing was made", got)

	got, refused = goalCloseReason(dir, "team", strings.Repeat("w", 400), "coral://artifacts/"+id, "")
	require.Empty(t, refused)
	assert.LessOrEqual(t, len([]rune(got)), 300, "cut to fit the reason limit")
	assert.True(t, strings.HasSuffix(got, "Result: coral://artifacts/"+id))

	got, refused = goalCloseReason(dir, "team", "plain", "", "")
	assert.Equal(t, "plain", got, "a caller with neither (the dashboard) is unchanged")
	assert.Empty(t, refused)
}
