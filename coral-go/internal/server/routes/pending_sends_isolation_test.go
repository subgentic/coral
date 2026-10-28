package routes

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10510 (Security on #10467): what a person typed to an agent (pending_sends, and the held messages beside it) is for the dashboard's own screens. No notification, push, email or other outbound builder may
// read it: only the code that builds the live row, the lists themselves and the agent scope that nulls them may name them. A new reader is a decision for a review, not an accident: add it here with the reason.
func TestNoNotificationOrPushBuilderReadsAPersonsPendingSends(t *testing.T) {
	root, err := filepath.Abs("../../..") // coral-go
	require.NoError(t, err)
	allowed := map[string]string{
		"internal/server/routes/pending_sends.go":      "the list itself",
		"internal/server/routes/sessions_list.go":      "the live row's field",
		"internal/server/routes/sessions.go":           "the handler's field",
		"internal/server/routes/human_send_hold.go":    "records a message once it is typed; the held list",
		"internal/server/routes/agent_roster_scope.go": "nulls them for an agent's token",
	}
	needles := []string{"pending_sends", "pendingSendsOf", "pendingSends", ".sends.note", "h.sends."}
	var readers []string
	for _, dir := range []string{"internal", "pkg", "cmd"} {
		_ = filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			b, rerr := os.ReadFile(path)
			if rerr != nil {
				return nil
			}
			rel, _ := filepath.Rel(root, path)
			rel = filepath.ToSlash(rel)
			if _, ok := allowed[rel]; ok {
				return nil
			}
			for _, n := range needles {
				if strings.Contains(string(b), n) {
					readers = append(readers, rel+" names "+n)
					break
				}
			}
			return nil
		})
	}
	assert.Empty(t, readers, "only the row builder, the list and the agent scope may name a person's pending sends")
	// the allow-list is itself checked: each of its files exists, so a rename does not leave a stale pass
	for rel := range allowed {
		_, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
		assert.NoError(t, err, rel)
	}
}
