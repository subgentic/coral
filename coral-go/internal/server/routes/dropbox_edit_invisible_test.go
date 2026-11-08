package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Security's SHOULD 8 on 085c4511b (#14777): an edit made in Dropbox, held for the Operator, is an object with its sidecar and NO upload record. No
// agent route reads it, and no list or search names it, the Operator's included: the bytes wait in artifacts/dropbox-held, beside the store.
func TestAHeldEditIsInvisibleToEveryReadRoute(t *testing.T) {
	rig := newArtifactRig(t)
	rig.uploadText("s1", "plan.md", "# the original")
	body := []byte("# held edit: secret-ish words only the Operator decides on")
	sum := sha256.Sum256(body)
	d := hex.EncodeToString(sum[:])
	held := filepath.Join(rig.coralDir, "artifacts", "dropbox-held") // where fetchEdit holds an edit (DropboxBackup.heldDir)
	require.NoError(t, os.MkdirAll(held, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(held, d), body, 0o600))

	for _, s := range []string{"s1", "s2"} {
		// UI Reviewer on #14777: the direct reads answer exactly 404 (not a refusal that could also mean "it exists"): the held digest is no artifact.
		for _, route := range []string{"/api/artifacts/" + d, "/api/artifacts/" + d + "/meta", "/api/artifacts/" + d + "/versions"} {
			code, out := rig.getAs(s, route)
			assert.Equal(t, http.StatusNotFound, code, "%s %s: %s", s, route, out)
			assert.NotContains(t, out, "held edit", "%s %s: never the bytes", s, route)
		}
		// The Operator's own routes refuse every agent the same way whatever the digest (403), so they tell nothing about it.
		for _, route := range []string{"/api/artifacts/" + d + "/readers", "/api/artifacts/" + d + "/thumbnail", "/api/artifacts/" + d + "/private", "/api/artifacts/resolve?ref=coral://artifacts/" + d} {
			code, out := rig.getAs(s, route)
			assert.Equal(t, http.StatusForbidden, code, "%s %s: %s", s, route, out)
			assert.NotContains(t, out, "held edit", "%s %s: never the bytes", s, route)
		}
		for _, route := range []string{"/api/artifacts", "/api/artifacts?q=plan", "/api/artifacts?q=secret"} {
			_, out := rig.getAs(s, route)
			assert.False(t, strings.Contains(out, d), "%s %s lists the held edit", s, route)
		}
	}
	for _, route := range []string{"/api/artifacts", "/api/artifacts?q=plan", "/api/artifacts?q=secret"} {
		_, out := rig.getAs("", route)
		assert.False(t, strings.Contains(out, d), "the dashboard's %s lists the held edit", route)
	}
	for _, route := range []string{"/api/artifacts/" + d, "/api/artifacts/" + d + "/meta", "/api/artifacts/" + d + "/versions"} {
		code, out := rig.getAs("", route)
		assert.Equal(t, http.StatusNotFound, code, "nor the Operator's own %s before the decision: %s", route, out)
		assert.NotContains(t, out, "held edit")
	}
}
