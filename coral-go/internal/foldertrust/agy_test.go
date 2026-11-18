package foldertrust

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19128: Antigravity (agy) records a trusted folder in ~/.gemini/antigravity-cli/settings.json, as an entry of its trustedWorkspaces list (its own trust prompt adds the same). Coral adds the one folder, keeps
// everything else of the file, and never touches a file that is not as agy writes it.
func TestTrustAgyAddsTheOneFolderToTrustedWorkspacesAndKeepsTheRest(t *testing.T) {
	r := newRig(t)
	cfg := filepath.Join(r.home, ".gemini", "antigravity-cli", "settings.json")
	require.NoError(t, os.MkdirAll(filepath.Dir(cfg), 0o700))
	require.NoError(t, os.WriteFile(cfg, []byte(`{"colorScheme":"dark","trustedWorkspaces":["/Users/x/other"]}`), 0o600))
	changed, err := TrustAgy(cfg, r.work)
	require.NoError(t, err)
	assert.True(t, changed)
	var got struct {
		Color string   `json:"colorScheme"`
		Trust []string `json:"trustedWorkspaces"`
	}
	b, _ := os.ReadFile(cfg)
	require.NoError(t, json.Unmarshal(b, &got))
	assert.Equal(t, "dark", got.Color)
	assert.Equal(t, []string{"/Users/x/other", r.work}, got.Trust, "the folder, and no other entry")
	again, err := TrustAgy(cfg, r.work)
	require.NoError(t, err)
	assert.False(t, again, "already there: nothing is written twice")

	// no list yet: made with the one folder
	require.NoError(t, os.WriteFile(cfg, []byte(`{"model":"x"}`), 0o600))
	_, err = TrustAgy(cfg, r.work)
	require.NoError(t, err)
	b, _ = os.ReadFile(cfg)
	assert.Contains(t, string(b), `"model": "x"`)
	// JSON writes a Windows path's backslashes escaped, so the raw text never holds the plain path: read the list back (#19663)
	require.NoError(t, json.Unmarshal(b, &got))
	assert.Equal(t, []string{r.work}, got.Trust, "a list made with the one folder")

	// a Windows-style path (backslashes) is written escaped and reads back whole, on every OS
	winPath := `C:\Users\x\work`
	require.NoError(t, os.WriteFile(cfg, []byte(`{"model":"x"}`), 0o600))
	_, err = TrustAgy(cfg, winPath)
	require.NoError(t, err)
	b, _ = os.ReadFile(cfg)
	got.Trust = nil
	require.NoError(t, json.Unmarshal(b, &got))
	assert.Equal(t, []string{winPath}, got.Trust)

	// a file that is not there: the CLI makes it at its first start, and its prompt stays until then
	_, err = TrustAgy(filepath.Join(r.home, "nothing.json"), r.work)
	assert.ErrorIs(t, err, ErrNoConfig)

	// a list that is not a list of folders is left as it is
	require.NoError(t, os.WriteFile(cfg, []byte(`{"trustedWorkspaces":"/x"}`), 0o600))
	before, _ := os.ReadFile(cfg)
	_, err = TrustAgy(cfg, r.work)
	assert.Error(t, err)
	after, _ := os.ReadFile(cfg)
	assert.Equal(t, string(before), string(after))
}
