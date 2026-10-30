package routes

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A received file's metadata is shown to people here, so a name carrying a sign-in link is refused, however it is written: plainly, as a
// JSON escape, or nested in another parameter. Nothing is stored, and the token is not in the answer.
func TestAReceivedFileWhoseNameCarriesASignInLinkIsRefused(t *testing.T) {
	e := newArtifactEnv(t)
	e.open()
	data := []byte("plain notes\n")
	jsonEscapedEquals := string([]byte{92}) + "u003d"
	for label, name := range map[string]string{
		"plain":         "notes login_token=" + secretToken + ".md",
		"nested":        "x?next=%2F%3Flogin_token%253D" + secretToken,
		"a JSON escape": "notes login_token" + jsonEscapedEquals + secretToken,
	} {
		m := meta(data, "placeholder")
		raw := strings.Replace(string(mustJSON(t, m)), `"name":"placeholder"`, `"name":"`+name+`"`, 1)
		require.Contains(t, raw, secretToken, label)
		status, out := e.send("auth", relaySrc, "", rawFrame([]byte(raw), data))
		assert.Equal(t, 400, status, "%s: %v", label, out)
		assert.Equal(t, "sign_in_link", out["error"], label)
		assert.NotContains(t, out["message"], secretToken, label)
	}
	ents, _ := os.ReadDir(filepath.Join(e.dir, "artifacts", "objects"))
	assert.Empty(t, ents, "nothing refused is stored")
}

// The file's bytes are not looked at: a file that quotes the parameter, under a plain name, is stored byte for byte.
func TestAReceivedFileThatQuotesTheParameterIsStoredAsSent(t *testing.T) {
	e := newArtifactEnv(t)
	e.open()
	data := []byte("the log says login_token=" + secretToken + "\n")
	status, out := e.ok(data, "log.txt")
	require.Equal(t, 200, status, out)
	id := strings.TrimPrefix(sha256Of(data), "sha256:")
	got, err := os.ReadFile(filepath.Join(e.dir, "artifacts", "objects", id))
	require.NoError(t, err)
	assert.Equal(t, data, got)
}
